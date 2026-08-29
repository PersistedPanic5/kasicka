import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase } from '@/lib/supabase';

/**
 * The public, no-login debt share page — matches DebtorShare.dc.html.
 * Reachable at kasicka.eu/d/<token> (see architecture-v1.md), rendered as a
 * plain webpage for anyone who opens the link, app installed or not. Calls
 * the two SECURITY DEFINER functions from
 * supabase/migrations/0002_public_debt_share.sql — no auth session
 * involved, matching how architecture-v1.md describes this route.
 *
 * TODO(Phase 1): real Czech SPD QR code render (reuse PaymentService logic
 * ported from the old app) — not yet wired here, this proves the data path.
 * TODO(Phase 4 / localization pass): auto-detect device language + manual
 * switch, per screens-and-flows.md "Localization" — English-only for now.
 */
type DebtShareView = {
  description: string;
  amount: number;
  status: 'OUTSTANDING' | 'CLAIMED_PAID' | 'SETTLED';
  target_account_prefix: string | null;
  target_account_number: string | null;
  target_bank_code: string | null;
};

export default function DebtorSharePage() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { tokens } = useTheme();
  const [debt, setDebt] = useState<DebtShareView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

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

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.header}>
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 12, letterSpacing: 1 }}>
          KASIČKA
        </Text>
        <ThemeToggle size={34} />
      </View>

      {loading && <ActivityIndicator color={tokens.accent} style={{ marginTop: 60 }} />}

      {!loading && notFound && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, textAlign: 'center', marginTop: 60 }}>
          This link isn't valid — it may have already been used, or copied incorrectly.
        </Text>
      )}

      {!loading && debt && (
        <View style={styles.body}>
          <View style={[styles.avatar, { backgroundColor: tokens.cardAlt }]}>
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 19 }}>P</Text>
          </View>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 15, marginBottom: 6 }}>
            Pavel says you owe him for
          </Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 17, marginBottom: 18 }}>
            {debt.description}
          </Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.regular, fontSize: 48 }}>
            {debt.amount}
            <Text style={{ color: tokens.textMuted, fontSize: 20, fontFamily: fontFamily.medium }}> CZK</Text>
          </Text>

          <View style={{ flex: 1 }} />

          {debt.status === 'OUTSTANDING' && (
            <Pressable onPress={markPaid} style={[styles.primaryBtn, { backgroundColor: tokens.accent }]}>
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 16 }}>
                I've paid this
              </Text>
            </Pressable>
          )}

          {debt.status === 'CLAIMED_PAID' && (
            <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 14, marginBottom: 4 }}>
                Marked as paid
              </Text>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 12.5, opacity: 0.85 }}>
                Pavel will confirm once he sees it land
              </Text>
              <Pressable onPress={undo}>
                <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 8, textDecorationLine: 'underline', opacity: 0.7 }}>
                  Undo
                </Text>
              </Pressable>
            </View>
          )}

          {debt.status === 'SETTLED' && (
            <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 14 }}>
                Settled — thank you!
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
  body: { flex: 1, alignItems: 'center' },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  primaryBtn: { width: '100%', paddingVertical: 17, borderRadius: 16, alignItems: 'center' },
  claimedBox: { width: '100%', paddingVertical: 16, borderRadius: 16, alignItems: 'center' },
});
