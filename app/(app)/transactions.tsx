import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';
import { currentBudgetMonth, formatBudgetMonthLabel, shiftBudgetMonth } from '@/lib/budget-month';
import { categoryColor } from '@/lib/identity';
import { categoryOrTypeLabel, TransactionList, type TransactionRow } from '@/components/TransactionList';

type TypeFilter = 'ALL' | 'EXPENSE' | 'INCOME' | 'OTHER';

/**
 * Real transaction list — chronological, most recent first, scoped to one
 * budget month at a time (Pavel: "I need to add a period (month) filter")
 * via the same month-switcher pattern as Overview/Payments
 * (lib/budget-month.ts). Search + type/category filters then narrow
 * further within that month.
 *
 * The row rendering, edit/delete, and the detail/split modals all live in
 * components/TransactionList.tsx — shared with Overview's per-category
 * drill-down (Pavel: "it might really be basically the same list as is in
 * transactions... maybe we can just merge two of them") so both places
 * look and behave identically, including the more compact row layout.
 */
export default function Transactions() {
  const { tokens } = useTheme();
  const { t: tr, language } = useLanguage();
  const { user } = useAuth();
  const { categories } = useAppData();

  const [monthOffset, setMonthOffset] = useState(0);
  const [monthStartDay, setMonthStartDay] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('profile')
      .select('month_start_day')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setMonthStartDay(data?.month_start_day ?? 1);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const budgetMonth = useMemo(
    () => (monthStartDay !== null ? shiftBudgetMonth(currentBudgetMonth(monthStartDay), monthOffset) : null),
    [monthStartDay, monthOffset]
  );
  const monthLabel = useMemo(
    () => (budgetMonth && monthStartDay !== null ? formatBudgetMonthLabel(budgetMonth, monthStartDay, language) : ''),
    [budgetMonth, monthStartDay, language]
  );

  const load = useCallback(async () => {
    if (!budgetMonth) return;
    setLoading(true);
    const { data } = await supabase
      .from('transactions')
      .select(
        'id, transaction_date, type, amount, note, status, category_id, account_id, receipt_photo_url, categories(name)'
      )
      .eq('status', 'PAID')
      .eq('budget_month', budgetMonth)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false });
    setTransactions((data as unknown as TransactionRow[]) ?? []);
    setLoading(false);
  }, [budgetMonth]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredTransactions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (typeFilter === 'EXPENSE' && t.type !== 'EXPENSE') return false;
      if (typeFilter === 'INCOME' && t.type !== 'INCOME') return false;
      if (typeFilter === 'OTHER' && (t.type === 'EXPENSE' || t.type === 'INCOME')) return false;
      if (categoryFilter !== 'ALL' && t.category_id !== categoryFilter) return false;
      if (q) {
        const haystack = `${t.note ?? ''} ${categoryOrTypeLabel(t, tr)}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, search, typeFilter, categoryFilter, tr]);

  const typeFilters: { key: TypeFilter; label: string }[] = [
    { key: 'ALL', label: tr('transactions.filterAll') },
    { key: 'EXPENSE', label: tr('transactions.typeExpense') },
    { key: 'INCOME', label: tr('transactions.typeIncome') },
    { key: 'OTHER', label: tr('transactions.filterOther') },
  ];
  const categoryFilters = [
    { id: 'ALL', name: tr('transactions.filterAll'), colorIndex: -1 },
    ...categories.map((c, i) => ({ id: c.id, name: c.name, colorIndex: i })),
  ];

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.monthSwitcher}>
        <Pressable onPress={() => setMonthOffset((v) => v - 1)} style={[styles.monthBtn, { backgroundColor: tokens.card }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
        </Pressable>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, width: 190, textAlign: 'center' }}>
          {monthLabel}
        </Text>
        <Pressable onPress={() => setMonthOffset((v) => v + 1)} style={[styles.monthBtn, { backgroundColor: tokens.card }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
        </Pressable>
      </View>

      <View style={[styles.searchWrap, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
        <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={tokens.textMuted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Circle cx="11" cy="11" r="7" />
          <Path d="m21 21-4.3-4.3" />
        </Svg>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={tr('transactions.searchPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.searchInput, { color: tokens.text }]}
        />
      </View>

      <View style={styles.filterRow}>
        {typeFilters.map((f) => {
          const active = typeFilter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setTypeFilter(f.key)}
              style={[styles.filterChip, { backgroundColor: active ? tokens.accent : tokens.card }]}
            >
              <Text style={{ color: active ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {categories.length > 0 && (
        <View style={[styles.filterRow, { marginTop: 4 }]}>
          {categoryFilters.map((c) => {
            const active = categoryFilter === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCategoryFilter(c.id)}
                style={[styles.filterChip, { backgroundColor: active ? tokens.accent : tokens.card }]}
              >
                {!active && c.colorIndex >= 0 && (
                  <View style={[styles.categoryDot, { backgroundColor: categoryColor(c.colorIndex, tokens) }]} />
                )}
                <Text style={{ color: active ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <ScrollView style={{ flex: 1, marginTop: 14 }} contentContainerStyle={{ paddingBottom: 90 }}>
        {!loading && transactions.length > 0 && filteredTransactions.length === 0 && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14, marginBottom: 10 }}>
            {tr('transactions.noMatches')}
          </Text>
        )}
        <TransactionList
          transactions={filteredTransactions}
          categories={categories}
          loading={loading}
          selectable
          emptyMessage={tr('transactions.noneYet')}
          onChanged={load}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  monthSwitcher: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center', marginBottom: 12 },
  monthBtn: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 12,
  },
  categoryDot: { width: 7, height: 7, borderRadius: 4 },
});
