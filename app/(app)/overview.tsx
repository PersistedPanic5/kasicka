import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import type { Category } from '@/types/database';

type CategoryRow = Pick<Category, 'id' | 'name' | 'default_monthly_budget'>;

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_NAMES_CS = [
  'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
];

/**
 * Overview — build-roadmap-v1.md Phase 1: month switcher, income/spent/net
 * cards, and budget-vs-actual bars per category. `monthly_budgets` rows are
 * entered directly here (tap a budget number to edit it) rather than
 * through the guided wizard — that's Phase 3's job per the roadmap; this is
 * the "just let me type a number in" version that unblocks daily use now.
 *
 * A category with no monthly_budgets row yet for the selected month falls
 * back to its own `default_monthly_budget` (a field the schema already
 * had for exactly this) so a fresh month isn't all zeros.
 */
export default function Overview() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const { language, t } = useLanguage();

  const [monthOffset, setMonthOffset] = useState(0);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [plannedByCategory, setPlannedByCategory] = useState<Record<string, number>>({});
  const [actualByCategory, setActualByCategory] = useState<Record<string, number>>({});
  const [totalIncome, setTotalIncome] = useState(0);
  const [totalSpent, setTotalSpent] = useState(0);
  const [loading, setLoading] = useState(true);

  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const budgetMonth = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + monthOffset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }, [monthOffset]);

  const monthLabel = useMemo(() => {
    const [y, m] = budgetMonth.split('-');
    const names = language === 'cs' ? MONTH_NAMES_CS : MONTH_NAMES_EN;
    return `${names[Number(m) - 1]} ${y}`;
  }, [budgetMonth, language]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const [categoriesRes, budgetsRes, transactionsRes] = await Promise.all([
      supabase
        .from('categories')
        .select('id, name, default_monthly_budget')
        .eq('owner_id', user.id)
        .eq('category_type', 'EXPENSE')
        .eq('active', true)
        .order('sort_order'),
      supabase
        .from('monthly_budgets')
        .select('category_id, planned_amount')
        .eq('owner_id', user.id)
        .eq('budget_month', budgetMonth),
      supabase
        .from('transactions')
        .select('type, amount, category_id')
        .eq('owner_id', user.id)
        .eq('budget_month', budgetMonth)
        .eq('status', 'PAID'),
    ]);

    setCategories(categoriesRes.data ?? []);

    const planned: Record<string, number> = {};
    for (const row of budgetsRes.data ?? []) planned[row.category_id] = row.planned_amount;
    setPlannedByCategory(planned);

    const actual: Record<string, number> = {};
    let income = 0;
    let spent = 0;
    for (const row of transactionsRes.data ?? []) {
      if (row.type === 'EXPENSE') {
        spent += row.amount;
        if (row.category_id) actual[row.category_id] = (actual[row.category_id] ?? 0) + row.amount;
      } else if (row.type === 'INCOME') {
        income += row.amount;
      }
    }
    setActualByCategory(actual);
    setTotalIncome(income);
    setTotalSpent(spent);
    setLoading(false);
  }, [user, budgetMonth]);

  useEffect(() => {
    load();
  }, [load]);

  function plannedFor(cat: CategoryRow): number {
    return plannedByCategory[cat.id] ?? cat.default_monthly_budget ?? 0;
  }

  function startEdit(cat: CategoryRow) {
    setEditingCategoryId(cat.id);
    setEditValue(String(plannedFor(cat)));
  }

  async function saveBudget(categoryId: string) {
    if (!user) return;
    const amount = Number(editValue);
    if (Number.isNaN(amount) || amount < 0) {
      setEditingCategoryId(null);
      return;
    }
    setSaving(true);
    await supabase
      .from('monthly_budgets')
      .upsert(
        { owner_id: user.id, budget_month: budgetMonth, category_id: categoryId, planned_amount: amount },
        { onConflict: 'owner_id,budget_month,category_id' }
      );
    setPlannedByCategory((prev) => ({ ...prev, [categoryId]: amount }));
    setSaving(false);
    setEditingCategoryId(null);
  }

  const net = totalIncome - totalSpent;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={styles.headerRow}>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24 }}>{t('overview.title')}</Text>
        <View style={styles.monthSwitcher}>
          <Pressable
            onPress={() => setMonthOffset((v) => v - 1)}
            style={[styles.monthBtn, { backgroundColor: tokens.card }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
          </Pressable>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, width: 140, textAlign: 'center' }}>
            {monthLabel}
          </Text>
          <Pressable
            onPress={() => setMonthOffset((v) => v + 1)}
            style={[styles.monthBtn, { backgroundColor: tokens.card }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
      ) : (
        <>
          <View style={styles.cardsRow}>
            <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                {t('overview.income')}
              </Text>
              <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 20, marginTop: 4 }}>
                +{totalIncome} {t('common.czk')}
              </Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                {t('overview.spent')}
              </Text>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 20, marginTop: 4 }}>
                −{totalSpent} {t('common.czk')}
              </Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                {t('overview.net')}
              </Text>
              <Text
                style={{
                  color: net >= 0 ? tokens.greenFg : tokens.coral,
                  fontFamily: fontFamily.bold,
                  fontSize: 20,
                  marginTop: 4,
                }}
              >
                {net >= 0 ? '+' : ''}
                {net} {t('common.czk')}
              </Text>
            </View>
          </View>

          {categories.length === 0 ? (
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginTop: 20 }}>
              {t('overview.noCategoriesYet')}
            </Text>
          ) : (
            <View style={{ marginTop: 28 }}>
              {categories.map((cat) => {
                const planned = plannedFor(cat);
                const actual = actualByCategory[cat.id] ?? 0;
                const pct = planned > 0 ? Math.min(actual / planned, 1) : actual > 0 ? 1 : 0;
                const over = planned > 0 && actual > planned;
                const editing = editingCategoryId === cat.id;

                return (
                  <View key={cat.id} style={styles.budgetRow}>
                    <View style={styles.budgetRowTop}>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{cat.name}</Text>
                      {editing ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TextInput
                            value={editValue}
                            onChangeText={setEditValue}
                            keyboardType="numeric"
                            autoFocus
                            onBlur={() => saveBudget(cat.id)}
                            onSubmitEditing={() => saveBudget(cat.id)}
                            style={[styles.budgetInput, { color: tokens.text, borderColor: tokens.border }]}
                          />
                          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                            {t('common.czk')}
                          </Text>
                        </View>
                      ) : (
                        <Pressable onPress={() => startEdit(cat)} disabled={saving}>
                          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                            {actual} / {planned} {t('common.czk')}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                    <View style={[styles.barTrack, { backgroundColor: tokens.cardAlt }]}>
                      <View
                        style={[
                          styles.barFill,
                          {
                            width: `${Math.round(pct * 100)}%`,
                            backgroundColor: over ? tokens.coral : tokens.accent,
                          },
                        ]}
                      />
                    </View>
                    {over && (
                      <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 3 }}>
                        {actual - planned} {t('common.czk')} {t('overview.overBudget')}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 },
  monthSwitcher: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  monthBtn: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cardsRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  statCard: { flex: 1, minWidth: 130, borderWidth: 1, borderRadius: 14, padding: 14 },
  budgetRow: { marginBottom: 18 },
  budgetRowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  barTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  budgetInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13, width: 80, textAlign: 'right' },
});
