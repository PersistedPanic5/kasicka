import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LogoMark } from '@/components/Logo';
import { supabase } from '@/lib/supabase';
import { buildSpdPayload, czechIBAN } from '@/lib/czech-qr-payment';
import { translations, detectBrowserLanguage, type Language } from '@/lib/i18n';
import type { BillFile, BillItem, BillOffset, DebtBillView } from '@/types/database';

/**
 * The public, no-login debt share page — matches DebtorShare.dc.html.
 * Reachable at kasicka.eu/d/<token> (see architecture-v1.md), rendered as a
 * plain webpage for anyone who opens the link, app installed or not. Calls
 * the two SECURITY DEFINER functions from
 * supabase/migrations/0002_public_debt_share.sql — no auth session
 * involved, matching how architecture-v1.md describes this route.
 *
 * Renders a real Czech "QR Platba" payment code (lib/czech-qr-payment.ts)
 * when the target account has enough fields to build an IBAN from — falls
 * back to just the amount/description if a bank_code is missing (e.g. a
 * CASH account was picked as the target).
 *
 * Mobile QR UX: a phone showing this page can't scan its own screen, so the
 * real-world pattern is save-then-scan-from-gallery in the banking app. The
 * "Save / share QR" button below uses react-native-svg's web-only
 * `toDataURL()` to rasterize the on-screen QR to a PNG, then prefers the Web
 * Share API (`navigator.share({files})`) so a banking app that registers as
 * an image-share target can receive it directly.
 *
 * When Web Share isn't available (or fails/is cancelled), the fallback is
 * opening the PNG on its own page in a new tab — NOT a programmatic
 * `<a download>` click. That used to be the fallback, but a real debtor
 * testing this from Facebook Messenger's in-app browser on Android hit
 * exactly the failure mode that makes `<a download>` a bad fallback: the
 * button reported "saved" (the click ran with no error) but nothing
 * actually happened, because that in-app WebView silently no-ops
 * programmatic downloads. A plain `<img>` on its own page is about as
 * close to a browser-independent guarantee as this gets — press-and-hold
 * (or right-click) to save is supported basically everywhere, including
 * the restrictive in-app browsers where `navigator.share` and downloads
 * are both liable to silently do nothing. The new tab is opened
 * synchronously inside the click handler (before the async QR→PNG
 * conversion) specifically so popup blockers still recognize it as
 * user-gesture-triggered; if a popup blocker gets it anyway, this falls
 * back once more to navigating the current tab straight to the image.
 * Native (iOS/Android) doesn't have this SVG method, so the button only
 * renders on web — matching this app's PWA-first distribution.
 *
 * The plain-text account number below the QR is for anyone who'd rather (or
 * has to) type the payment in manually — same IBAN components, formatted the
 * familiar Czech way (prefix-number/bankCode).
 *
 * Localization: unlike the signed-in app (lib/language-context.tsx, backed
 * by `profile.language`), this page has no profile to read — the visitor
 * isn't signed in. It auto-detects from the browser (lib/i18n.ts
 * detectBrowserLanguage) and offers a manual EN/CS toggle next to the theme
 * toggle, remembered in this browser via localStorage so a debtor who
 * switches once doesn't have to again on the next link they open.
 */
const LANGUAGE_STORAGE_KEY = 'kasicka-debtshare-language';
type DebtShareView = DebtBillView;

// How often a Fio-linked debtor page asks the server to look at the bank
// feed. The server enforces Fio's own >=30 s/token limit no matter how many
// pages are open, so this only has to feel "live", not be exact.
const FIO_POLL_MS = 8000;

function formatCzechAccountNumber(
  prefix: string | null,
  number: string | null,
  bankCode: string | null
): string | null {
  if (!number || !bankCode) return null;
  return `${prefix ? `${prefix}-` : ''}${number}/${bankCode}`;
}

