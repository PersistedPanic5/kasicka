import { supabase } from '@/lib/supabase';
import { budgetMonthForDate } from '@/lib/budget-month';
import type { RecurringItem } from '@/types/database';

/**
 * Recurring items — build-roadmap-v1.md Phase 2 "suggest, you confirm"
 * model (core-app-requirements.md: "New app should define a recurring
 * expense once ... and have it auto-generate/appear each month instead of
 * manual re-entry" — but never auto-*posts*; see architecture-v1.md
 * "Recurring items").
 *
 * Due-ness is computed client-side, from the same data the More screen
 * already has loaded — no separate endpoint needed for the in-app banner.
 * The daily check-recurring-due Edge Function (supabase/functions/) runs
 * the same "is this due and not yet confirmed" logic server-side, but only
 * to decide whether to send a push notification — it never writes a
 * transaction itself, matching the same review-before-it-counts rule.
 *
 * `day_of_month` (1–28, per the schema's check constraint — chosen so it's
 * always a valid day regardless of month length) is the only date signal
 * recurring_items carries. That's enough for MONTHLY items (due once
 * per calendar month, from day_of_month onward, until confirmed). YEARLY
 * items have no month column in the schema — only day_of_month — so
 * "due" for one means "not yet confirmed at all this calendar year",
 * surfaced every year from day_of_month onward. That's a real limitation
 * (a YEARLY item confirmed late one year will show early every year after
 * unless its confirm date happens to land after day_of_month again) —
 * acceptable for now since the precise annual-payment case is what
 * long_term_items (Phase 3) is actually for; recurring_items' YEARLY option
 * is a lighter-weight fallback, not the primary annual-bill feature.
 */

/** A transaction row shaped just enough to check which recurring items it
 * already confirmed — pass in whatever's already loaded, no extra query
 * needed if the caller already has this month's transactions. */
export interface ConfirmedRecurringTx {
  recurring_item_id: string | null;
  transaction_date: string; // 'yyyy-mm-dd'
}

export function computeDueRecurringItems(
  items: RecurringItem[],
  confirmedTransactions: ConfirmedRecurringTx[],
  today: Date = new Date()
): RecurringItem[] {
  const todayDay = today.getDate();
  const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const currentYear = today.getFullYear();

  const confirmedDatesByItem = new Map<string, string[]>();
  for (const tx of confirmedTransactions) {
    if (!tx.recurring_item_id) continue;
    const dates = confirmedDatesByItem.get(tx.recurring_item_id) ?? [];
    dates.push(tx.transaction_date);
    confirmedDatesByItem.set(tx.recurring_item_id, dates);
  }

  return items.filter((item) => {
    if (!item.active) return false;
    if (todayDay < item.day_of_month) return false;
    const dates = confirmedDatesByItem.get(item.id) ?? [];
    if (item.frequency === 'MONTHLY') {
      return !dates.some((d) => d.slice(0, 7) === currentMonthKey);
    }
    return !dates.some((d) => new Date(d).getFullYear() === currentYear);
  });
}

/**
 * Turns a due suggestion into a real transaction — the one and only write
 * this module does. `amount` defaults to the recurring item's own amount
 * but can be overridden (a price change, say) without editing the
 * recurring item itself.
 */
export async function confirmRecurringItem(
  ownerId: string,
  item: RecurringItem,
  amount?: number,
  monthStartDay: number = 1
): Promise<{ error: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('transactions').insert({
    owner_id: ownerId,
    budget_month: budgetMonthForDate(today, monthStartDay),
    transaction_date: today,
    type: 'EXPENSE',
    category_id: item.category_id,
    account_id: item.account_id,
    amount: amount ?? item.amount,
    note: item.name,
    source: 'RECURRING',
    recurring_item_id: item.id,
  });
  return { error: error?.message ?? null };
}
