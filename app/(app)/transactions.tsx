import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

type TransactionRow = {
  id: string;
  transaction_date: string;
  type: string;
  amount: number;
  note: string | null;
  status: string;
  categories: { name: string } | null;
};

/**
 * Real transaction list — chronological, most recent first. Deliberately
 * simple for this pass (no search/filters/edit/void yet — those are the
 * remaining Phase 1 "Transactions" scope per build-roadmap-v1.md); this is
 * the place to see, right after saving an expense (including a split-off
 * debt via ExpenseEntryForm), that it actually landed.
 *
 * When a transaction has a note, it reads as the row's name (the note is
 * what you actually typed to describe it) with the category demoted to
 * the subtitle line — otherwise the category name carries the row, same
 * as before notes existed.
 */
export default function Transactions() {
  const { tokens } = useTheme();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('transactions')
      .select('id, transaction_date, type, amount, note, status, categories(name)')
      .eq('status', 'PAID')
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(100);
    setTransactions((data as unknown as TransactionRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const typeLabel: Record<string, string> = {
    EXPENSE: 'Expense',
    INCOME: 'Income',
    RESERVE_TRANSFER: 'Reserve transfer',
    PAYMENT_FROM_RESERVE: 'Reserve payment',
    DEBT_SETTLEMENT_CREDIT: 'Debt settled',
  };

  const isCredit = (type: string) => type === 'INCOME' || type === 'DEBT_SETTLEMENT_CREDIT';

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
      {loading && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>Loading…</Text>
      )}
      {!loading && transactions.length === 0 && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14 }}>
          No transactions yet — anything you save from Home shows up here.
        </Text>
      )}
      {transactions.map((t) => {
        const categoryName = t.categories?.name ?? typeLabel[t.type] ?? t.type;
        const primaryName = t.note?.trim() || categoryName;
        const showCategoryAsSubtitle = Boolean(t.note?.trim()) && categoryName !== primaryName;
        return (
          <View key={t.id} style={[styles.row, { borderBottomColor: tokens.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14.5 }}>
                {primaryName}
              </Text>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 2 }}>
                {t.transaction_date}
                {showCategoryAsSubtitle ? ` · ${categoryName}` : ''}
              </Text>
            </View>
            <Text
              style={{
                color: isCredit(t.type) ? tokens.greenFg : tokens.text,
                fontFamily: fontFamily.bold,
                fontSize: 15,
              }}
            >
              {isCredit(t.type) ? '+' : '−'}
              {t.amount} CZK
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
});