export default function DebtorSharePage() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { tokens } = useTheme();
  const [debt, setDebt] = useState<DebtShareView | null>(null);
  // `token` is whatever link was opened; `liveToken` is the debt that link currently stands for
  // (the same person's newest open debt once the old one was settled — see get_debt_bill).
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [fileError, setFileError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acctCopied, setAcctCopied] = useState(false);
  const [qrActionState, setQrActionState] = useState<'idle' | 'saved' | 'shared'>('idle');
  const qrRef = useRef<{ toDataURL?: (cb: (data: string) => void) => void } | null>(null);

  const [language, setLanguageState] = useState<Language>('en');
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      setLanguageState(stored === 'cs' || stored === 'en' ? stored : detectBrowserLanguage());
    } catch {
      setLanguageState(detectBrowserLanguage());
    }
  }, []);
  function setLanguage(lang: Language) {
    setLanguageState(lang);
    try {
      if (Platform.OS === 'web') window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // localStorage can be unavailable (private browsing) — the choice
      // just won't persist for next time, which is a fine fallback.
    }
  }
  const t = (path: string): string => {
    const value = path
      .split('.')
      .reduce<unknown>((node, key) => (node && typeof node === 'object' && key in node ? (node as Record<string, unknown>)[key] : undefined), translations[language]);
    return typeof value === 'string' ? value : path;
  };

  // `silent` = background refresh from the Fio poll: no spinner flash, and a
  // transient error keeps showing the last good data instead of "invalid link".
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      const { data, error } = await supabase.rpc('get_debt_bill', { p_token: token });
      if (error || !data) {
        if (!silent) setNotFound(true);
      } else {
        setDebt(data as DebtShareView);
      }
      if (!silent) setLoading(false);
    },
    [token]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live payment confirmation: while a Fio-linked debt is still open, ask the
  // check-fio-payments function (server-side throttled + does the matching /
  // settling) and then re-read the debt. Stops as soon as it's SETTLED.
  const liveToken = debt?.token ?? token;
  const watching = !!debt && debt.fio_enabled && (debt.status === 'OUTSTANDING' || debt.status === 'CLAIMED_PAID');
  useEffect(() => {
    if (!watching) return;
    const id = setInterval(async () => {
      await supabase.functions.invoke('check-fio-payments', { body: { share_token: liveToken } }).catch(() => null);
      load(true);
    }, FIO_POLL_MS);
    return () => clearInterval(id);
  }, [watching, liveToken, load]);

  async function markPaid() {
    await supabase.rpc('claim_debt_paid', { p_token: liveToken });
    load();
  }

  async function undo() {
    await supabase.rpc('undo_claim_debt_paid', { p_token: liveToken });
    load();
  }

  // Attachments: the private bucket is opened through the debt-file function (short-lived signed link).
  async function signedUrl(f: BillFile): Promise<string | null> {
    const { data, error } = await supabase.functions.invoke('debt-file', { body: { token: liveToken, file_id: f.id } });
    return error || !data?.url ? null : (data.url as string);
  }
  async function openFile(f: BillFile) {
    setFileError(false);
    const w = Platform.OS === 'web' ? window.open('', '_blank') : null; // opened inside the click, before the await
    const url = await signedUrl(f);
    if (!url) {
      w?.close();
      return setFileError(true);
    }
    if (w) w.location.href = url;
    else if (Platform.OS === 'web') window.location.href = url;
  }
  const allFiles: BillFile[] = [];
  if (debt && debt.status !== 'MERGED') {
    const seen = new Set<string>();
    const add = (list: BillFile[]) => list.forEach((f) => !seen.has(f.id) && (seen.add(f.id), allFiles.push(f)));
    add(debt.files);
    debt.offsets.forEach((o) => add(o.files));
    debt.items.forEach((i) => {
      add(i.files);
      i.offsets.forEach((o) => add(o.files));
    });
  }
  useEffect(() => {
    if (!filesOpen) return;
    allFiles.filter((f) => !fileUrls[f.id]).forEach(async (f) => {
      const url = await signedUrl(f);
      if (url) setFileUrls((prev) => ({ ...prev, [f.id]: url }));
      else setFileError(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesOpen, debt]);

  function handleSaveOrShareQR() {
    if (Platform.OS !== 'web' || !qrRef.current?.toDataURL) return;

    // Opened synchronously, still inside the click handler — see the doc
    // comment above. Filling it in happens later, once the async
    // SVG→PNG conversion finishes below.
    const fallbackWindow = window.open('', '_blank');

    qrRef.current.toDataURL(async (base64: string) => {
      const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
      const dataUrl = `data:image/png;base64,${base64}`;

      try {
        const byteChars = atob(base64);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
        const byteArray = new Uint8Array(byteNumbers);
        const file = new File([byteArray], 'kasicka-payment-qr.png', { type: 'image/png' });

        if (nav?.canShare?.({ files: [file] })) {
          fallbackWindow?.close();
          await nav.share({
            files: [file],
            title: t('debtShare.shareTitle'),
            text: t('debtShare.shareText'),
          });
          setQrActionState('shared');
          setTimeout(() => setQrActionState('idle'), 2000);
          return;
        }
      } catch {
        // AbortError (user cancelled the share sheet) or anything else —
        // fall through to the guaranteed-to-work path below.
      }

      if (fallbackWindow) {
        fallbackWindow.document.write(
          `<!doctype html><title>${t('debtShare.shareTitle')}</title>` +
            '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;">' +
            `<img src="${dataUrl}" alt="QR" style="max-width:92vw;max-height:92vh;height:auto;border-radius:12px;" />` +
            '</body>'
        );
        fallbackWindow.document.close();
      } else {
        // Popup blocked — last resort, navigate this tab straight to the
        // image. The user can still save it from there; Back returns here.
        window.location.href = dataUrl;
      }
      setQrActionState('saved');
      setTimeout(() => setQrActionState('idle'), 2000);
    });
  }

  async function copyAccountNumber(accountText: string) {
    try {
      await navigator.clipboard.writeText(accountText);
      setAcctCopied(true);
      setTimeout(() => setAcctCopied(false), 2000);
    } catch {
      // clipboard can be unavailable (older browser, non-https) — the text
      // is already selectable on screen as a fallback.
    }
  }

  const qrPayload =
    debt && debt.status !== 'MERGED' && debt.target_bank_code && debt.target_account_number && debt.amount != null
      ? buildSpdPayload({
          iban: czechIBAN(debt.target_bank_code, debt.target_account_number, debt.target_account_prefix),
          amount: debt.amount,
          message: debt.description ?? undefined,
          variableSymbol: debt.variable_symbol ?? undefined,
        })
      : null;

  const accountText = debt
    ? formatCzechAccountNumber(debt.target_account_prefix, debt.target_account_number, debt.target_bank_code)
    : null;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      {/* Centered, capped-width column — same reasoning as the app shell's
          fix for content sitting pinned to one side on a wide desktop
          browser window (this page has no nav chrome of its own, so it
          needs its own copy of that fix rather than inheriting one). */}
      <View style={styles.pageInner}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <LogoMark size={15} color={tokens.accent} holeColor={tokens.bg} />
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 11, letterSpacing: 1 }}>
            KASIČKA
          </Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.langSwitch, { borderColor: tokens.border }]}>
            {(['en', 'cs'] as Language[]).map((lang) => (
              <Pressable
                key={lang}
                onPress={() => setLanguage(lang)}
                style={[
                  styles.langBtn,
                  { backgroundColor: language === lang ? tokens.accent : 'transparent' },
                ]}
              >
                <Text
                  style={{
                    color: language === lang ? tokens.accentText : tokens.textMuted,
                    fontFamily: fontFamily.bold,
                    fontSize: 11,
                  }}
                >
                  {lang.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
          <ThemeToggle size={34} labels={{ toLight: t('common.switchToLight'), toDark: t('common.switchToDark') }} />
        </View>
      </View>

      {loading && <ActivityIndicator color={tokens.accent} style={{ marginTop: 60 }} />}

      {!loading && notFound && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, textAlign: 'center', marginTop: 60 }}>
          {t('debtShare.linkInvalid')}
        </Text>
      )}

      {/* A superseded link (folded into another debt via merge — see
          supabase/migrations/0011_debts_merge_supersede.sql) used to land
          on the same "invalid link" message as an unknown token, which
          reads like a mistake or a broken link rather than what actually
          happened. This tells the visitor plainly what happened and hands
          them the current link, instead of a dead end. */}
      {!loading && debt && debt.status === 'MERGED' && (
        <View style={styles.body}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15, marginBottom: 6, textAlign: 'center' }}>
            {t('debtShare.mergedTitle')}
          </Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, textAlign: 'center', marginBottom: 18 }}>
            {debt.merged_into_token ? t('debtShare.mergedBody') : t('debtShare.mergedGone')}
          </Text>
          {debt.merged_into_token && (
            // StyleSheet.flatten, not a raw style array — expo-router's
            // `asChild` clones this Pressable to attach its own press
            // handling, and an unflattened array style here crashes at
            // hydration on web ("Failed to set an indexed property...
            // CSSStyleDeclaration"), which took the whole page down to a
            // blank white screen (confirmed live: this exact "Open the
            // current link" button, on the one branch — a MERGED debt —
            // that actually renders a Link/asChild on this page). Same
            // fix already applied to the landing page and the mobile
            // header elsewhere in this app.
            <Link href={`/d/${debt.merged_into_token}`} asChild>
              <Pressable style={StyleSheet.flatten([styles.primaryBtn, { backgroundColor: tokens.accent }])}>
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
                  {t('debtShare.mergedOpenNew')}
                </Text>
              </Pressable>
            </Link>
          )}
        </View>
      )}

      {!loading && debt && debt.status !== 'MERGED' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
          <View style={[styles.pill, { backgroundColor: tokens.cardAlt }]}>
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 13.5, textAlign: 'center' }}>
              {'Pavel '}
              {t('debtShare.owesFor')}
            </Text>
          </View>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 15, marginBottom: 8, textAlign: 'center' }}>
            {debt.description}
          </Text>
          {debt.continued && (
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, textAlign: 'center', marginBottom: 8 }}>
              {t('debtShare.continuedNote')}
            </Text>
          )}
          <Text style={{ color: tokens.text, fontFamily: fontFamily.regular, fontSize: 34, lineHeight: 38 }}>
            {debt.amount}
            <Text style={{ color: tokens.textMuted, fontSize: 15, fontFamily: fontFamily.medium }}> {t('common.czk')}</Text>
          </Text>

          {debt.status === 'OUTSTANDING' && qrPayload && (
            <View style={[styles.qrBox, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
              <View style={styles.qrWhite}>
                <QRCode value={qrPayload} size={118} getRef={(ref) => (qrRef.current = ref as any)} />
              </View>
              <Text
                style={{
                  color: tokens.textMuted,
                  fontFamily: fontFamily.medium,
                  fontSize: 11,
                  marginTop: 6,
                  textAlign: 'center',
                }}
              >
                {t('debtShare.scanWithBankingApp')}
              </Text>

              {Platform.OS === 'web' && (
                <>
                  <Pressable
                    onPress={handleSaveOrShareQR}
                    style={[styles.qrActionBtn, { backgroundColor: tokens.bg, borderColor: tokens.border }]}
                  >
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                      {qrActionState === 'shared'
                        ? t('debtShare.sharedCheck')
                        : qrActionState === 'saved'
                          ? t('debtShare.savedCheck')
                          : t('debtShare.saveShareQr')}
                    </Text>
                  </Pressable>
                  <Text
                    style={{
                      color: tokens.textMuted,
                      fontFamily: fontFamily.regular,
                      fontSize: 10,
                      marginTop: 4,
                      textAlign: 'center',
                      opacity: 0.8,
                    }}
                  >
                    {t('debtShare.cantScanOwnScreen')}
                  </Text>
                </>
              )}

              {accountText && (
                <View style={[styles.acctBox, { borderTopColor: tokens.border }]}>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 10.5 }}>
                    {t('debtShare.orEnterManually')}
                  </Text>
                  <Pressable onPress={() => copyAccountNumber(accountText)}>
                    <Text
                      selectable
                      style={{
                        color: tokens.text,
                        fontFamily: fontFamily.bold,
                        fontSize: 14,
                        marginTop: 3,
                        letterSpacing: 0.3,
                      }}
                    >
                      {accountText}
                    </Text>
                  </Pressable>
                  <Text
                    style={{
                      color: tokens.accent,
                      fontFamily: fontFamily.medium,
                      fontSize: 10.5,
                      marginTop: 3,
                    }}
                  >
                    {acctCopied ? t('debtShare.copiedCheck') : t('debtShare.tapToCopy')}
                  </Text>
                  {debt.variable_symbol && (
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5, marginTop: 6 }} selectable>
                      {t('debtShare.variableSymbol')}: {debt.variable_symbol}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          {debt.status === 'OUTSTANDING' && (
            <>
              <Text
                style={{
                  color: tokens.textMuted,
                  fontFamily: fontFamily.medium,
                  fontSize: 13,
                  textAlign: 'center',
                  marginTop: 16,
                  marginBottom: 8,
                }}
              >
                {debt.fio_enabled ? t('debtShare.ctaAfterPayAuto') : t('debtShare.ctaAfterPay')}
              </Text>
              <Pressable onPress={markPaid} style={[styles.primaryBtn, { backgroundColor: tokens.accent }]}>
                <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
                  {t('debtShare.iPaidThis')}
                </Text>
              </Pressable>
              {debt.fio_enabled && (
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.regular, fontSize: 11, textAlign: 'center', marginTop: 8 }}>
                  {t('debtShare.checkingAutomatically')}
                </Text>
              )}
            </>
          )}

          {debt.status === 'CLAIMED_PAID' && (
            <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 13, marginBottom: 3 }}>
                {t('debtShare.markedAsPaid')}
              </Text>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11.5, opacity: 0.85 }}>
                {debt.fio_enabled ? t('debtShare.checkingAutomatically') : t('debtShare.willConfirm')}
              </Text>
              <Pressable onPress={undo}>
                <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 6, textDecorationLine: 'underline', opacity: 0.7 }}>
                  {t('debtShare.undo')}
                </Text>
              </Pressable>
            </View>
          )}

          {debt.status === 'SETTLED' && (
            <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 14 }}>
                {debt.settled_automatically ? t('debtShare.paymentReceived') : t('debtShare.settledThankYou')}
              </Text>
              {debt.settled_automatically && (
                <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 3, opacity: 0.85 }}>
                  {t('debtShare.paymentReceivedBody')}
                </Text>
              )}
            </View>
          )}

          {/* What the amount is made of: details, reciprocated expenses, itemised bill lines. */}
          {(debt.details || debt.offsets.length > 0 || debt.items.length > 0 || debt.files.length > 0) && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: tokens.text }]}>{t('debtShare.expenses')}</Text>
              {debt.items.map((it, i) => (
                <ExpenseBlock key={i} title={it.title} amount={it.amount} base={it.base_amount} date={it.date} details={it.details} offsets={it.offsets} files={it.files} onOpen={openFile} t={t} tokens={tokens} />
              ))}
              {debt.items.length === 0 && (
                <ExpenseBlock title={debt.description} amount={debt.amount} base={debt.base_amount} date={debt.date} details={debt.details} offsets={debt.offsets} files={debt.files} onOpen={openFile} t={t} tokens={tokens} plain />
              )}
              {debt.items.length > 0 && (debt.details || debt.offsets.length > 0 || debt.files.length > 0) && (
                <ExpenseBlock title={t('debtShare.total')} amount={debt.amount} base={debt.base_amount} date={debt.date} details={debt.details} offsets={debt.offsets} files={debt.files} onOpen={openFile} t={t} tokens={tokens} plain />
              )}
              {fileError && <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 6 }}>{t('debtShare.fileError')}</Text>}
            </View>
          )}

          {/* All files in one collapsible place, with previews. */}
          {allFiles.length > 0 && (
            <View style={styles.section}>
              <Pressable onPress={() => setFilesOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: filesOpen }} style={styles.collapseHead}>
                <Text style={[styles.sectionTitle, { color: tokens.text, marginBottom: 0 }]}>
                  {t('debtShare.attachments')} ({allFiles.length})
                </Text>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.bold, fontSize: 14 }}>{filesOpen ? '−' : '+'}</Text>
              </Pressable>
              {filesOpen &&
                allFiles.map((f) => (
                  <View key={f.id} style={[styles.fileCard, { borderColor: tokens.border, backgroundColor: tokens.cardAlt }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text numberOfLines={1} style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>{f.name}</Text>
                      <Pressable onPress={() => openFile(f)} hitSlop={8}>
                        <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 12.5 }}>{t('debtShare.viewFile')}</Text>
                      </Pressable>
                    </View>
                    {Platform.OS === 'web' && fileUrls[f.id] && (/pdf/i.test(f.mime ?? f.name)
                      ? createElement('iframe', { src: fileUrls[f.id], title: f.name, style: { width: '100%', height: 360, border: 0, borderRadius: 8, marginTop: 8, background: '#fff' } })
                      : createElement('img', { src: fileUrls[f.id], alt: f.name, style: { width: '100%', height: 'auto', borderRadius: 8, marginTop: 8 } }))}
                  </View>
                ))}
            </View>
          )}

          {/* Earlier debts of this person, already settled — overview only. */}
          {debt.past.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: tokens.text }]}>{t('debtShare.pastTitle')}</Text>
              {debt.past.map((p, i) => (
                <View key={i} style={[styles.pastRow, { borderColor: tokens.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>{p.title}</Text>
                    {p.paid_on && (
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>
                        {t('debtShare.paidOn').replace('{date}', p.paid_on)}
                      </Text>
                    )}
                  </View>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13, fontVariant: ['tabular-nums'] }}>
                    {p.amount} {t('common.czk')}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
      </View>
    </SafeAreaView>
  );
}

type Tk = ReturnType<typeof useTheme>['tokens'];

/** One expense: title + amount (original → payable when reciprocated expenses exist), details, reciprocated lines, file chips. */
function ExpenseBlock(p: {
  title: string;
  amount: number;
  base: number | null;
  date: string;
  details: string | null;
  offsets: BillOffset[];
  files: BillFile[];
  onOpen: (f: BillFile) => void;
  t: (k: string) => string;
  tokens: Tk;
  plain?: boolean;
}) {
  const { tokens, t } = p;
  const chip = (f: BillFile) => (
    <Pressable key={f.id} onPress={() => p.onOpen(f)} style={[styles.fileChip, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
      <Text numberOfLines={1} style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12 }}>{f.name}</Text>
    </Pressable>
  );
  return (
    <View style={[styles.expense, { borderColor: tokens.border }]}>
      {!p.plain && (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}>
          <Text style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13.5 }}>{p.title}</Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13.5, fontVariant: ['tabular-nums'] }}>
            {p.base != null ? `${p.base} → ${p.amount}` : p.amount} {t('common.czk')}
          </Text>
        </View>
      )}
      {!p.plain && <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 1 }}>{p.date}</Text>}
      {p.plain && p.base != null && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
          {t('debtShare.total')}: {p.base} {t('common.czk')}
        </Text>
      )}
      {!!p.details && <Text selectable style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 19, marginTop: 6 }}>{p.details}</Text>}
      {p.offsets.map((o, i) => (
        <View key={i} style={{ marginTop: 6 }}>
          <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
            − {o.amount} {t('common.czk')} · {t('debtShare.youPaid')}
            {o.note ? `: ${o.note}` : ''}
          </Text>
          {o.files.length > 0 && <View style={styles.chipRow}>{o.files.map(chip)}</View>}
        </View>
      ))}
      {p.plain && p.base != null && (
        <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13, marginTop: 6 }}>
          {t('debtShare.toPay')}: {p.amount} {t('common.czk')}
        </Text>
      )}
      {p.files.length > 0 && <View style={styles.chipRow}>{p.files.map(chip)}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { width: '100%', marginTop: 24 },
  sectionTitle: { fontFamily: fontFamily.extrabold, fontSize: 15, marginBottom: 8 },
  expense: { borderTopWidth: 1, paddingVertical: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  fileChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 34, justifyContent: 'center', maxWidth: '100%' },
  collapseHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  fileCard: { borderWidth: 1, borderRadius: 12, padding: 10, marginTop: 8 },
  pastRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, paddingVertical: 9 },
  screen: { flex: 1, paddingHorizontal: 22, paddingTop: 14, paddingBottom: 14, alignItems: 'center' },
  pageInner: { flex: 1, width: '100%', maxWidth: 440 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  langSwitch: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  langBtn: { paddingHorizontal: 9, paddingVertical: 6 },
  // Used as a ScrollView's contentContainerStyle — flexGrow (not flex) so
  // content taller than the viewport scrolls instead of clipping off the
  // bottom. The primary button now sits directly under the QR box (CTA
  // text above it) rather than being pushed to the page bottom.
  //
  // Every element on this screen was deliberately sized/spaced down (see
  // each inline style above) so the WHOLE page — pill through the "I
  // paid this" button — fits inside a single small-phone viewport without
  // scrolling in the common case; that's the actual fix for "the user
  // won't know to scroll". This ScrollView wrapper stays only as a safety
  // net for cases tight sizing can't guarantee: a very long debt
  // description wrapping to extra lines, a very short/landscape or
  // heavily-zoomed viewport, larger system font sizes, etc. Removing it
  // (going back to a plain `flex: 1` View) would silently clip those edge
  // cases off-screen with no way to reach them — the exact bug this
  // replaced — so it's kept even though it should rarely if ever trigger.
  body: { flexGrow: 1, alignItems: 'center', paddingBottom: 12 },
  pill: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 999, marginBottom: 8 },
  primaryBtn: { width: '100%', paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  claimedBox: { width: '100%', paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  qrBox: { alignItems: 'center', padding: 12, borderRadius: 16, borderWidth: 1, marginTop: 10, width: '100%' },
  qrWhite: { backgroundColor: '#ffffff', padding: 8, borderRadius: 10 },
  qrActionBtn: {
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
  },
  acctBox: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    width: '100%',
    alignItems: 'center',
  },
});
