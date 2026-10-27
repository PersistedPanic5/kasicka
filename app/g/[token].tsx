import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import type { GroupShareView } from '@/types/database';

/**
 * Public, no-login page for a bill split between several people with ONE link
 * (supabase/migrations/0019_group_bills.sql). Reachable at kasicka.eu/g/<token>.
 *
 *  ONE_QR      one shared QR (amount = everyone's equal share, group variable
 *              symbol). After paying, each person taps their name and confirms
 *              "I paid" — the same claim_debt_paid as on a personal link. With a
 *              Fio account the server then matches the incoming payment to the
 *              oldest tapped person and settles them.
 *  PER_PERSON  a list of names and amounts; picking yours opens your own
 *              /d/<token> page (own QR, own symbol, same live confirmation).
 *
 * Language and theme behave like app/d/[token].tsx (same remembered choice).
 */
const LANGUAGE_STORAGE_KEY = 'kasicka-debtshare-language';
const FIO_POLL_MS = 8000;
type Member = GroupShareView['members'][number];

export default function GroupSharePage() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { tokens } = useTheme();
  const router = useRouter();
  const [group, setGroup] = useState<GroupShareView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [picked, setPicked] = useState<string | null>(null); // member token awaiting "I paid"
  const [qrState, setQrState] = useState<'idle' | 'saved' | 'shared'>('idle');
  const [copied, setCopied] = useState(false);
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
      // not remembered next time — fine
    }
  }
  const t = (path: string): string => {
    const value = path
      .split('.')
      .reduce<unknown>((node, key) => (node && typeof node === 'object' && key in node ? (node as Record<string, unknown>)[key] : undefined), translations[language]);
    return typeof value === 'string' ? value : path;
  };

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      const { data, error } = await supabase.rpc('get_group_by_share_token', { p_token: token });
      if (error || !data) {
        if (!silent) setNotFound(true);
      } else {
        setGroup(data as GroupShareView);
      }
      if (!silent) setLoading(false);
    },
    [token]
  );
  useEffect(() => {
    load();
  }, [load]);

  // Live confirmation while somebody is still open and the account is Fio-linked.
  const watching = !!group && group.fio_enabled && group.members.some((m) => m.status === 'OUTSTANDING' || m.status === 'CLAIMED_PAID');
  useEffect(() => {
    if (!watching) return;
    const id = setInterval(async () => {
      await supabase.functions.invoke('check-fio-payments', { body: { group_token: token } }).catch(() => null);
      load(true);
    }, FIO_POLL_MS);
    return () => clearInterval(id);
  }, [watching, token, load]);

  async function claim(m: Member, undo = false) {
    await supabase.rpc(undo ? 'undo_claim_debt_paid' : 'claim_debt_paid', { p_token: m.token });
    setPicked(null);
    load(true);
  }

  function saveOrShareQr() {
    if (Platform.OS !== 'web' || !qrRef.current?.toDataURL) return;
    const fallback = window.open('', '_blank'); // opened inside the click so popup blockers allow it
    qrRef.current.toDataURL(async (base64: string) => {
      const dataUrl = `data:image/png;base64,${base64}`;
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'kasicka-payment-qr.png', { type: 'image/png' });
        const nav = navigator as any;
        if (nav?.canShare?.({ files: [file] })) {
          fallback?.close();
          await nav.share({ files: [file], title: t('debtShare.shareTitle'), text: t('debtShare.shareText') });
          setQrState('shared');
          setTimeout(() => setQrState('idle'), 2000);
          return;
        }
      } catch {
        // cancelled or unsupported -> image page below
      }
      if (fallback) {
        fallback.document.write(
          `<!doctype html><title>${t('debtShare.shareTitle')}</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;"><img src="${dataUrl}" alt="QR" style="max-width:92vw;max-height:92vh;border-radius:12px;" /></body>`
        );
        fallback.document.close();
      } else {
        window.location.href = dataUrl;
      }
      setQrState('saved');
      setTimeout(() => setQrState('idle'), 2000);
    });
  }

  const g = group;
  const account = g && g.target_account_number && g.target_bank_code
    ? `${g.target_account_prefix ? `${g.target_account_prefix}-` : ''}${g.target_account_number}/${g.target_bank_code}`
    : null;
  const qrPayload =
    g && g.mode === 'ONE_QR' && g.per_person != null && g.target_bank_code && g.target_account_number
      ? buildSpdPayload({
          iban: czechIBAN(g.target_bank_code, g.target_account_number, g.target_account_prefix),
          amount: g.per_person,
          message: g.description,
          variableSymbol: g.variable_symbol ?? undefined,
        })
      : null;
  const paid = g ? g.members.filter((m) => m.status === 'SETTLED').length : 0;
  const total = g?.members.length ?? 0;

  async function copyAccount() {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the text is selectable on screen
    }
  }

  function renderMember(m: Member) {
    const done = m.status === 'SETTLED';
    const claimed = m.status === 'CLAIMED_PAID';
    const open = picked === m.token;
    const label = done ? (m.automatic ? t('groupShare.received') : t('groupShare.settled')) : claimed ? t('groupShare.claimed') : null;
    const onPress = () => {
      if (done) return;
      if (g?.mode === 'PER_PERSON') router.push(`/d/${m.token}`);
      else setPicked(open ? null : m.token);
    };
    return (
      <View key={m.token} style={[styles.member, { backgroundColor: done ? tokens.greenBg : tokens.cardAlt, borderColor: tokens.border }]}>
        <Pressable onPress={onPress} disabled={done} style={styles.memberRow}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: done ? tokens.greenFg : tokens.text, fontFamily: fontFamily.bold, fontSize: 15 }}>{m.name}</Text>
            {label && <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>{label}</Text>}
          </View>
          {g?.mode === 'PER_PERSON' && (
            <Text style={{ color: done ? tokens.greenFg : tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
              {m.amount} {t('common.czk')}
            </Text>
          )}
          {g?.mode === 'PER_PERSON' && !done && <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 18, marginLeft: 8 }}>›</Text>}
        </Pressable>
        {g?.mode === 'ONE_QR' && claimed && (
          <Pressable onPress={() => claim(m, true)}>
            <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11, textDecorationLine: 'underline', opacity: 0.8 }}>{t('debtShare.undo')}</Text>
          </Pressable>
        )}
        {g?.mode === 'ONE_QR' && open && (
          <View style={{ gap: 8, marginTop: 10 }}>
            <Pressable onPress={() => claim(m)} style={[styles.primaryBtn, { backgroundColor: tokens.accent }]}>
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
                {t('groupShare.confirmAs')} {m.name}
              </Text>
            </Pressable>
            <Pressable onPress={() => setPicked(null)} style={{ alignItems: 'center' }}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>{t('groupShare.cancel')}</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.pageInner}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <LogoMark size={15} color={tokens.accent} holeColor={tokens.bg} />
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 11, letterSpacing: 1 }}>KASIČKA</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={[styles.langSwitch, { borderColor: tokens.border }]}>
              {(['en', 'cs'] as Language[]).map((lang) => (
                <Pressable key={lang} onPress={() => setLanguage(lang)} style={[styles.langBtn, { backgroundColor: language === lang ? tokens.accent : 'transparent' }]}>
                  <Text style={{ color: language === lang ? tokens.accentText : tokens.textMuted, fontFamily: fontFamily.bold, fontSize: 11 }}>{lang.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
            <ThemeToggle size={34} labels={{ toLight: t('common.switchToLight'), toDark: t('common.switchToDark') }} />
          </View>
        </View>

        {loading && <ActivityIndicator color={tokens.accent} style={{ marginTop: 60 }} />}
        {!loading && notFound && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, textAlign: 'center', marginTop: 60 }}>{t('debtShare.linkInvalid')}</Text>
        )}

        {!loading && g && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
            <View style={[styles.pill, { backgroundColor: tokens.cardAlt }]}>
              <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 13.5, textAlign: 'center' }}>{t('groupShare.header')}</Text>
            </View>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 15, marginBottom: 6, textAlign: 'center' }}>{g.description}</Text>
            {g.mode === 'ONE_QR' && g.per_person != null && (
              <>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>{t('groupShare.each')}</Text>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.regular, fontSize: 34, lineHeight: 38 }}>
                  {g.per_person}
                  <Text style={{ color: tokens.textMuted, fontSize: 15, fontFamily: fontFamily.medium }}> {t('common.czk')}</Text>
                </Text>
              </>
            )}

            {qrPayload && (
              <View style={[styles.qrBox, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
                <View style={styles.qrWhite}>
                  <QRCode value={qrPayload} size={150} getRef={(ref) => (qrRef.current = ref as any)} />
                </View>
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 6, textAlign: 'center' }}>{t('debtShare.scanWithBankingApp')}</Text>
                {Platform.OS === 'web' && (
                  <Pressable onPress={saveOrShareQr} style={[styles.qrActionBtn, { backgroundColor: tokens.bg, borderColor: tokens.border }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                      {qrState === 'shared' ? t('debtShare.sharedCheck') : qrState === 'saved' ? t('debtShare.savedCheck') : t('debtShare.saveShareQr')}
                    </Text>
                  </Pressable>
                )}
                {account && (
                  <View style={[styles.acctBox, { borderTopColor: tokens.border }]}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 10.5 }}>{t('debtShare.orEnterManually')}</Text>
                    <Pressable onPress={copyAccount}>
                      <Text selectable style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14, marginTop: 3, letterSpacing: 0.3 }}>{account}</Text>
                    </Pressable>
                    <Text style={{ color: tokens.accent, fontFamily: fontFamily.medium, fontSize: 10.5, marginTop: 3 }}>{copied ? t('debtShare.copiedCheck') : t('debtShare.tapToCopy')}</Text>
                    {g.variable_symbol && (
                      <Text selectable style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5, marginTop: 6 }}>
                        {t('debtShare.variableSymbol')}: {g.variable_symbol}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            )}

            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14, marginTop: 18, marginBottom: 8, alignSelf: 'flex-start' }}>
              {g.mode === 'ONE_QR' ? t('groupShare.tapYourName') : t('groupShare.pickYours')}
            </Text>
            <View style={{ width: '100%', gap: 8 }}>{g.members.map(renderMember)}</View>

            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginTop: 14, textAlign: 'center' }}>
              {total > 0 && paid === total
                ? t('groupShare.allDone')
                : t('groupShare.paidCount').replace('{paid}', String(paid)).replace('{total}', String(total))}
            </Text>
            {g.mode === 'ONE_QR' && g.fio_enabled && (
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.regular, fontSize: 11, marginTop: 6, textAlign: 'center' }}>{t('groupShare.autoNote')}</Text>
            )}
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 22, paddingTop: 14, paddingBottom: 14, alignItems: 'center' },
  pageInner: { flex: 1, width: '100%', maxWidth: 440 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  langSwitch: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  langBtn: { paddingHorizontal: 9, paddingVertical: 6 },
  body: { flexGrow: 1, alignItems: 'center', paddingBottom: 16 },
  pill: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 999, marginBottom: 8 },
  primaryBtn: { width: '100%', paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  qrBox: { alignItems: 'center', padding: 12, borderRadius: 16, borderWidth: 1, marginTop: 10, width: '100%' },
  qrWhite: { backgroundColor: '#ffffff', padding: 8, borderRadius: 10 },
  qrActionBtn: { marginTop: 8, paddingVertical: 7, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  acctBox: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, width: '100%', alignItems: 'center' },
  member: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  memberRow: { flexDirection: 'row', alignItems: 'center', minHeight: 36 },
});
