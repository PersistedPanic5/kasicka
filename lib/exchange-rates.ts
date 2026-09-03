import { supabase } from '@/lib/supabase';

/**
 * Multi-currency support (Pavel's request, September 2026): record an
 * expense in a foreign currency and have it converted to and stored as
 * CZK, with the original amount/currency/rate kept on the transaction for
 * reference. See supabase/migrations/0007_currencies.sql,
 * supabase/functions/fetch-exchange-rate, Settings → Currencies, and
 * Record Expense's currency picker.
 *
 * The rate source is ČNB's (Czech National Bank) daily fixing — one row
 * per currency per date it was actually published (weekends/bank holidays
 * have no row at all, deliberately: `getCachedRate` below reads the most
 * recent row on/before the requested date, which is exactly "use the last
 * previous working day" without ever storing a synthetic/duplicate row).
 */

/** Common ČNB-quoted currencies, for the Settings → Currencies picker.
 * Not exhaustive of everything ČNB ever lists — just the commonly-traded
 * set most people would actually pick from — but any ISO code works, since
 * the Edge Function stores whatever ČNB returns regardless of whether it's
 * in this list. Pavel's own list: EUR, USD, PLN, HUF. */
export const COMMON_CURRENCIES: { code: string; name: string }[] = [
  { code: 'EUR', name: 'Euro' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'PLN', name: 'Polish Zloty' },
  { code: 'HUF', name: 'Hungarian Forint' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'RON', name: 'Romanian Leu' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CNY', name: 'Chinese Renminbi' },
];

export interface ResolvedRate {
  currency: string;
  /** The date this rate was actually published for — may be earlier than
   * what was asked for (weekend/holiday fallback). */
  resolvedDate: string;
  amountUnit: number;
  rate: number;
}

/** How many days back a cached row may be and still count as "the rate for
 * this date" — covers a normal long weekend/holiday run without silently
 * reusing a rate that's gone stale because nothing was ever downloaded. */
const MAX_CACHE_STALENESS_DAYS = 12;

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** Reads the cache only — never calls the Edge Function. Returns null on a
 * miss (nothing on/before `date` within MAX_CACHE_STALENESS_DAYS). */
export async function getCachedRate(currency: string, date: string): Promise<ResolvedRate | null> {
  const { data } = await supabase
    .from('exchange_rates')
    .select('currency_code, rate_date, amount_unit, rate')
    .eq('currency_code', currency.toUpperCase())
    .lte('rate_date', date)
    .order('rate_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  if (daysBetween(data.rate_date, date) > MAX_CACHE_STALENESS_DAYS) return null;
  return { currency: data.currency_code, resolvedDate: data.rate_date, amountUnit: data.amount_unit, rate: data.rate };
}

/** Cache-first rate lookup for a single currency/date — the one Record
 * Expense's currency picker and the "check daily values" Settings action
 * call. Falls through to the fetch-exchange-rate Edge Function (a real
 * ČNB call) only on a cache miss, and only that one date/currency pair —
 * this is deliberately NOT a bulk downloader, per Pavel's "mostly I won't
 * need to download it all" — most calls should just hit the cache, since
 * every transaction saved in a currency also caches that day's rate. */
/** supabase-js's `error.message` for a non-2xx Edge Function response is
 * always the generic "Edge Function returned a non-2xx status code" — the
 * function's own JSON error body (the actually useful part) is only
 * reachable via `error.context`, a raw Response, on `FunctionsHttpError`.
 * Falls back to the generic message when there's no readable body (a
 * network-level FunctionsFetchError/FunctionsRelayError, for instance). */
async function readFunctionErrorMessage(error: { message: string; context?: unknown }): Promise<string> {
  const context = error.context as Response | undefined;
  if (context && typeof context.text === 'function') {
    try {
      const bodyText = await context.text();
      try {
        const body = JSON.parse(bodyText);
        if (body?.error) return `${body.error} (status ${context.status})`;
      } catch {
        if (bodyText) return `${bodyText.slice(0, 200)} (status ${context.status})`;
      }
    } catch {
      // ignore — fall through to the generic message below
    }
  }
  return error.message;
}

export async function ensureRate(currency: string, date: string): Promise<{ rate: ResolvedRate | null; error: string | null }> {
  const cached = await getCachedRate(currency, date);
  if (cached) return { rate: cached, error: null };

  const { data, error } = await supabase.functions.invoke('fetch-exchange-rate', {
    body: { mode: 'lookup', currency: currency.toUpperCase(), date },
  });
  if (error) return { rate: null, error: await readFunctionErrorMessage(error) };
  if (!data || data.error) return { rate: null, error: data?.error ?? 'Unknown error' };
  return {
    rate: { currency: data.currency, resolvedDate: data.resolvedDate, amountUnit: data.amountUnit, rate: data.rate },
    error: null,
  };
}

/** Bulk-backfills a date range — Settings → Currencies' "Download & save"
 * button. Always a live call (that's the point of an explicit button). */
export async function downloadRateRange(
  fromDate: string,
  toDate: string
): Promise<{ daysRequested: number; daysStored: number; currencies: string[] } | { error: string }> {
  const { data, error } = await supabase.functions.invoke('fetch-exchange-rate', {
    body: { mode: 'range', fromDate, toDate },
  });
  if (error) return { error: await readFunctionErrorMessage(error) };
  if (!data || data.error) return { error: data?.error ?? 'Unknown error' };
  return data;
}

/** original_amount (in `currency`) converted to CZK at `rate` — always
 * amount / amountUnit * rate, since ČNB quotes some currencies (HUF, JPY,
 * ...) per 100 units rather than per 1. */
export function toCzk(amount: number, rate: ResolvedRate): number {
  return Math.round((amount / rate.amountUnit) * rate.rate * 100) / 100;
}
