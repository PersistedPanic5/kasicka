// fetch-exchange-rate — on-demand ČNB (Czech National Bank) daily
// exchange-rate fetch + cache, called from the app itself (unlike
// check-recurring-due, which only ever runs on a schedule) — see
// lib/exchange-rates.ts, Settings → Currencies, and Record Expense's
// currency picker.
//
// Why this has to be an Edge Function rather than a plain client-side
// fetch: ČNB's site doesn't set CORS headers for cross-origin browser
// requests, so kasicka.eu calling it directly from the browser would just
// fail — this function does the actual HTTP call server-to-server (no CORS
// involved) and writes the result into `exchange_rates` with the service
// role (bypasses RLS — see supabase/migrations/0007_currencies.sql, which
// only grants authenticated *read* access to that table).
//
// Source: ČNB's plain-text daily fixing file, documented at
// https://www.cnb.cz/en/faq/Format-of-the-foreign-exchange-market-rates/ —
// pipe-delimited, one row per currency, first line is the date the file
// was actually published for ("DD.Mon.YYYY  #N", e.g. "03.Sep.2026 #172").
// No auth required — this is the long-standing public integration point
// (distinct from the newer OAuth-gated developers.cnb.cz API portal, which
// this deliberately does NOT use, to avoid needing Pavel to register an
// app there for what's otherwise a two-line HTTP GET).
//
// Two request shapes (POST body):
//   { mode: 'lookup', currency: 'PLN', date: '2026-09-03' }
//     Resolves the rate for that currency on/before that date — walks
//     backward a day at a time (up to 10 days) if ČNB has nothing for the
//     requested date itself (weekends/bank holidays: "use the last
//     previous working day", the accounting rule Pavel asked for), caching
//     EVERY currency from whichever day's file actually answers it (so a
//     later lookup for a different tracked currency on the same date is
//     free). Returns the resolved rate for the requested currency.
//   { mode: 'range', fromDate: 'yyyy-mm-dd', toDate: 'yyyy-mm-dd' }
//     Bulk-backfills every calendar day in the (inclusive) range — one
//     ČNB request per day, no backward-walking (a day with nothing
//     published is just skipped; reads fall back to the nearest earlier
//     cached row on their own, same as the lookup mode's cache reads do).
//     Used by Settings → Currencies' date-range "Download & save" button.
//     Every currency found each day is stored, not just tracked ones, so
//     tracking a new currency later doesn't require re-backfilling ranges
//     already downloaded.

import { createClient } from 'npm:@supabase/supabase-js@2.55.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MONTH_ABBR: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

interface ParsedRow {
  code: string;
  amount: number;
  rate: number;
}

interface ParsedFile {
  headerDate: string; // 'yyyy-mm-dd'
  rows: ParsedRow[];
}

function parseDailyTxt(text: string): ParsedFile | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const dateMatch = lines[0].match(/^(\d{2})\.(\w{3})\.(\d{4})/);
  if (!dateMatch) return null;
  const [, dd, monAbbr, yyyy] = dateMatch;
  const mm = MONTH_ABBR[monAbbr];
  if (!mm) return null;
  const headerDate = `${yyyy}-${mm}-${dd}`;

  const rows: ParsedRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.includes('|')) continue;
    const parts = line.split('|');
    if (parts.length !== 5) continue;
    const [, , amountStr, code, rateStr] = parts;
    if (!code || code === 'Code') continue; // header/blank-section row
    const amount = Number(amountStr);
    const rate = Number(rateStr);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(rate) || rate <= 0) continue;
    rows.push({ code: code.trim().toUpperCase(), amount, rate });
  }
  if (rows.length === 0) return null;
  return { headerDate, rows };
}

function toCnbDateParam(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchCnbDailyFile(dateStr: string): Promise<ParsedFile | null> {
  const url = `https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt?date=${toCnbDateParam(dateStr)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return parseDailyTxt(await res.text());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }

  async function storeRows(rateDate: string, rows: ParsedRow[]) {
    const upserts = rows.map((r) => ({
      currency_code: r.code,
      rate_date: rateDate,
      amount_unit: r.amount,
      rate: r.rate,
    }));
    await supabase.from('exchange_rates').upsert(upserts, { onConflict: 'currency_code,rate_date' });
  }

  if (body.mode === 'lookup') {
    const currency = String(body.currency ?? '').toUpperCase();
    const date = String(body.date ?? '');
    if (!currency || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'lookup requires currency + date (yyyy-mm-dd)' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      });
    }

    let cursor = date;
    for (let attempt = 0; attempt < 10; attempt++) {
      const parsed = await fetchCnbDailyFile(cursor);
      if (parsed) {
        await storeRows(parsed.headerDate, parsed.rows);
        const match = parsed.rows.find((r) => r.code === currency);
        if (!match) {
          return new Response(JSON.stringify({ error: `ČNB doesn't list currency ${currency}` }), {
            status: 404,
            headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            currency,
            resolvedDate: parsed.headerDate,
            amountUnit: match.amount,
            rate: match.rate,
          }),
          { headers: { ...CORS_HEADERS, 'content-type': 'application/json' } }
        );
      }
      cursor = shiftDate(cursor, -1);
    }
    return new Response(
      JSON.stringify({ error: `No ČNB fixing found in the 10 days up to ${date}` }),
      { status: 502, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } }
    );
  }

  if (body.mode === 'range') {
    const fromDate = String(body.fromDate ?? '');
    const toDate = String(body.toDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) {
      return new Response(JSON.stringify({ error: 'range requires fromDate <= toDate (yyyy-mm-dd)' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      });
    }
    // Guard against an accidentally huge range (e.g. a typo'd year) turning
    // into thousands of sequential requests.
    const MAX_DAYS = 800;
    let daysRequested = 0;
    let daysStored = 0;
    const currenciesSeen = new Set<string>();
    let cursor = fromDate;
    while (cursor <= toDate && daysRequested < MAX_DAYS) {
      daysRequested++;
      const parsed = await fetchCnbDailyFile(cursor);
      if (parsed) {
        await storeRows(parsed.headerDate, parsed.rows);
        daysStored++;
        for (const r of parsed.rows) currenciesSeen.add(r.code);
      }
      cursor = shiftDate(cursor, 1);
    }
    return new Response(
      JSON.stringify({ daysRequested, daysStored, currencies: Array.from(currenciesSeen).sort() }),
      { headers: { ...CORS_HEADERS, 'content-type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ error: "mode must be 'lookup' or 'range'" }), {
    status: 400,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
});
