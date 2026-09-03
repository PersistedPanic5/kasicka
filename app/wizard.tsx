import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { LogoMark } from '@/components/Logo';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { currentBudgetMonth, formatBudgetMonthLabel, shiftBudgetMonth } from '@/lib/budget-month';
import {
  accrualProgress,
  confirmFinalPayment,
  confirmReserveTransfer,
  currentCycle,
  finalPaymentQrPayload,
  isFinalPaymentDue,
  isReserveTransferDue,
  monthlyReserveAmount,
  reserveTransferQrPayload,
  type LongTermTx,
  type ReserveCycle,
} from '@/lib/long-term';
import type { Account, Category, LongTermItem } from '@/types/database';

/**
 * The 5-step monthly budgeting wizard — build-roadmap-v1.md Phase 3,
 * screens-and-flows.md "Monthly budgeting wizard (desktop)": confirm
 * budgets → last month's actual-vs-budget recap → long-term reserve
 * overview → generate QR payments for bills due this cycle → finish.
 *
 * Deliberately a TOP-LEVEL route (app/wizard.tsx), a sibling of app/(app),
 * not a screen inside it — that's what keeps it nav-free (see
 * app/(app)/_layout.tsx's <Slot />, which every (app) screen inherits).
 * The only way out is the explicit "Save & exit" link, matching the old
 * app's guided-flow feel ("a focused, nav-free full-screen flow").
 *
 * "Save & exit to More" in the original spec now reads "to Planning" —
 * Planning (not Settings) is where this wizard is launched from and where
 * recurring/long-term items live day to day, so that's the natural place
 * to land back on.
 *
 * Each step's own data saves as you move past it (budgets on step 1→2,
 * QR confirmations immediately on step 4) rather than being held back for
 * one big submit at the end — so leaving early via "Save & exit" never
 * loses anything you already confirmed.
 */

const STEP_COUNT = 5;

interface DueEntry {
  item: LongTermItem;
  cycle: ReserveCycle;
  reserveDue: boolean;
  paymentDue: boolean;
}

