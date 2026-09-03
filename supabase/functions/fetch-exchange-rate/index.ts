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

  // Real header, confirmed from a live response: "13 Aug 2026 #155" — a
  // space-separated "D Mon YYYY  #N" with NO leading zero on single-digit
  // days (e.g. today would be "3 Sep 2026 #172"), not the dotted
  // "DD.Mon.YYYY" this was originally (and wrongly) written against before
  // ever seeing a real response.
  const dateMatch = lines[0].match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!dateMatch) return null;
  const [, dd, monAbbr, yyyy] = dateMatch;
  const mm = MONTH_ABBR[monAbbr];
  if (!mm) return null;
  const headerDate = `${yyyy}-${mm}-${dd.padStart(2, '0')}`;

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

// ČNB has turned out to be intermittently reachable from Supabase's edge
// network — an initial burst of requests (e.g. a range backfill) can
// succeed cleanly, then a request moments later fails, for the same URLs
// that just worked. That pattern (fine in bursts, flaky right after) reads
// like basic rate-limiting/bot-protection reacting to a run of requests
// from the same caller more than a plain network outage — so this fetches
// gently: a real browser User-Agent (an obviously bot-ish one is an easy
// thing for a WAF to key on) and a small pause between requests when
// walking multiple days, rather than firing them back to back.
//
// A hung fetch() with no timeout doesn't throw — it just sits until the
// edge runtime's own wall-clock limit kills the whole isolate, which shows
// up to the caller as a bare "502 Bad Gateway" with nothing useful in the
// logs. Bounding every attempt with an AbortController turns that into a
// normal, loggable, catchable error instead.
const CNB_FETCH_TIMEOUT_MS = 12000;
const CNB_REQUEST_SPACING_MS = 300;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCnbDailyFile(dateStr: string): Promise<ParsedFile | null> {
  const url = `https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt?date=${toCnbDateParam(dateStr)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CNB_FETCH_TIMEOUT_MS);
  console.log(`[fetch-exchange-rate] requesting ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8',
      },
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    console.log(`[fetch-exchange-rate] fetch ${isAbort ? 'timed out' : 'failed'} for ${dateStr}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[fetch-exchange-rate] response for ${dateStr}: status ${res.status}`);
  if (!res.ok) {
    // Log the body on a non-2xx — a WAF/rate-limit block usually says so in
    // an HTML or JSON body, which is the one piece of evidence that would
    // actually distinguish "blocked" from "ČNB has nothing for this date"
    // (a real "no data" response from ČNB is also a non-200, so this isn't
    // itself an error condition — just worth seeing when it happens).
    try {
      const bodyPreview = (await res.text()).slice(0, 300);
      console.log(`[fetch-exchange-rate] non-2xx body preview for ${dateStr}: ${bodyPreview}`);
    } catch {
      // ignore — logging the body is best-effort only
    }
    return null;
  }
  const text = await res.text();
  const parsed = parseDailyTxt(text);
  if (!parsed) {
    // This is the case that turned out to matter: ČNB answering 200 every
    // time, but parseDailyTxt() rejecting the body anyway — meaning the
    // real page structure doesn't match what this was written against
    // (never actually exercised against a live response before now). Log
    // enough of the raw body to fix the parser against the real thing
    // instead of guessing at it again.
    console.log(`[fetch-exchange-rate] got 200 for ${dateStr} but failed to parse — first 500 chars: ${text.slice(0, 500)}`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    return await handleRequest(req);
  } catch (err) {
    // Belt-and-braces: turn ANY unexpected throw into a visible JSON 500
    // instead of letting the runtime produce an opaque 502 with no body.
    console.log(`[fetch-exchange-rate] unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return new Response(JSON.stringify({ error: 'Internal error', detail: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }
});

async function handleRequest(req: Request): Promise<Response> {
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
  console.log(`[fetch-exchange-rate] mode=${String(body.mode)} body=${JSON.stringify(body)}`);

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
      if (attempt > 0) await sleep(CNB_REQUEST_SPACING_MS);
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
    // 404, not 502 — this means "asked ČNB honestly, 10 times, nothing
    // published in that window," which is a real answer, not a gateway
    // failure. (A run of literal 502s further up, before this point, is
    // what actually indicates ČNB/the gateway not responding — see the
    // per-attempt log lines above for which one it was.)
    return new Response(
      JSON.stringify({ error: `No ČNB fixing found in the 10 days up to ${date}` }),
      { status: 404, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } }
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
      if (daysRequested > 0) await sleep(CNB_REQUEST_SPACING_MS);
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
}
