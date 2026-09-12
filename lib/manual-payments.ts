import { supabase } from '@/lib/supabase';
import { czechIBAN, buildSpdPayload } from '@/lib/czech-qr-payment';
import { budgetMonthForDate } from '@/lib/budget-month';
import type { ManualPayment, Payee } from '@/types/database';

/**
 * Payments → one-off payments (migration 0014). Pavel's use case: he gets
 * a bare account number and an amount by text and just needs a QR to scan
 * in his own banking app, instead of typing it all in there by hand. This
 * module is the same shape as lib/long-term.ts's QR-payload-builder +
 * confirm pair, just for a single ad-hoc payment with no reserve/cycle
 * math attached to it, plus the "who have I paid this way before" payee
 * lookup that feature doesn't need.
 */

/** Builds the SPD QR payload for a pending one-off payment. */
export function manualPaymentQrPayload(
  payee: Payee,
  amount: number,
  message: string | null,
  variableSymbol: string | null
): string {
  const iban = czechIBAN(payee.target_bank_code, payee.target_account_number, payee.target_account_prefix);
  return buildSpdPayload({ iban, amount, message: message?.trim() || payee.name, variableSymbol: variableSymbol ?? undefined });
}

/** Finds an existing payee by bank ACCOUNT (not name — see migration
 * 0014's doc comment: paying the same account under a slightly different
 * typed name should still land on one person), refreshing the display
 * name to whatever was just typed, or creates a new payee if this account
 * hasn't been paid before. */
export async function findOrCreatePayee(
  ownerId: string,
  name: string,
  bankCode: string,
  accountNumber: string,
  accountPrefix: string | null
): Promise<{ id: string | null; error: string | null }> {
  let query = supabase
    .from('payees')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('target_bank_code', bankCode)
    .eq('target_account_number', accountNumber);
  query = accountPrefix ? query.eq('target_account_prefix', accountPrefix) : query.is('target_account_prefix', null);
  const { data: existing } = await query.maybeSingle();

  if (existing) {
    await supabase.from('payees').update({ name }).eq('id', existing.id);
    return { id: existing.id, error: null };
  }

  const { data: created, error } = await supabase
    .from('payees')
    .insert({
      owner_id: ownerId,
      name,
      target_bank_code: bankCode,
      target_account_number: accountNumber,
      target_account_prefix: accountPrefix,
    })
    .select('id')
    .single();
  return { id: created?.id ?? null, error: error?.message ?? null };
}

/** Confirms a pending one-off payment: posts it as a real EXPENSE
 * transaction (source MANUAL_PAYMENT), bumps the payee's last_paid_at for
 * the "people you've paid" list's sort order, and clears the pending row
 * — Pavel's choice was no separate "paid" history for this feature, so
 * that transaction is the permanent record from here on, same as anything
 * else he logs. */
export async function confirmManualPayment(
  ownerId: string,
  payment: ManualPayment,
  payeeName: string,
  monthStartDay: number = 1
): Promise<{ error: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('transactions').insert({
    owner_id: ownerId,
    budget_month: budgetMonthForDate(today, monthStartDay),
    transaction_date: today,
    type: 'EXPENSE',
    category_id: payment.category_id,
    account_id: payment.account_id,
    amount: payment.amount,
    note: payment.message?.trim() || payeeName,
    source: 'MANUAL_PAYMENT',
  });
  if (error) return { error: error.message };

  await supabase.from('payees').update({ last_paid_at: new Date().toISOString() }).eq('id', payment.payee_id);
  await supabase.from('manual_payments').delete().eq('id', payment.id);
  return { error: null };
}