export default function MonthlyWizard() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const { language, t } = useLanguage();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [finished, setFinished] = useState(false);

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [defaultAccountId, setDefaultAccountId] = useState<string | null>(null);
  const [monthStartDay, setMonthStartDay] = useState<number | null>(null);

  // How many cycles ahead of "right now" this session is planning — 0 is
  // the current, real cycle (the full 5-step review); >0 is a future cycle
  // you're getting a head start on. Recap (step 2) and QR/bill-confirming
  // (steps 3-4) are tied to real due dates — currentCycle()/isReserveTransferDue()
  // etc. in lib/long-term.ts always check against *today*, not whichever
  // cycle is being planned — so those steps genuinely don't apply yet to a
  // future cycle and are skipped entirely; see `steps` below.
  const [monthOffset, setMonthOffset] = useState(0);

  // Fetched separately from the main load() below, and gates it — see the
  // identical pattern (and the reasoning) in overview.tsx.
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

  const currentMonth = useMemo(
    () => (monthStartDay !== null ? shiftBudgetMonth(currentBudgetMonth(monthStartDay), monthOffset) : null),
    [monthStartDay, monthOffset]
  );
  const prevMonth = useMemo(() => (currentMonth ? shiftBudgetMonth(currentMonth, -1) : null), [currentMonth]);
  const monthLabel = useMemo(
    () => (currentMonth && monthStartDay !== null ? formatBudgetMonthLabel(currentMonth, monthStartDay, language) : ''),
    [currentMonth, monthStartDay, language]
  );
  const prevMonthLabel = useMemo(
    () => (prevMonth && monthStartDay !== null ? formatBudgetMonthLabel(prevMonth, monthStartDay, language) : ''),
    [prevMonth, monthStartDay, language]
  );

  // Planning a future cycle: only step 1 (set budgets) and step 5 (finish)
  // apply — see the monthOffset comment above.
  const isFuturePlan = monthOffset > 0;
  const steps = useMemo(
    () => (isFuturePlan ? [1, 5] : Array.from({ length: STEP_COUNT }, (_, i) => i + 1)),
    [isFuturePlan]
  );

  // ── Step 1 — this month's budgets (editable) ────────────────────────
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [savingBudgets, setSavingBudgets] = useState(false);
  const budgetTotal = useMemo(
    () => Object.values(budgetDrafts).reduce((sum, v) => sum + (Number(v) || 0), 0),
    [budgetDrafts]
  );

  // ── Step 2 — last month recap (read-only) ────────────────────────────
  const [prevPlannedByCategory, setPrevPlannedByCategory] = useState<Record<string, number>>({});
  const [prevActualByCategory, setPrevActualByCategory] = useState<Record<string, number>>({});
  const [prevIncome, setPrevIncome] = useState(0);
  const [prevSpent, setPrevSpent] = useState(0);

  // ── Steps 3–4 — long-term & reserve ──────────────────────────────────
  const [longTermItems, setLongTermItems] = useState<LongTermItem[]>([]);
  const [longTermTx, setLongTermTx] = useState<LongTermTx[]>([]);
  const [openQrItemId, setOpenQrItemId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmedThisSession, setConfirmedThisSession] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!user || !currentMonth || !prevMonth) return;
    setLoading(true);
    const [categoriesRes, accountsRes, profileRes, budgetsRes, prevBudgetsRes, prevTxRes, longTermRes, longTermTxRes] =
      await Promise.all([
        supabase
          .from('categories')
          .select('*')
          .eq('owner_id', user.id)
          .eq('category_type', 'EXPENSE')
          .eq('active', true)
          .order('sort_order'),
        supabase.from('accounts').select('*').eq('owner_id', user.id).eq('active', true).order('sort_order'),
        supabase.from('profile').select('default_account_id').eq('id', user.id).maybeSingle(),
        supabase
          .from('monthly_budgets')
          .select('category_id, planned_amount')
          .eq('owner_id', user.id)
          .eq('budget_month', currentMonth),
        supabase
          .from('monthly_budgets')
          .select('category_id, planned_amount')
          .eq('owner_id', user.id)
          .eq('budget_month', prevMonth),
        supabase
          .from('transactions')
          .select('type, amount, category_id')
          .eq('owner_id', user.id)
          .eq('budget_month', prevMonth)
          .eq('status', 'PAID'),
        supabase.from('long_term_items').select('*').eq('owner_id', user.id).eq('active', true).order('name'),
        // No date filter — see planning.tsx's identical comment: a
        // repeat_yearly item's window can cross a calendar-year boundary.
        supabase
          .from('transactions')
          .select('long_term_item_id, type, amount, transaction_date')
          .eq('owner_id', user.id)
          .not('long_term_item_id', 'is', null),
      ]);

    const cats = categoriesRes.data ?? [];
    setCategories(cats);
    setAccounts(accountsRes.data ?? []);
    setDefaultAccountId(profileRes.data?.default_account_id ?? null);

    const planned: Record<string, number> = {};
    for (const row of budgetsRes.data ?? []) planned[row.category_id] = row.planned_amount;
    const drafts: Record<string, string> = {};
    for (const cat of cats) drafts[cat.id] = String(planned[cat.id] ?? cat.default_monthly_budget ?? 0);
    setBudgetDrafts(drafts);

    const prevPlanned: Record<string, number> = {};
    for (const row of prevBudgetsRes.data ?? []) prevPlanned[row.category_id] = row.planned_amount;
    setPrevPlannedByCategory(prevPlanned);

    const prevActual: Record<string, number> = {};
    let income = 0;
    let spent = 0;
    for (const row of prevTxRes.data ?? []) {
      if (row.type === 'EXPENSE') {
        spent += row.amount;
        if (row.category_id) prevActual[row.category_id] = (prevActual[row.category_id] ?? 0) + row.amount;
      } else if (row.type === 'INCOME') {
        income += row.amount;
      }
    }
    setPrevActualByCategory(prevActual);
    setPrevIncome(income);
    setPrevSpent(spent);

    setLongTermItems(longTermRes.data ?? []);
    setLongTermTx((longTermTxRes.data ?? []) as LongTermTx[]);
    setLoading(false);
  }, [user, currentMonth, prevMonth]);

  useEffect(() => {
    load();
  }, [load]);

  // Switching which cycle is being planned can drop the current step out of
  // `steps` (e.g. jumping from the real cycle's step 3 to a future cycle,
  // which only has steps 1 and 5) — always land back on step 1 when that
  // happens.
  useEffect(() => {
    setStep(1);
  }, [monthOffset]);

  // Fills every category's draft from prevPlannedByCategory (the same data
  // step 2's recap shows) — falling back to default_monthly_budget for a
  // category with no planned amount last cycle, same as the initial-load
  // fallback above. A plain overwrite rather than "only fill blanks": it's
  // an explicit, named action ("sync from previous"), not a background
  // merge, so the whole point is giving a predictable, known starting
  // point to then adjust from.
  function syncFromPrevious() {
    setBudgetDrafts((prev) => {
      const next = { ...prev };
      for (const cat of categories) {
        next[cat.id] = String(prevPlannedByCategory[cat.id] ?? cat.default_monthly_budget ?? 0);
      }
      return next;
    });
  }

  async function saveAllBudgets() {
    if (!user || !currentMonth) return;
    setSavingBudgets(true);
    const rows = categories
      .map((cat) => {
        const amount = Number(budgetDrafts[cat.id]);
        if (Number.isNaN(amount) || amount < 0) return null;
        return { owner_id: user.id, budget_month: currentMonth, category_id: cat.id, planned_amount: amount };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0) {
      await supabase.from('monthly_budgets').upsert(rows, { onConflict: 'owner_id,budget_month,category_id' });
    }
    setSavingBudgets(false);
  }

  async function goNext() {
    if (step === 1) await saveAllBudgets();
    const idx = steps.indexOf(step);
    setStep(steps[Math.min(steps.length - 1, idx + 1)]);
  }
  function goBack() {
    const idx = steps.indexOf(step);
    setStep(steps[Math.max(0, idx - 1)]);
  }

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const dueItems: DueEntry[] = useMemo(() => {
    return longTermItems
      .map((item) => {
        const cycle = currentCycle(item, monthStartDay ?? 1);
        return {
          item,
          cycle,
          reserveDue: isReserveTransferDue(item, cycle, longTermTx, monthStartDay ?? 1),
          paymentDue: isFinalPaymentDue(item, cycle, longTermTx, monthStartDay ?? 1),
        };
      })
      .filter((entry) => entry.reserveDue || entry.paymentDue);
  }, [longTermItems, longTermTx, monthStartDay]);

  async function handleConfirmReserve(entry: DueEntry, amount: number) {
    if (!user) return;
    const accountId = entry.item.reserve_account_id ?? defaultAccountId;
    if (!accountId) return;
    setConfirmingId(entry.item.id);
    const { error } = await confirmReserveTransfer(user.id, entry.item, amount, accountId, monthStartDay ?? 1);
    setConfirmingId(null);
    if (!error) {
      setConfirmedThisSession((prev) => new Set(prev).add(entry.item.id));
      setOpenQrItemId(null);
      load();
    }
  }

  async function handleConfirmFinal(entry: DueEntry) {
    if (!user) return;
    const accountId = entry.item.reserve_account_id ?? defaultAccountId;
    if (!accountId) return;
    setConfirmingId(entry.item.id);
    const { error } = await confirmFinalPayment(
      user.id,
      entry.item,
      entry.item.full_payment_amount,
      accountId,
      monthStartDay ?? 1
    );
    setConfirmingId(null);
    if (!error) {
      setConfirmedThisSession((prev) => new Set(prev).add(entry.item.id));
      setOpenQrItemId(null);
      load();
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <LogoMark size={16} color={tokens.accent} holeColor={tokens.bg} />
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 13, letterSpacing: 1 }}>
            KASIČKA
          </Text>
        </View>
        <Link href="/(app)/planning" asChild>
          <Pressable>
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13 }}>
              {t('wizard.saveExit')}
            </Text>
          </Pressable>
        </Link>
      </View>

      <View style={styles.stepper}>
        {steps.map((n) => (
          <View
            key={n}
            style={[
              styles.stepDot,
              { backgroundColor: n <= step ? tokens.accent : tokens.cardAlt, borderColor: tokens.border },
            ]}
          />
        ))}
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, marginLeft: 8 }}>
          {t('wizard.stepLabel')} {steps.indexOf(step) + 1}/{steps.length}
        </Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
        {loading ? (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
        ) : (
          <>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 22, marginBottom: 4 }}>
              {t(`wizard.step${step}Title`)}
            </Text>
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 22 }}>
              {t(`wizard.step${step}Hint`)}
            </Text>

            {/* ── Step 1 — confirm budgets ─────────────────────────── */}
            {step === 1 && (
              <View>
                <View style={styles.monthSwitcherRow}>
                  <View style={styles.monthSwitcherLine}>
                    <View style={styles.monthSwitcher}>
                      <Pressable
                        onPress={() => setMonthOffset((v) => Math.max(0, v - 1))}
                        disabled={monthOffset === 0}
                        style={[styles.monthBtn, { backgroundColor: tokens.cardAlt, opacity: monthOffset === 0 ? 0.4 : 1 }]}
                      >
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
                      </Pressable>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15, minWidth: 170, textAlign: 'center' }}>
                        {monthLabel}
                      </Text>
                      <Pressable
                        onPress={() => setMonthOffset((v) => v + 1)}
                        style={[styles.monthBtn, { backgroundColor: tokens.cardAlt }]}
                      >
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
                      </Pressable>
                    </View>
                    <Pressable
                      onPress={syncFromPrevious}
                      disabled={categories.length === 0}
                      style={[styles.syncBtn, { backgroundColor: tokens.cardAlt, opacity: categories.length === 0 ? 0.4 : 1 }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {t('wizard.syncFromPrevious')}
                      </Text>
                    </Pressable>
                  </View>
                  {isFuturePlan && (
                    <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 11.5, marginTop: 6 }}>
                      {t('wizard.planningAhead')}
                    </Text>
                  )}
                </View>

                {categories.length === 0 && (
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
                    {t('overview.noCategoriesYet')}
                  </Text>
                )}
                {categories.map((cat) => {
                  const draftAmount = Number(budgetDrafts[cat.id]) || 0;
                  const share = budgetTotal > 0 ? Math.round((draftAmount / budgetTotal) * 100) : 0;
                  return (
                    <View
                      key={cat.id}
                      style={[styles.budgetRow, { backgroundColor: tokens.card, borderColor: tokens.border }]}
                    >
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, flex: 1 }}>
                        {cat.name}
                      </Text>
                      <TextInput
                        value={budgetDrafts[cat.id] ?? ''}
                        onChangeText={(v) => setBudgetDrafts((prev) => ({ ...prev, [cat.id]: v }))}
                        keyboardType="numeric"
                        style={[styles.budgetInput, { color: tokens.text, borderColor: tokens.border }]}
                      />
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                        {t('common.czk')}
                      </Text>
                      {budgetTotal > 0 && (
                        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, width: 34, textAlign: 'right' }}>
                          {share}%
                        </Text>
                      )}
                    </View>
                  );
                })}

                {categories.length > 0 && (
                  <View style={[styles.runningSumRow, { borderTopColor: tokens.border }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>
                      {t('wizard.runningTotal')}
                    </Text>
                    <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
                      {budgetTotal} {t('common.czk')}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* ── Step 2 — last month recap ────────────────────────── */}
            {step === 2 && (
              <View>
                <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15, marginBottom: 14 }}>
                  {prevMonthLabel}
                </Text>
                <View style={styles.cardsRow}>
                  <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                      {t('overview.income')}
                    </Text>
                    <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 18, marginTop: 4 }}>
                      +{prevIncome} {t('common.czk')}
                    </Text>
                  </View>
                  <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                      {t('overview.spent')}
                    </Text>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 18, marginTop: 4 }}>
                      −{prevSpent} {t('common.czk')}
                    </Text>
                  </View>
                  <View style={[styles.statCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                      {t('overview.net')}
                    </Text>
                    <Text
                      style={{
                        color: prevIncome - prevSpent >= 0 ? tokens.greenFg : tokens.coral,
                        fontFamily: fontFamily.bold,
                        fontSize: 18,
                        marginTop: 4,
                      }}
                    >
                      {prevIncome - prevSpent >= 0 ? '+' : ''}
                      {prevIncome - prevSpent} {t('common.czk')}
                    </Text>
                  </View>
                </View>

                <View style={{ marginTop: 22 }}>
                  {categories.map((cat) => {
                    const planned = prevPlannedByCategory[cat.id] ?? cat.default_monthly_budget ?? 0;
                    const actual = prevActualByCategory[cat.id] ?? 0;
                    const pct = planned > 0 ? Math.min(actual / planned, 1) : actual > 0 ? 1 : 0;
                    const over = planned > 0 && actual > planned;
                    return (
                      <View key={cat.id} style={{ marginBottom: 16 }}>
                        <View style={styles.budgetRowTop}>
                          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13.5 }}>
                            {cat.name}
                          </Text>
                          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>
                            {actual} / {planned} {t('common.czk')}
                          </Text>
                        </View>
                        <View style={[styles.barTrack, { backgroundColor: tokens.cardAlt }]}>
                          <View
                            style={[
                              styles.barFill,
                              { width: `${Math.round(pct * 100)}%`, backgroundColor: over ? tokens.coral : tokens.accent },
                            ]}
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* ── Step 3 — long-term & reserve overview ────────────── */}
            {step === 3 && (
              <View>
                {longTermItems.length === 0 && (
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
                    {t('more.noLongTerm')}
                  </Text>
                )}
                {longTermItems.map((item) => {
                  const cycle = currentCycle(item, monthStartDay ?? 1);
                  const { reserved, pct } = accrualProgress(item, cycle, longTermTx);
                  return (
                    <View key={item.id} style={[styles.ltCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{item.name}</Text>
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                        {categoryNameById.get(item.category_id) ?? '—'} · {t('more.longTermPaymentMonth')}{' '}
                        {cycle.paymentMonth.slice(0, 7)}
                      </Text>
                      <View style={[styles.barTrack, { backgroundColor: tokens.cardAlt, marginTop: 10 }]}>
                        <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: tokens.accent }]} />
                      </View>
                      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 4 }}>
                        {reserved} / {item.full_payment_amount} {t('common.czk')} {t('more.longTermReserved')}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── Step 4 — generate QR payments for what's due ─────── */}
            {step === 4 && (
              <View>
                {dueItems.length === 0 && (
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
                    {t('wizard.noneDue')}
                  </Text>
                )}
                {dueItems.map((entry) => {
                  const { item, cycle, reserveDue, paymentDue } = entry;
                  const reserveAmount = monthlyReserveAmount(item, cycle, longTermTx, monthStartDay ?? 1);
                  const reserveAccount = item.reserve_account_id ? accountById.get(item.reserve_account_id) ?? null : null;
                  const qrPayload = paymentDue
                    ? finalPaymentQrPayload(item)
                    : reserveTransferQrPayload(item, reserveAccount, reserveAmount);
                  const amount = paymentDue ? item.full_payment_amount : reserveAmount;
                  const open = openQrItemId === item.id;
                  const justConfirmed = confirmedThisSession.has(item.id);

                  return (
                    <View key={item.id} style={[styles.ltCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                            {item.name}
                          </Text>
                          <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12, marginTop: 2 }}>
                            {paymentDue ? t('wizard.finalPaymentLabel') : t('wizard.reserveTransferLabel')} ·{' '}
                            {amount} {t('common.czk')}
                          </Text>
                        </View>
                        {justConfirmed && (
                          <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 12 }}>✓</Text>
                        )}
                      </View>

                      {!open ? (
                        <Pressable
                          onPress={() => setOpenQrItemId(item.id)}
                          style={[styles.smallBtn, { backgroundColor: tokens.accent, marginTop: 10, alignSelf: 'flex-start' }]}
                        >
                          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                            {t('wizard.generateQr')}
                          </Text>
                        </Pressable>
                      ) : (
                        <View style={{ marginTop: 12, alignItems: 'flex-start' }}>
                          {qrPayload ? (
                            <View style={[styles.qrWhite, { marginBottom: 10 }]}>
                              <QRCode value={qrPayload} size={140} />
                            </View>
                          ) : (
                            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginBottom: 10 }}>
                              {t('wizard.noQrAvailable')}
                            </Text>
                          )}
                          <View style={{ flexDirection: 'row', gap: 8 }}>
                            <Pressable
                              onPress={() => (paymentDue ? handleConfirmFinal(entry) : handleConfirmReserve(entry, reserveAmount))}
                              disabled={confirmingId === item.id}
                              style={[
                                styles.smallBtn,
                                { backgroundColor: tokens.accent, opacity: confirmingId === item.id ? 0.6 : 1 },
                              ]}
                            >
                              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                {t('wizard.markDone')}
                              </Text>
                            </Pressable>
                            <Pressable
                              onPress={() => setOpenQrItemId(null)}
                              style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}
                            >
                              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                                {t('common.cancel')}
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── Step 5 — finish ──────────────────────────────────── */}
            {step === 5 && (
              <View>
                {!finished ? (
                  <>
                    <View style={[styles.checklistRow, { borderColor: tokens.border }]}>
                      <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 15 }}>✓</Text>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 14, marginLeft: 10 }}>
                        {t('wizard.budgetsConfirmedFor')} {monthLabel}
                      </Text>
                    </View>
                    <View style={[styles.checklistRow, { borderColor: tokens.border }]}>
                      <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 15 }}>✓</Text>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 14, marginLeft: 10 }}>
                        {confirmedThisSession.size} {t('wizard.paymentsConfirmedThisSession')}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => setFinished(true)}
                      style={[styles.primaryBtn, { backgroundColor: tokens.accent, marginTop: 24 }]}
                    >
                      <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
                        {t('wizard.finishReview')}
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <View style={[styles.claimedBox, { backgroundColor: tokens.greenBg }]}>
                    <Text style={{ color: tokens.greenFg, fontFamily: fontFamily.bold, fontSize: 16, marginBottom: 14 }}>
                      {t('wizard.reviewFinished')}
                    </Text>
                    <Link href="/(app)/planning" asChild>
                      <Pressable style={StyleSheet.flatten([styles.primaryBtn, { backgroundColor: tokens.accent }])}>
                        <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                          {t('wizard.backToPlanning')}
                        </Text>
                      </Pressable>
                    </Link>
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {!loading && !(step === 5 && finished) && (
        <View style={[styles.footer, { borderTopColor: tokens.border }]}>
          <Pressable
            onPress={goBack}
            disabled={step === 1}
            style={[styles.footerBtn, { backgroundColor: tokens.cardAlt, opacity: step === 1 ? 0.4 : 1 }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{t('wizard.back')}</Text>
          </Pressable>
          {step !== steps[steps.length - 1] && (
            <Pressable
              onPress={goNext}
              disabled={savingBudgets}
              style={[styles.footerBtn, { backgroundColor: tokens.accent, opacity: savingBudgets ? 0.6 : 1 }]}
            >
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 14 }}>
                {savingBudgets ? t('common.saving') : t('wizard.next')}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 28, paddingTop: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  stepDot: { width: 30, height: 6, borderRadius: 3, borderWidth: 1, marginRight: 6 },
  body: { paddingBottom: 40, maxWidth: 620, width: '100%', alignSelf: 'center' },
  budgetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  budgetInput: { width: 90, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, textAlign: 'right' },
  monthSwitcherRow: { marginBottom: 14 },
  monthSwitcherLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 },
  monthSwitcher: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  monthBtn: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  syncBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9 },
  runningSumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 6,
  },
  budgetRowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  barTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  cardsRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  statCard: { flex: 1, minWidth: 130, borderWidth: 1, borderRadius: 14, padding: 14 },
  ltCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 9 },
  qrWhite: { backgroundColor: '#ffffff', padding: 10, borderRadius: 10, alignSelf: 'flex-start' },
  checklistRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 10 },
  primaryBtn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  claimedBox: { padding: 20, borderRadius: 16, alignItems: 'center' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 16,
    borderTopWidth: 1,
    maxWidth: 620,
    width: '100%',
    alignSelf: 'center',
  },
  footerBtn: { flex: 1, paddingVertical: 13, borderRadius: 10, alignItems: 'center' },
});
