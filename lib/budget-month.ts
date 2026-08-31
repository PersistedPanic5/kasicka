/**
 * Shared "budget month" math — core-app-requirements.md "Keep custom
 * budget-month start day": `profile.month_start_day` (schema: int, 1–28,
 * default 1 — see supabase/migrations/0001_initial_schema.sql) lets the
 * budget cycle start on a day other than the 1st, e.g. tied to when a
 * salary lands, instead of always following the calendar month.
 *
 * Every place that buckets a transaction or a monthly_budgets row into a
 * month (ExpenseEntryForm, Overview, the monthly wizard, and the
 * recurring/debt-settlement/long-term "confirm" writes) goes through the
 * helpers here so they can never drift out of sync with each other.
 *
 * The bucket is still stored and keyed exactly as before — `budget_month`
 * = 'yyyy-mm-01', the calendar month the cycle STARTS in — only which
 * calendar dates map to which bucket changes. With month_start_day = 1
 * (the schema default) `budgetMonthForDate` returns byte-for-byte the same
 * label as a plain calendar month, so nothing already stored needs to
 * change and nothing breaks for anyone who never touches the setting.
 *
 * Deliberately NOT used by recurring_items' `day_of_month` (a calendar-day
 * trigger for "is this bill due yet") or long_term_items' reserve-cycle
 * math in lib/long-term.ts (`payment_month` / `first_reserve_month`,
 * always whole calendar months) — those are separate business rules from
 * "which budget-month bucket does this transaction's amount count
 * towards," which is all this file is about.
 */

export type BudgetMonthLabel = string; // 'yyyy-mm-01'

export const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTH_NAMES_CS = [
  'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
];
const MONTH_SHORT_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Which budget-month bucket a given calendar date ('yyyy-mm-dd') falls
 * into: its own calendar month once the date is on/after startDay,
 * otherwise the previous calendar month (the cycle that started last
 * month and is still running). */
export function budgetMonthForDate(dateStr: string, startDay: number): BudgetMonthLabel {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  if (d >= startDay) return `${y}-${String(m).padStart(2, '0')}-01`;
  const total = y * 12 + (m - 1) - 1;
  const py = Math.floor(total / 12);
  const pm = (total % 12) + 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

/** The budget-month bucket that contains "right now". */
export function currentBudgetMonth(startDay: number, today: Date = new Date()): BudgetMonthLabel {
  return budgetMonthForDate(today.toISOString().slice(0, 10), startDay);
}

/** Adds `n` budget-month cycles to a label — plain calendar-month
 * arithmetic works here since a label is always the 1st of a month. */
export function shiftBudgetMonth(label: BudgetMonthLabel, n: number): BudgetMonthLabel {
  const [y, m] = label.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** Human label for a budget-month bucket: a plain month name when the
 * cycle matches the calendar (startDay 1, the common case — matches the
 * app's original month-switcher label exactly), or an explicit day range
 * once it doesn't, so it's never ambiguous which real dates a bucket
 * covers (e.g. "Aug 25 – Sep 24, 2026"). */
export function formatBudgetMonthLabel(label: BudgetMonthLabel, startDay: number, language: 'en' | 'cs'): string {
  const [y, m] = label.split('-').map(Number);
  const names = language === 'cs' ? MONTH_NAMES_CS : MONTH_NAMES_EN;
  if (startDay <= 1) return `${names[m - 1]} ${y}`;

  const endLabel = shiftBudgetMonth(label, 1);
  const [ey, em] = endLabel.split('-').map(Number);
  const endDay = startDay - 1;

  if (language === 'cs') {
    return `${startDay}. ${m}. – ${endDay}. ${em}. ${ey}`;
  }
  return `${MONTH_SHORT_EN[m - 1]} ${startDay} – ${MONTH_SHORT_EN[em - 1]} ${endDay}, ${ey}`;
}
