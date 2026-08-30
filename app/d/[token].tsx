import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
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
 * an image-share target can receive it directly, falling back to a forced
 * download when Web Share (or file sharing specifically) isn't supported.
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

    qrRef.current.toDataURL(async (base64: string) => {
      const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;

      try {
        const byteChars = atob(base64);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
        const byteArray = new Uint8Array(byteNumbers);
        const file = new File([byteArray], 'kasicka-payment-qr.png', { type: 'image/png' });

        if (nav?.canShare?.({ files: [file] })) {
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
        // fall through to a plain download so the user still gets the image.
      }

      const link = document.createElement('a');
      link.href = `data:image/png;base64,${base64}`;
      link.download = 'kasicka-payment-qr.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
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
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 12, letterSpacing: 1 }}>
          KASIČKA
        </Text>
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
        <View style={styles.body}>
          <View style={[styles.avatar, { backgroundColor: tokens.cardAlt }]}>
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 19 }}>P</Text>
          </View>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 15, marginBottom: 6 }}>
            {'Pavel '}
            {t('debtShare.owesFor')}
          </Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 17, marginBottom: 18 }}>
            {debt.description}
          </Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.regular, fontSize: 48 }}>
            {debt.amount}
            <Text style={{ color: tokens.textMuted, fontSize: 20, fontFamily: fontFamily.medium }}> {t('common.czk')}</Text>
          </Text>

          {debt.status === 'OUTSTANDING' && qrPayload && (
            <View style={[styles.qrBox, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
              <View style={styles.qrWhite}>
                <QRCode value={qrPayload} size={168} getRef={(ref) => (qrRef.current = ref as any)} />
              </View>
              <Text
                style={{
                  color: tokens.textMuted,
                  fontFamily: fontFamily.medium,
                  fontSize: 12,
                  marginTop: 10,
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
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>
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
                      fontSize: 11,
                      marginTop: 8,
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
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11 }}>
                    {t('debtShare.orEnterManually')}
                  </Text>
                  <Pressable onPress={() => copyAccountNumber(accountText)}>
                    <Text
                      selectable
                      style={{
                        color: tokens.text,
                        fontFamily: fontFamily.bold,
                        fontSize: 15,
                        marginTop: 4,
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
                      fontSize: 11,
                      marginTop: 4,
                    }}
                  >
                    {acctCopied ? t('debtShare.copiedCheck') : t('debtShare.tapToCopy')}
                  </Text>
                </View>
              )}
            </View>
          )}

          <View style={{ flex: 1 }} />

          {debt.status === 'OUTSTANDING' && (
            <Pressable onPress={markPaid} style={[styles.primaryBtn, { backgroundColor: tokens.accent }]}>
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 16 }}>
                {t('debtShare.iPaidThis')}
              </Text>
            </Pressable>
          )}

          {debt.status === 'CLAIMED_PAID' && (
            <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 14, marginBottom: 4 }}>
                {t('debtShare.markedAsPaid')}
              </Text>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 12.5, opacity: 0.85 }}>
                {t('debtShare.willConfirm')}
              </Text>
              <Pressable onPress={undo}>
                <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 8, textDecorationLine: 'underline', opacity: 0.7 }}>
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
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 22, paddingBottom: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  langSwitch: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  langBtn: { paddingHorizontal: 9, paddingVertical: 6 },
  body: { flex: 1, alignItems: 'center' },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  primaryBtn: { width: '100%', paddingVertical: 17, borderRadius: 16, alignItems: 'center' },
  claimedBox: { width: '100%', paddingVertical: 16, borderRadius: 16, alignItems: 'center' },
  qrBox: { alignItems: 'center', padding: 18, borderRadius: 18, borderWidth: 1, marginTop: 22, width: '100%' },
  qrWhite: { backgroundColor: '#ffffff', padding: 12, borderRadius: 10 },
  qrActionBtn: {
    marginTop: 14,
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
  },
  acctBox: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    width: '100%',
    alignItems: 'center',
  },
});
