import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import type { BankTransaction } from '@/types/database';

/** "−486 Kč" / "+48 200 Kč" — signed, thousands separated like the Czech design. */
export function formatKc(amount: number, signed = true): string {
  const abs = Math.abs(amount).toLocaleString('cs-CZ', { maximumFractionDigits: 2 });
  const sign = !signed ? '' : amount < 0 ? '−' : '+';
  return `${sign}${abs} Kč`;
}

/** Today / Yesterday / 11.10. — `t` is the language-context lookup. */
export function dayLabel(iso: string, t: (path: string) => string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
  const now = Date.now();
  if (iso === day(new Date(now))) return t('bank.today');
  if (iso === day(new Date(now - 86_400_000))) return t('bank.yesterday');
  return `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;
}

/** Rows the normal "pick a category" card applies to (not own transfers / cash moves). */
export const isPlain = (b: Pick<BankTransaction, 'kind'>) => b.kind === 'EXPENSE' || b.kind === 'INCOME';

/** Column list for queries — everything but the raw-ish fields we never show. */
export const BANK_COLUMNS =
  'id, account_id, movement_id, booked_date, amount, merchant, merchant_key, movement_type, details, kind, suggested_category_id, suggested_uses, suggested_account_id, recurring_item_id, match_transaction_id, status, transaction_id, to_account_id, matched_debt_id, created_at';

/**
 * Whether the user has any account in Bank inbox mode, and how many
 * movements are waiting — drives the nav item, the "Bank 3" badge and the
 * Home banner. A missing table (migration 0017 not run yet) or any other
 * error just reads as "not enabled", so nothing breaks before the setup.
 */
export function useBankPending(): { enabled: boolean; count: number; refresh: () => void } {
  const { user } = useAuth();
  const [state, setState] = useState({ enabled: false, count: 0 });

  const refresh = useCallback(() => {
    if (!user) return;
    Promise.all([
      supabase.from('accounts').select('id', { count: 'exact', head: true }).eq('entry_mode', 'BANK_INBOX'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('status', 'NEW'),
    ]).then(([acc, pending]) => {
      if (acc.error || pending.error) return setState({ enabled: false, count: 0 });
      setState({ enabled: (acc.count ?? 0) > 0, count: pending.count ?? 0 });
    });
  }, [user]);

  useEffect(refresh, [refresh]);
  return { ...state, refresh };
}

/** Ask the server to pull new movements from Fio now (also settles debts). */
export async function syncBank(): Promise<{ added: number; throttled: boolean; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('check-fio-payments', { body: {} });
  const status = (error as { context?: { status?: number } } | null)?.context?.status;
  const problem = error ? (status ? `http_${status}` : 'no response — is check-fio-payments deployed?') : (data?.errors?.[0] ?? null);
  return { added: data?.added ?? 0, throttled: !!data && !data.checked && (data.throttled ?? 0) > 0, error: problem };
}
