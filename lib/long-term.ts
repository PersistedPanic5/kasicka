import { supabase } from '@/lib/supabase';
import { czechIBAN, buildSpdPayload } from '@/lib/czech-qr-payment';
import { budgetMonthForDate } from '@/lib/budget-month';
import type { Account, LongTermItem } from '@/types/database';

/**
 * Long-term/reserve payment math — build-roadmap-v1.md Phase 3, ported from
 * the old app's `calculateMonthlyReserveAmount_` (see
 * budgetor-current-app-analysis.md "Feature: long-term/reserve payments").
 *
 * The idea: for a big annual bill (car insurance, say), you don't want the
 * full amount to hit your spending in one month. Each month between
 * first_reserve_month and payment_month, a slice of the total gets set
 * aside as a RESERVE_TRANSFER into a reserve account; in payment_month
 * itself, a PAYMENT_FROM_RESERVE transaction draws the reserve down to
 * (nominally) zero to actually pay the bill. Both transaction types are
 * generated from the monthly wizard's QR step (app/wizard.tsx), tagged
 * `source: 'LONG_TERM_QR'` and linked via `long_term_item_id` (see
 * supabase/migrations/0005_long_term_links.sql) so this module can always
 * answer "how much has been reserved so far, and is this month's step
 * already done" precisely.
 *
 * `repeat_yearly` items roll forward automatically: once today is past a
 * cycle's payment_month, the *effective* cycle for "now" is the next
 * occurrence (payment_month + 12 months), with its first_reserve_month
 * recomputed as 11 months before that — matching the old app's rule
 * ("the reserving window rolls automatically to 11 months before the next
 * payment month once the previous cycle's payment has passed"). A
 * non-repeating item just keeps its stored dates — it's a one-off, meant
 * to be archived once paid.
 *
 * `opening_reserve_balance` is a one-time seed (money already set aside
 * before you started tracking this item) — it only counts toward the
 * *original* stored cycle, never toward a rolled-forward one, or every
 * future year would double-count it.
 */

export type BudgetMonth = string; // 'yyyy-mm-01'

function toMonthStart(dateStr: string): BudgetMonth {
  return `${dateStr.slice(0, 7)}-01`;
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** Adds `n` calendar months to a 'yyyy-mm-01'-shaped string. */
function addMonths(monthStart: BudgetMonth, n: number): BudgetMonth {
  const [y, m] = monthStart.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const newY = Math.floor(total / 12);
  const newM = (total % 12) + 1;
  return `${newY}-${String(newM).padStart(2, '0')}-01`;
}

/** Whole calendar months from `a` to `b` (b - a), both 'yyyy-mm-01'. */
function monthDiff(a: BudgetMonth, b: BudgetMonth): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by * 12 + (bm - 1)) - (ay * 12 + (am - 1));
}

export interface ReserveCycle {
  firstReserveMonth: BudgetMonth;
  paymentMonth: BudgetMonth;
  /** True once this cycle has rolled forward past the item's originally
   * stored dates — opening_reserve_balance no longer applies. */
  rolled: boolean;
}

/** The effective reserve window for "right now" — handles repeat_yearly
 * rolling forward past a completed cycle.
 *
 * `monthStartDay` matters here: "right now" means the budget-month cycle
 * you're actually in (lib/budget-month.ts), not the raw calendar month. If
 * your period cuts over on the 10th, September 3rd is still budget-month
 * "August" — a repeat_yearly item shouldn't roll forward, and (more
 * visibly) isReserveTransferDue/isFinalPaymentDue below shouldn't fire,
 * just because the calendar flipped to September a few days early. This
 * reverses an earlier, deliberate choice to keep long-term math on pure
 * calendar months (see the historical note in lib/budget-month.ts) — Pavel
 * confirmed the budget-month cycle is what should govern "is this due
 * yet," matching how he actually thinks about "still being in August." */
export function currentCycle(item: LongTermItem, monthStartDay: number = 1, today: Date = new Date()): ReserveCycle {
  const todayMonth = budgetMonthForDate(today.toISOString().slice(0, 10), monthStartDay);
  let paymentMonth = toMonthStart(item.payment_month);
  let firstReserveMonth = toMonthStart(item.first_reserve_month);
  let rolled = false;

  if (item.repeat_yearly) {
    while (monthKey(todayMonth) > monthKey(paymentMonth)) {
      paymentMonth = addMonths(paymentMonth, 12);
      firstReserveMonth = addMonths(paymentMonth, -11);
      rolled = true;
    }
  }

  return { firstReserveMonth, paymentMonth, rolled };
}

export interface LongTermTx {
  long_term_item_id: string | null;
  type: 'RESERVE_TRANSFER' | 'PAYMENT_FROM_RESERVE' | string;
  amount: number;
  transaction_date: string;
}

/** Total reserved toward this item's *current* cycle so far — opening
 * balance (only on an unrolled cycle) plus every RESERVE_TRANSFER posted
 * within the cycle's window. Used for the accrual progress bar. */
export function reservedSoFar(item: LongTermItem, cycle: ReserveCycle, transactions: LongTermTx[]): number {
  const opening = cycle.rolled ? 0 : item.opening_reserve_balance;
  const transferred = transactions
    .filter(
      (tx) =>
        tx.long_term_item_id === item.id &&
        tx.type === 'RESERVE_TRANSFER' &&
        monthKey(tx.transaction_date) >= monthKey(cycle.firstReserveMonth) &&
        monthKey(tx.transaction_date) < monthKey(cycle.paymentMonth)
    )
    .reduce((sum, tx) => sum + Number(tx.amount), 0);
  return opening + transferred;
}

