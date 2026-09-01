import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
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
type DebtShareView = {
  description: string;
  amount: number;
  status: 'OUTSTANDING' | 'CLAIMED_PAID' | 'SETTLED';
  target_account_prefix: string | null;
  target_account_number: string | null;
  target_bank_code: string | null;
};

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

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_debt_by_share_token', { p_token: token });
    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      setNotFound(true);
    } else {
      setDebt((Array.isArray(data) ? data[0] : data) as DebtShareView);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function markPaid() {
    await supabase.rpc('claim_debt_paid', { p_token: token });
    load();
  }

  async function undo() {
    await supabase.rpc('undo_claim_debt_paid', { p_token: token });
    load();
  }

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
    debt && debt.target_bank_code && debt.target_account_number
      ? buildSpdPayload({
          iban: czechIBAN(debt.target_bank_code, debt.target_account_number, debt.target_account_prefix),
          amount: debt.amount,
          message: debt.description,
        })
      : null;

  const accountText = debt
    ? formatCzechAccountNumber(debt.target_account_prefix, debt.target_account_number, debt.target_bank_code)
    : null;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
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

      {!loading && debt && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
          <View style={[styles.avatar, { backgroundColor: tokens.cardAlt }]}>
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 15 }}>P</Text>
          </View>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13, marginBottom: 3 }}>
            {'Pavel '}
            {t('debtShare.owesFor')}
          </Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15, marginBottom: 8 }}>
            {debt.description}
          </Text>
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
                </View>
              )}
            </View>
          )}

          <View style={{ flex: 1, minHeight: 10 }} />

          {debt.status === 'OUTSTANDING' && (
            <Pressable onPress={markPaid} style={[styles.primaryBtn, { backgroundColor: tokens.accent }]}>
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
                {t('debtShare.iPaidThis')}
              </Text>
            </Pressable>
          )}

          {debt.status === 'CLAIMED_PAID' && (
            <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 13, marginBottom: 3 }}>
                {t('debtShare.markedAsPaid')}
              </Text>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11.5, opacity: 0.85 }}>
                {t('debtShare.willConfirm')}
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
                {t('debtShare.settledThankYou')}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 22, paddingTop: 14, paddingBottom: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  langSwitch: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  langBtn: { paddingHorizontal: 9, paddingVertical: 6 },
  // Used as a ScrollView's contentContainerStyle — flexGrow (not flex) so
  // short content still fills the viewport height (letting the flex:1
  // spacer below push the primary button to the bottom), while content
  // taller than the viewport scrolls instead of clipping off the bottom.
  //
  // Every element on this screen was deliberately sized/spaced down (see
  // each inline style above) so the WHOLE page — avatar through the "I
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
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
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
