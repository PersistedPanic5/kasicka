import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import type { DebtStatus } from '@/types/database';

type DebtRow = {
  id: string;
  owed_by_name: string;
  amount: number;
  status: DebtStatus;
  share_token: string;
  transaction_id: string;
  target_account_id: string;
  created_at: string;
};

/**
 * Real debts list — debts-ledger-requirements.md "Settle-up state
 * machine": three sections (OUTSTANDING / awaiting-your-confirmation /
 * SETTLED), since a CLAIMED_PAID debt is the debtor's claim, not proof —
 * Pavel checks his bank statement and explicitly confirms before the
 * budget credit lands. "Confirm settled" is the one action here that
 * writes anything: it inserts a DEBT_SETTLEMENT_CREDIT transaction in the
 * original expense's category, dated today, and marks the debt SETTLED.
 */
export default function Debts() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const [debts, setDebts] = useState<DebtRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('debts')
      .select('id, owed_by_name, amount, status, share_token, transaction_id, target_account_id, created_at')
      .order('created_at', { ascending: false });
    setDebts(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function shareLink(token: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return `${window.location.origin}/d/${token}`;
    }
    return `/d/${token}`;
  }

  async function copyLink(debt: DebtRow) {
    const link = shareLink(debt.share_token);
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(link);
      setCopiedId(debt.id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  }

  async function confirmSettled(debt: DebtRow) {
    if (!user) return;
    setBusyId(debt.id);

    const { data: original } = await supabase
      .from('transactions')
      .select('category_id, account_id')
      .eq('id', debt.transaction_id)
      .maybeSingle();

    const today = new Date().toISOString().slice(0, 10);
    const { data: credit, error: creditError } = await supabase
      .from('transactions')
      .insert({
        owner_id: user.id,
        budget_month: `${today.slice(0, 7)}-01`,
        transaction_date: today,
        type: 'DEBT_SETTLEMENT_CREDIT',
        category_id: original?.category_id ?? null,
        account_id: original?.account_id ?? debt.target_account_id,
        amount: debt.amount,
        note: `Settled: ${debt.owed_by_name}`,
        source: 'DEBT_SETTLEMENT',
      })
      .select('id')
      .single();

    if (!creditError && credit) {
      await supabase
        .from('debts')
        .update({
          status: 'SETTLED',
          settled_at: new Date().toISOString(),
          settlement_transaction_id: credit.id,
        })
        .eq('id', debt.id);
    }

    setBusyId(null);
    load();
  }

  const outstanding = debts.filter((d) => d.status === 'OUTSTANDING');
  const awaitingConfirmation = debts.filter((d) => d.status === 'CLAIMED_PAID');
  const settled = debts.filter((d) => d.status === 'SETTLED');

  function DebtCard({ debt, action }: { debt: DebtRow; action?: 'settle' }) {
    return (
      <View key={debt.id} style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15 }}>{debt.owed_by_name}</Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 2 }}>
            {debt.amount} CZK
          </Text>
        </View>
        <View style={styles.cardActions}>
          {debt.status !== 'SETTLED' && (
            <Pressable onPress={() => copyLink(debt)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                {copiedId === debt.id ? 'Copied' : 'Copy link'}
              </Text>
            </Pressable>
          )}
          {action === 'settle' && (
            <Pressable
              onPress={() => confirmSettled(debt)}
              disabled={busyId === debt.id}
              style={[styles.smallBtn, { backgroundColor: tokens.accent, opacity: busyId === debt.id ? 0.6 : 1 }]}
            >
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12 }}>
                Confirm settled
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  function Section({ title, items, action, emptyNote }: {
    title: string;
    items: DebtRow[];
    action?: 'settle';
    emptyNote: string;
  }) {
    return (
      <View style={styles.section}>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 15, marginBottom: 10 }}>
          {title} {items.length > 0 && `(${items.length})`}
        </Text>
        {items.length === 0 ? (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>{emptyNote}</Text>
        ) : (
          items.map((d) => <DebtCard key={d.id} debt={d} action={action} />)
        )}
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
      {loading ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>Loading…</Text>
      ) : (
        <>
          <Section
            title="Awaiting your confirmation"
            items={awaitingConfirmation}
            action="settle"
            emptyNote="Nothing marked as paid yet."
          />
          <Section title="Outstanding" items={outstanding} emptyNote="Nobody owes you anything right now." />
          <Section title="Settled" items={settled} emptyNote="No settled debts yet." />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 28 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  cardActions: { flexDirection: 'row', gap: 8 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9 },
});