export function accrualProgress(
  item: LongTermItem,
  cycle: ReserveCycle,
  transactions: LongTermTx[]
): { reserved: number; pct: number } {
  const reserved = reservedSoFar(item, cycle, transactions);
  const pct = item.full_payment_amount > 0 ? Math.max(0, Math.min(reserved / item.full_payment_amount, 1)) : 0;
  return { reserved, pct };
}

/** How much this month's reserve transfer should be, per reserve_amount_mode. */
export function monthlyReserveAmount(
  item: LongTermItem,
  cycle: ReserveCycle,
  transactions: LongTermTx[],
  monthStartDay: number = 1
): number {
  if (item.reserve_amount_mode === 'MANUAL') {
    return item.manual_monthly_reserve ?? 0;
  }
  const { reserved } = accrualProgress(item, cycle, transactions);
  const remaining = Math.max(0, item.full_payment_amount - reserved);
  const today = budgetMonthForDate(new Date().toISOString().slice(0, 10), monthStartDay);
  const monthsLeft = Math.max(1, monthDiff(today, cycle.paymentMonth));
  return Math.round((remaining / monthsLeft) * 100) / 100;
}

/** monthStartDay (default 1) makes "this month" mean the current
 * budget-month cycle, not the raw calendar month — see currentCycle's
 * comment above for why that's the correct behavior. */
export function isReserveTransferDue(
  item: LongTermItem,
  cycle: ReserveCycle,
  transactions: LongTermTx[],
  monthStartDay: number = 1,
  today: Date = new Date()
): boolean {
  if (!item.active) return false;
  const currentMonth = budgetMonthForDate(today.toISOString().slice(0, 10), monthStartDay);
  const inWindow = monthKey(currentMonth) >= monthKey(cycle.firstReserveMonth) && monthKey(currentMonth) < monthKey(cycle.paymentMonth);
  if (!inWindow) return false;
  const alreadyDone = transactions.some(
    (tx) => tx.long_term_item_id === item.id && tx.type === 'RESERVE_TRANSFER' && monthKey(tx.transaction_date) === monthKey(currentMonth)
  );
  return !alreadyDone;
}

export function isFinalPaymentDue(
  item: LongTermItem,
  cycle: ReserveCycle,
  transactions: LongTermTx[],
  monthStartDay: number = 1,
  today: Date = new Date()
): boolean {
  if (!item.active) return false;
  const currentMonth = budgetMonthForDate(today.toISOString().slice(0, 10), monthStartDay);
  if (monthKey(currentMonth) !== monthKey(cycle.paymentMonth)) return false;
  const alreadyDone = transactions.some(
    (tx) => tx.long_term_item_id === item.id && tx.type === 'PAYMENT_FROM_RESERVE' && monthKey(tx.transaction_date) === monthKey(currentMonth)
  );
  return !alreadyDone;
}

/** Builds the QR payload for this month's reserve transfer — null when the
 * reserve account has no Czech bank details (e.g. it's a Cash account),
 * in which case the wizard just shows a plain "log it" action. */
export function reserveTransferQrPayload(item: LongTermItem, reserveAccount: Account | null, amount: number): string | null {
  if (!reserveAccount?.account_number || !reserveAccount.bank_code) return null;
  const iban = czechIBAN(reserveAccount.bank_code, reserveAccount.account_number, reserveAccount.account_prefix);
  return buildSpdPayload({ iban, amount, message: `${item.name} reserve` });
}

/** Builds the QR payload for the final annual payment — null when no
 * external payee bank details are set on the item. */
export function finalPaymentQrPayload(item: LongTermItem): string | null {
  if (!item.target_account_number || !item.target_bank_code) return null;
  const iban = czechIBAN(item.target_bank_code, item.target_account_number, item.target_account_prefix);
  return buildSpdPayload({
    iban,
    amount: item.full_payment_amount,
    message: item.payment_message ?? item.name,
    variableSymbol: item.variable_symbol ?? undefined,
  });
}

/** Posts this month's reserve transfer (or the final draw-down payment) as
 * a real transaction — the only writes this module does. Mirrors
 * lib/recurring.ts's confirmRecurringItem: a person always triggers this,
 * never a background job. */
export async function confirmReserveTransfer(
  ownerId: string,
  item: LongTermItem,
  amount: number,
  accountId: string,
  monthStartDay: number = 1
): Promise<{ error: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('transactions').insert({
    owner_id: ownerId,
    budget_month: budgetMonthForDate(today, monthStartDay),
    transaction_date: today,
    type: 'RESERVE_TRANSFER',
    category_id: item.category_id,
    account_id: accountId,
    amount,
    note: `${item.name} — reserve`,
    source: 'LONG_TERM_QR',
    long_term_item_id: item.id,
  });
  return { error: error?.message ?? null };
}

export async function confirmFinalPayment(
  ownerId: string,
  item: LongTermItem,
  amount: number,
  accountId: string,
  monthStartDay: number = 1
): Promise<{ error: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('transactions').insert({
    owner_id: ownerId,
    budget_month: budgetMonthForDate(today, monthStartDay),
    transaction_date: today,
    type: 'PAYMENT_FROM_RESERVE',
    category_id: item.category_id,
    account_id: accountId,
    amount,
    note: item.name,
    source: 'LONG_TERM_QR',
    long_term_item_id: item.id,
  });
  return { error: error?.message ?? null };
}
