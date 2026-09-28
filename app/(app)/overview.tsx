import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { currentBudgetMonth, formatBudgetMonthLabel, shiftBudgetMonth } from '@/lib/budget-month';
import { categoryColor } from '@/lib/identity';
import { TransactionList, type TransactionRow } from '@/components/TransactionList';
import {
  createOrMergeDebtsForSplit,
  emptySplitPerson,
  splitEvenly,
  splitPeopleSum,
  useDebtHistory,
  validSplitPeople,
  type SplitPerson,
} from '@/lib/split-people';
import { NameAutocompleteInput } from '@/components/NameAutocompleteInput';
import type { Category, EventRow } from '@/types/database';

type CategoryRow = Pick<Category, 'id' | 'name' | 'default_monthly_budget'>;

/** Same rotating-chevron affordance as Settings' collapsible sections
 * (app/(app)/settings.tsx's Section component) — reused here by eye rather
 * than import, since it's a 6-line stateless icon and the two screens
 * otherwise share nothing. */
function ChevronIcon({ expanded, color }: { expanded: boolean; color: string }) {
  return (
    <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M6 9l6 6 6-6" />
      </Svg>
    </View>
  );
}

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
  const { defaultAccountId } = useAppData();

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

  // ── Per-category drill-down (Pavel: "every category clickable... show
  // list of transactions at the selected period" — reuses the exact same
  // list/edit/delete/split UI as Transactions, via components/
  // TransactionList.tsx, rather than a second copy of that design).
  // Inline expand/collapse per category — same interaction as Settings'
  // collapsible sections (Pavel: "uncover the list... in the same width
  // and on the page. Kind of like design of settings page") — rather than
  // a modal, and more than one category can be open at a time, same as
  // Settings. Each expanded category keeps its own cached transaction
  // list, cleared whenever the selected month changes. ──────────────────
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const [categoryTx, setCategoryTx] = useState<Record<string, TransactionRow[]>>({});
  const [categoryTxLoading, setCategoryTxLoading] = useState<Record<string, boolean>>({});

  // ── Events section (claude/event-based-expenses-v1.md) — same inline
  // expand pattern as categories, but every total here is all-time, not
  // scoped to `budgetMonth` (a trip's running total shouldn't reset just
  // because the calendar rolled over), so this loads independently of the
  // month switcher. ──────────────────────────────────────────────────────
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventTotals, setEventTotals] = useState<Record<string, number>>({});
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [eventTx, setEventTx] = useState<Record<string, TransactionRow[]>>({});
  const [eventTxLoading, setEventTxLoading] = useState<Record<string, boolean>>({});
  const debtHistory = useDebtHistory();
  const [splittingEventId, setSplittingEventId] = useState<string | null>(null);
  const [splitPeople, setSplitPeople] = useState<SplitPerson[]>([emptySplitPerson()]);
  const [splitMessage, setSplitMessage] = useState('');
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitShareLinks, setSplitShareLinks] = useState<{ name: string; link: string }[]>([]);
  const [splitCopiedIdx, setSplitCopiedIdx] = useState<number | null>(null);

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

  // A different month means a different set of transactions per category —
  // collapse everything and drop the cache rather than show last month's
  // rows under this month's category.
  useEffect(() => {
    setExpandedCategoryIds(new Set());
    setCategoryTx({});
    setCategoryTxLoading({});
  }, [budgetMonth]);

  const loadCategoryTx = useCallback(
    async (cat: CategoryRow) => {
      if (!user || !budgetMonth) return;
      setCategoryTxLoading((prev) => ({ ...prev, [cat.id]: true }));
      const { data } = await supabase
        .from('transactions')
        .select(
          'id, transaction_date, type, amount, note, status, category_id, account_id, receipt_photo_url, categories(name)'
        )
        .eq('owner_id', user.id)
        .eq('budget_month', budgetMonth)
        .eq('category_id', cat.id)
        .eq('status', 'PAID')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false });
      setCategoryTx((prev) => ({ ...prev, [cat.id]: (data as unknown as TransactionRow[]) ?? [] }));
      setCategoryTxLoading((prev) => ({ ...prev, [cat.id]: false }));
    },
    [user, budgetMonth]
  );

  function toggleCategory(cat: CategoryRow) {
    setExpandedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(cat.id)) next.delete(cat.id);
      else next.add(cat.id);
      return next;
    });
    if (!categoryTx[cat.id]) loadCategoryTx(cat);
  }

  // A split/edit/delete inside an expanded category can change its actual
  // spend, so both that category's own list AND Overview's totals/bars
  // need a fresh fetch — not just one or the other.
  async function handleCategoryTxChanged(cat: CategoryRow) {
    await loadCategoryTx(cat);
    load();
  }

  // All-time, not month-scoped — deliberately its own query rather than
  // reusing `load()`'s (which is `.eq('budget_month', budgetMonth)`).
  const loadEvents = useCallback(async () => {
    if (!user) return;
    const [eventsRes, txRes] = await Promise.all([
      supabase
        .from('events')
        .select('*')
        .eq('owner_id', user.id)
        .order('active', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('transactions').select('event_id, type, amount').eq('owner_id', user.id).not('event_id', 'is', null),
    ]);
    setEvents(eventsRes.data ?? []);
    const totals: Record<string, number> = {};
    for (const row of txRes.data ?? []) {
      if (!row.event_id) continue;
      if (row.type === 'EXPENSE') totals[row.event_id] = (totals[row.event_id] ?? 0) + row.amount;
      else if (row.type === 'DEBT_SETTLEMENT_CREDIT') totals[row.event_id] = (totals[row.event_id] ?? 0) - row.amount;
    }
    setEventTotals(totals);
  }, [user]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const loadEventTx = useCallback(
    async (ev: EventRow) => {
      if (!user) return;
      setEventTxLoading((prev) => ({ ...prev, [ev.id]: true }));
      const { data } = await supabase
        .from('transactions')
        .select(
          'id, transaction_date, type, amount, note, status, category_id, account_id, receipt_photo_url, categories(name)'
        )
        .eq('owner_id', user.id)
        .eq('event_id', ev.id)
        .eq('status', 'PAID')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false });
      setEventTx((prev) => ({ ...prev, [ev.id]: (data as unknown as TransactionRow[]) ?? [] }));
      setEventTxLoading((prev) => ({ ...prev, [ev.id]: false }));
    },
    [user]
  );

  function toggleEvent(ev: EventRow) {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(ev.id)) next.delete(ev.id);
      else next.add(ev.id);
      return next;
    });
    if (!eventTx[ev.id]) loadEventTx(ev);
  }

  async function handleEventTxChanged(ev: EventRow) {
    await loadEventTx(ev);
    loadEvents();
  }

  function linkForToken(token: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') return `${window.location.origin}/d/${token}`;
    return `/d/${token}`;
  }

  // ── "Split this event" (claude/event-based-expenses-v1.md "Splitting",
  // Option A) — one combined split covering the event's whole running
  // total, reusing the standard debts mechanism with transaction_id null
  // and event_id set (same shape as a merged debt). Deliberately simpler
  // than ExpenseEntryForm/TransactionList's split panels: no "merge with
  // an existing outstanding debt" offer here yet (skipped — add if Pavel
  // wants it; every split still lands as a real, correct debt either way,
  // it just won't offer folding into an existing one for a repeat debtor). */
  function startSplit(ev: EventRow) {
    setSplittingEventId(ev.id);
    setSplitPeople([emptySplitPerson()]);
    setSplitMessage(ev.name);
    setSplitError(null);
    setSplitShareLinks([]);
  }

  function cancelSplit() {
    setSplittingEventId(null);
  }

  function addSplitPerson() {
    setSplitPeople((prev) => [...prev, emptySplitPerson()]);
  }
  function removeSplitPerson(id: string) {
    setSplitPeople((prev) => prev.filter((p) => p.id !== id));
  }
  function updateSplitPerson(id: string, field: 'name' | 'amount', value: string) {
    setSplitPeople((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }

  async function saveEventSplit(ev: EventRow) {
    if (!user || !defaultAccountId) return;
    const total = eventTotals[ev.id] ?? 0;
    const validPeople = validSplitPeople(splitPeople);
    const sum = splitPeopleSum(splitPeople);
    if (validPeople.length === 0) return;
    if (sum > total + 0.01) {
      setSplitError(t('home.splitOverAllocatedError'));
      return;
    }
    setSplitSaving(true);
    setSplitError(null);
    const { links, error } = await createOrMergeDebtsForSplit({
      ownerId: user.id,
      transactionId: null,
      eventId: ev.id,
      targetAccountId: defaultAccountId,
      message: splitMessage.trim() || null,
      people: validPeople,
      outstandingByName: debtHistory.outstandingByName,
      mergeNames: new Set(),
      currencyLabel: t('common.czk'),
    });
    if (error) setErrorForSplit(error);
    setSplitShareLinks(links.map((l) => ({ name: l.name, link: linkForToken(l.token) })));
    setSplitSaving(false);
  }

  function setErrorForSplit(message: string) {
    setSplitError(`${t('common.shareLinkFailedPrefix')} ${message}`);
  }

  async function copySplitLink(idx: number) {
    const link = splitShareLinks[idx];
    if (!link) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(link.link);
      setSplitCopiedIdx(idx);
      setTimeout(() => setSplitCopiedIdx(null), 1500);
    }
  }

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
              <Text
                style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 20, marginTop: 4, fontVariant: ['tabular-nums'] }}
              >
                +{totalIncome} {t('common.czk')}
              </Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                {t('overview.spent')}
              </Text>
              <Text
                style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 20, marginTop: 4, fontVariant: ['tabular-nums'] }}
              >
                −{totalSpent} {t('common.czk')}
              </Text>
            </View>
            {/* The one "hero" card — accent border + soft shadow — design
                refresh (2026-09): previously identical to the other two,
                so nothing signaled this was the number that actually
                matters most. */}
            <View
              style={[
                styles.statCard,
                styles.statCardHero,
                { backgroundColor: tokens.cardAlt, borderColor: tokens.accentBorder, shadowColor: tokens.accent },
              ]}
            >
              <Text style={{ color: tokens.accent, fontFamily: fontFamily.medium, fontSize: 12 }}>
                {t('overview.net')}
              </Text>
              <Text
                style={{
                  color: net >= 0 ? tokens.greenFg : tokens.coral,
                  fontFamily: fontFamily.bold,
                  fontSize: 20,
                  marginTop: 4,
                  fontVariant: ['tabular-nums'],
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

              {categories.map((cat, index) => {
                const planned = plannedFor(cat);
                const actual = actualByCategory[cat.id] ?? 0;
                const pct = planned > 0 ? Math.min(actual / planned, 1) : actual > 0 ? 1 : 0;
                const over = planned > 0 && actual > planned;
                const shareOfTotal = totalPlanned > 0 ? Math.round((planned / totalPlanned) * 100) : 0;

                const expanded = expandedCategoryIds.has(cat.id);

                return (
                  // Restructured to match Overview.dc.html's actual row
                  // shape (Pavel: "the same goes for overview... redo it"):
                  // a single card per category, a 34x34 identity block (not
                  // a small dot) on the left, name/bar/amount inline in one
                  // row — the over-budget caption is the one thing the
                  // mockup didn't need to show, so it stays as a second
                  // line inside the same card rather than being dropped.
                  //
                  // Tapping the row uncovers that category's transactions
                  // for this month right here, full-width, below the bar —
                  // same expand/collapse feel as Settings' collapsible
                  // sections (Pavel: "kind of like design of settings
                  // page"), not a popup — disabled while editing budgets so
                  // it doesn't fight the number inputs.
                  <View key={cat.id} style={[styles.budgetCard, { backgroundColor: tokens.card }]}>
                    <Pressable disabled={editingAll} onPress={() => toggleCategory(cat)} style={styles.budgetRow}>
                      {/* Category identity color — design refresh (2026-09):
                          wires up tokens.category (defined, never used
                          before) so categories are distinguishable at a
                          glance. Deliberately separate from the bar's
                          over/under-budget color next to it — before this
                          change the same square carried both meanings at
                          once. */}
                      <View style={[styles.categorySwatch, { backgroundColor: categoryColor(index, tokens) }]} />
                      <Text
                        numberOfLines={1}
                        style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13.5, flexBasis: 92, flexShrink: 1 }}
                      >
                        {cat.name}
                      </Text>
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
                      {editingAll ? (
                        <View style={styles.budgetEditSlot}>
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
                        <>
                          <Text
                            numberOfLines={1}
                            style={{
                              color: tokens.textMuted,
                              fontFamily: fontFamily.medium,
                              fontSize: 12.5,
                              fontVariant: ['tabular-nums'],
                              flexBasis: 148,
                              flexShrink: 0,
                              textAlign: 'right',
                            }}
                          >
                            {actual} / {planned} {t('common.czk')}
                            {totalPlanned > 0 && (
                              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11 }}>
                                {'\n'}
                                {shareOfTotal}% {t('overview.ofTotal')}
                              </Text>
                            )}
                          </Text>
                          <ChevronIcon expanded={expanded} color={tokens.textMuted} />
                        </>
                      )}
                    </Pressable>
                    {over && (
                      <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 6 }}>
                        {actual - planned} {t('common.czk')} {t('overview.overBudget')}
                      </Text>
                    )}
                    {expanded && !editingAll && (
                      <View style={{ marginTop: 12 }}>
                        <TransactionList
                          transactions={categoryTx[cat.id] ?? []}
                          categories={categories}
                          loading={categoryTxLoading[cat.id] ?? false}
                          emptyMessage={t('transactions.noneYet')}
                          onChanged={() => handleCategoryTxChanged(cat)}
                        />
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {events.filter((e) => (eventTotals[e.id] ?? 0) > 0).length > 0 && (
            <View style={{ marginTop: 28 }}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 16, marginBottom: 14 }}>
                {t('more.events')}
              </Text>
              {events
                .filter((e) => (eventTotals[e.id] ?? 0) > 0)
                .map((ev) => {
                  const expanded = expandedEventIds.has(ev.id);
                  const total = eventTotals[ev.id] ?? 0;
                  const splitting = splittingEventId === ev.id;
                  const sum = splitPeopleSum(splitPeople);
                  const remaining = Math.round((total - sum) * 100) / 100;
                  return (
                    <View key={ev.id} style={[styles.budgetCard, { backgroundColor: tokens.card }]}>
                      <Pressable onPress={() => toggleEvent(ev)} style={styles.budgetRow}>
                        <Text
                          numberOfLines={1}
                          style={{ color: ev.active ? tokens.text : tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13.5, flex: 1 }}
                        >
                          {ev.name}
                        </Text>
                        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, fontVariant: ['tabular-nums'] }}>
                          {total} {t('common.czk')}
                        </Text>
                        <ChevronIcon expanded={expanded} color={tokens.textMuted} />
                      </Pressable>

                      {expanded && (
                        <View style={{ marginTop: 12 }}>
                          <TransactionList
                            transactions={eventTx[ev.id] ?? []}
                            categories={categories}
                            loading={eventTxLoading[ev.id] ?? false}
                            emptyMessage={t('transactions.noneYet')}
                            onChanged={() => handleEventTxChanged(ev)}
                          />

                          {!splitting ? (
                            <Pressable
                              onPress={() => startSplit(ev)}
                              style={[styles.editBtn, { backgroundColor: tokens.cardAlt, alignSelf: 'flex-start', marginTop: 10 }]}
                            >
                              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                {t('overview.splitEventBtn')}
                              </Text>
                            </Pressable>
                          ) : (
                            <View style={{ marginTop: 12, gap: 8 }}>
                              <TextInput
                                value={splitMessage}
                                onChangeText={setSplitMessage}
                                placeholder={t('home.messagePlaceholder')}
                                placeholderTextColor={tokens.textMuted}
                                style={[styles.budgetInput, { color: tokens.text, borderColor: tokens.border, width: '100%', textAlign: 'left' }]}
                              />
                              <Pressable
                                onPress={() => setSplitPeople((prev) => splitEvenly(total, prev))}
                                style={[styles.editBtn, { backgroundColor: tokens.cardAlt, alignSelf: 'flex-start' }]}
                              >
                                <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                  {t('home.splitEvenlyBtn')}
                                </Text>
                              </Pressable>
                              <Text style={{ color: remaining === 0 ? tokens.greenFg : remaining < 0 ? tokens.coral : tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                                {sum} / {total} {t('common.czk')}
                                {remaining > 0 ? ` · ${t('home.splitStillMissing')} ${remaining}` : ''}
                                {remaining < 0 ? ` · ${t('home.splitOverAllocated')} ${Math.abs(remaining)}` : ''}
                              </Text>
                              {splitPeople.map((p) => (
                                <View key={p.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                  <NameAutocompleteInput
                                    value={p.name}
                                    onChangeText={(v) => updateSplitPerson(p.id, 'name', v)}
                                    pastNames={debtHistory.pastNames}
                                    placeholder={t('home.whoOwesPlaceholder')}
                                    containerStyle={{ flex: 1 }}
                                    inputStyle={[styles.budgetInput, { color: tokens.text, borderColor: tokens.border, width: '100%', textAlign: 'left' }]}
                                  />
                                  <TextInput
                                    value={p.amount}
                                    onChangeText={(v) => updateSplitPerson(p.id, 'amount', v)}
                                    keyboardType="numeric"
                                    placeholder={t('home.howMuchPlaceholder')}
                                    placeholderTextColor={tokens.textMuted}
                                    style={[styles.budgetInput, { color: tokens.text, borderColor: tokens.border, width: 90 }]}
                                  />
                                  {splitPeople.length > 1 && (
                                    <Pressable onPress={() => removeSplitPerson(p.id)} hitSlop={8}>
                                      <Text style={{ color: tokens.coral, fontFamily: fontFamily.bold, fontSize: 16 }}>×</Text>
                                    </Pressable>
                                  )}
                                </View>
                              ))}
                              <Pressable onPress={addSplitPerson}>
                                <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                  {t('home.addPersonBtn')}
                                </Text>
                              </Pressable>

                              {splitError && (
                                <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12 }}>{splitError}</Text>
                              )}
                              {splitShareLinks.length > 0 && (
                                <View style={{ gap: 6 }}>
                                  {splitShareLinks.map((link, idx) => (
                                    <View key={idx} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                      <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 12.5, flex: 1 }}>
                                        {link.name}
                                      </Text>
                                      <Pressable onPress={() => copySplitLink(idx)}>
                                        <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                          {splitCopiedIdx === idx ? t('common.copied') : t('common.copyLink')}
                                        </Text>
                                      </Pressable>
                                    </View>
                                  ))}
                                </View>
                              )}

                              <View style={{ flexDirection: 'row', gap: 8 }}>
                                <Pressable onPress={cancelSplit} disabled={splitSaving} style={[styles.editBtn, { backgroundColor: tokens.cardAlt }]}>
                                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                    {t('common.cancel')}
                                  </Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => saveEventSplit(ev)}
                                  disabled={splitSaving || validSplitPeople(splitPeople).length === 0}
                                  style={[styles.editBtn, { backgroundColor: tokens.accent, opacity: splitSaving ? 0.6 : 1 }]}
                                >
                                  <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                    {splitSaving ? t('common.saving') : t('common.save')}
                                  </Text>
                                </Pressable>
                              </View>
                            </View>
                          )}
                        </View>
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
  monthBtn: { width: 28, height: 28, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardsRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  statCard: { flex: 1, minWidth: 130, borderWidth: 1, borderRadius: 20, padding: 14 },
  statCardHero: { shadowOpacity: 0.22, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 3 },
  editRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 14 },
  editBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 11 },
  // One card per category (Overview.dc.html: background:card, radius:18,
  // padding:14/18) — matches the per-item-card pattern already used on
  // Debts/Transactions, rather than plain unbounded rows.
  budgetCard: { borderRadius: 18, padding: 14, marginBottom: 10 },
  budgetRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  // 34x34 solid identity block, not a small dot — Overview.dc.html's
  // actual spec, and a lot more visible at a glance than the 12px dot
  // this replaced.
  categorySwatch: { width: 34, height: 34, borderRadius: 12, flexShrink: 0 },
  barTrack: { height: 10, borderRadius: 5, overflow: 'hidden', flex: 1, minWidth: 0 },
  barFill: { height: 10, borderRadius: 5 },
  budgetEditSlot: { flexDirection: 'row', alignItems: 'center', gap: 6, flexBasis: 148, flexShrink: 0, justifyContent: 'flex-end' },
  budgetInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13, width: 80, textAlign: 'right' },
});
