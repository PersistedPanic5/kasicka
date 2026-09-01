import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { currentBudgetMonth, formatBudgetMonthLabel, shiftBudgetMonth } from '@/lib/budget-month';
import type { Category } from '@/types/database';

type CategoryRow = Pick<Category, 'id' | 'name' | 'default_monthly_budget'>;

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
 *
 * The month switcher walks whole budget-month cycles, not calendar months
 * — `profile.month_start_day` (Settings → Profile & preferences, see
 * lib/budget-month.ts) can move where a cycle starts/ends. `monthStartDay`
 * is fetched once, separately from the per-month `load()` below, and
 * `budgetMonth` stays `null` until it resolves so `load()` never fires
 * against a wrong (default-calendar-month) bucket for a split second.
 */
export default function Overview() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const { language, t } = useLanguage();

  const [monthOffset, setMonthOffset] = useState(0);
  const [monthStartDay, setMonthStartDay] = useState<number | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [plannedByCategory, setPlannedByCategory] = useState<Record<string, number>>({});
  const [actualByCategory, setActualByCategory] = useState<Record<string, number>>({});
  const [totalIncome, setTotalIncome] = useState(0);
  const [totalSpent, setTotalSpent] = useState(0);
  const [loading, setLoading] = useState(true);

  // Editing budgets is an all-or-nothing "unlock" rather than tap-any-
  // number-to-edit — a per-row implicit edit state read as a bug (tapping
  // a total looked editable when it shouldn't have), so this is instead a
  // deliberate Edit → adjust as many rows as you like → Save/Cancel flow,
  // matching the wizard's step 1 batch-edit pattern.
  const [editingAll, setEditingAll] = useState(false);
  const [budgetDraftsAll, setBudgetDraftsAll] = useState<Record<string, string>>({});
  const [savingAll, setSavingAll] = useState(false);

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
    if (!user || !budgetMonth) return;
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
      } else if (row.type === 'DEBT_SETTLEMENT_CREDIT') {
        // debts-ledger-requirements.md: settling a debt "generates a
        // credit/refund against that same category" — a cost decrease,
        // not income, so both the category's actual spend and the total
        // spent figure come back down by the settled amount. Previously
        // this branch didn't exist at all, so a settled debt's credit
        // transaction was silently excluded from every Overview total
        // (confirmed against a real example: -1300/-365/-34 with a +650
        // settled credit showed -1699 instead of the correct -1049).
        spent -= row.amount;
        if (row.category_id) actual[row.category_id] = (actual[row.category_id] ?? 0) - row.amount;
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

  function startEditAll() {
    const drafts: Record<string, string> = {};
    for (const cat of categories) drafts[cat.id] = String(plannedFor(cat));
    setBudgetDraftsAll(drafts);
    setEditingAll(true);
  }

  function cancelEditAll() {
    setEditingAll(false);
    setBudgetDraftsAll({});
  }

  async function saveAllBudgetsOverview() {
    if (!user || !budgetMonth) return;
    setSavingAll(true);
    const rows = categories
      .map((cat) => {
        const amount = Number(budgetDraftsAll[cat.id]);
        if (Number.isNaN(amount) || amount < 0) return null;
        return { owner_id: user.id, budget_month: budgetMonth, category_id: cat.id, planned_amount: amount };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0) {
      await supabase.from('monthly_budgets').upsert(rows, { onConflict: 'owner_id,budget_month,category_id' });
      setPlannedByCategory((prev) => {
        const next = { ...prev };
        for (const row of rows) next[row.category_id] = row.planned_amount;
        return next;
      });
    }
    setSavingAll(false);
    setEditingAll(false);
    setBudgetDraftsAll({});
  }

  const net = totalIncome - totalSpent;
  const totalPlanned = useMemo(() => categories.reduce((sum, cat) => sum + plannedFor(cat), 0), [categories, plannedByCategory]);

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
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, width: 190, textAlign: 'center' }}>
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
              <View style={styles.editRow}>
                {!editingAll ? (
                  <Pressable onPress={startEditAll} style={[styles.editBtn, { backgroundColor: tokens.cardAlt }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                      {t('overview.editBudgets')}
                    </Text>
                  </Pressable>
                ) : (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable onPress={cancelEditAll} disabled={savingAll} style={[styles.editBtn, { backgroundColor: tokens.cardAlt }]}>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {t('common.cancel')}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={saveAllBudgetsOverview}
                      disabled={savingAll}
                      style={[styles.editBtn, { backgroundColor: tokens.accent, opacity: savingAll ? 0.6 : 1 }]}
                    >
                      <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {savingAll ? t('common.saving') : t('common.save')}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>

              {categories.map((cat) => {
                const planned = plannedFor(cat);
                const actual = actualByCategory[cat.id] ?? 0;
                const pct = planned > 0 ? Math.min(actual / planned, 1) : actual > 0 ? 1 : 0;
                const over = planned > 0 && actual > planned;
                const shareOfTotal = totalPlanned > 0 ? Math.round((planned / totalPlanned) * 100) : 0;

                return (
                  <View key={cat.id} style={styles.budgetRow}>
                    <View style={styles.budgetRowTop}>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{cat.name}</Text>
                      {editingAll ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TextInput
                            value={budgetDraftsAll[cat.id] ?? ''}
                            onChangeText={(v) => setBudgetDraftsAll((prev) => ({ ...prev, [cat.id]: v }))}
                            keyboardType="numeric"
                            style={[styles.budgetInput, { color: tokens.text, borderColor: tokens.border }]}
                          />
                          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                            {t('common.czk')}
                          </Text>
                        </View>
                      ) : (
                        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5 }}>
                          {actual} / {planned} {t('common.czk')}
                          {totalPlanned > 0 && (
                            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>
                              {' '}
                              · {shareOfTotal}% {t('overview.ofTotal')}
                            </Text>
                          )}
                        </Text>
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
  editRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 14 },
  editBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 9 },
  budgetRow: { marginBottom: 18 },
  budgetRowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  barTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  budgetInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13, width: 80, textAlign: 'right' },
});
