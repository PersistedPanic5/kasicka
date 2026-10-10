// check-fio-payments — matches incoming Fio bank payments to open debts and
// settles them (claude/fio-payment-matching-v1.md, migration 0016).
//
// Two callers, one function:
//   1. The PUBLIC debtor page (app/d/[token].tsx) every few seconds while a
//      Fio-linked debt is open:   { "share_token": "<token>" }
//      Anonymous — it can only trigger a check of the account THAT debt is
//      paid into, and it learns nothing but "ok". Safe because the work is
//      throttled per account (below) no matter how many pages are open.
//   2. The signed-in owner (Debts page load + "Check Fio payments now"):
//      {}  with the user's JWT -> checks every Fio account of that user
//      that has open debts, and returns a summary for the UI.
//
// The Fio token never leaves this function: it is read from
// account_secrets with the service role, used in the request URL (that is
// how Fio's API works), and never logged or returned.
//
// Fio rules this respects (https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf):
//  - max ONE request per 30 s per token, otherwise HTTP 409. We claim
//    accounts.fio_last_checked_at atomically BEFORE calling (35 s gap), so
//    parallel pages/clicks can't race past it.
//  - uses `periods/...` (an explicit date range), NOT `last/...` — `last`
//    moves a server-side "already downloaded" cursor, which would make this
//    and any other consumer of the same token (an accounting tool, say)
//    steal each other's data.
//  - data older than 90 days needs a one-off unlock in internet banking, so
//    the range is capped at 85 days back.

import { createClient } from 'npm:@supabase/supabase-js@2.55.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MIN_GAP_MS = 35_000;
const MAX_LOOKBACK_DAYS = 85;
const NOTE_PREFIX = { en: 'Settled', cs: 'Vyrovnáno' } as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Svc = any;
const OPEN = ['OUTSTANDING', 'CLAIMED_PAID'];
const pragueDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
const normVs = (s: string) => s.trim().replace(/^0+/, '');

interface FioTx {
  id: string;
  amount: number;
  currency: string;
  vs: string;
}

// deno-lint-ignore no-explicit-any
function parseFio(body: any): FioTx[] {
  const list = body?.accountStatement?.transactionList?.transaction ?? [];
  // deno-lint-ignore no-explicit-any
  return list.map((t: any) => ({
    id: String(t.column22?.value ?? ''), // movement ID — the only safe dedupe key
    amount: Number(t.column1?.value), // positive = incoming
    currency: String(t.column14?.value ?? ''),
    vs: String(t.column5?.value ?? ''),
  })).filter((t: FioTx) => t.id && Number.isFinite(t.amount));
}

type Result = { status: 'idle' | 'checked' | 'throttled' | 'error'; settled: number; error?: string };

async function checkAccount(svc: Svc, accountId: string): Promise<Result> {
  const { data: debts } = await svc
    .from('debts')
    .select('id, owner_id, owed_by_name, amount, payment_vs, created_at')
    .eq('target_account_id', accountId)
    .in('status', OPEN);
  if (!debts?.length) return { status: 'idle', settled: 0 };

  // Atomic claim: only one caller per 35 s gets past this for a given account.
  const threshold = new Date(Date.now() - MIN_GAP_MS).toISOString();
  const { data: claimed } = await svc
    .from('accounts')
    .update({ fio_last_checked_at: new Date().toISOString() })
    .eq('id', accountId)
    .eq('bank_provider', 'FIO')
    .or(`fio_last_checked_at.is.null,fio_last_checked_at.lt.${threshold}`)
    .select('id');
  if (!claimed?.length) return { status: 'throttled', settled: 0 };

  const fail = async (error: string): Promise<Result> => {
    await svc.from('accounts').update({ fio_last_error: error }).eq('id', accountId);
    return { status: 'error', settled: 0, error };
  };

  const { data: secret } = await svc.from('account_secrets').select('fio_token').eq('account_id', accountId).maybeSingle();
  if (!secret?.fio_token) return fail('no_token');

  const oldest = Math.min(...debts.map((d: { created_at: string }) => new Date(d.created_at).getTime()));
  const earliest = Date.now() - MAX_LOOKBACK_DAYS * 86_400_000;
  const from = pragueDate(new Date(Math.max(oldest - 86_400_000, earliest)));
  const to = pragueDate(new Date());

  let res: Response;
  try {
    res = await fetch(`https://fioapi.fio.cz/v1/rest/periods/${secret.fio_token}/${from}/${to}/transactions.json`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail('fio_unreachable');
  }
  // Statuses per Fio's docs; anything undocumented is treated as "try again later".
  if (res.status === 409) return { status: 'throttled', settled: 0 }; // Fio-side limit hit (e.g. another app uses the token)
  if (res.status === 422) return fail('fio_bad_request');
  if (res.status === 500 || res.status === 404) return fail('fio_token_invalid'); // Fio answers an unknown/expired token this way
  if (!res.ok) return fail(`fio_http_${res.status}`);

  let txs: FioTx[];
  try {
    txs = parseFio(await res.json());
  } catch {
    return fail('fio_bad_response');
  }
  await svc.from('accounts').update({ fio_last_success_at: new Date().toISOString(), fio_last_error: null }).eq('id', accountId);

  const incoming = txs.filter((t) => t.amount > 0 && t.currency === 'CZK' && t.vs);
  if (!incoming.length) return { status: 'checked', settled: 0 };

  // Movements that already settled something (e.g. a previous run) can't settle again.
  const { data: used } = await svc.from('debts').select('fio_movement_id').in('fio_movement_id', incoming.map((t) => t.id));
  const usedIds = new Set((used ?? []).map((u: { fio_movement_id: string }) => u.fio_movement_id));

  const { data: profile } = await svc.from('profile').select('language').eq('id', debts[0].owner_id).maybeSingle();
  const prefix = NOTE_PREFIX[(profile?.language as 'en' | 'cs') ?? 'en'] ?? NOTE_PREFIX.en;

  let settled = 0;
  for (const d of debts) {
    // Exact variable symbol + at least the full amount. Underpayments are NOT
    // settled automatically (Pavel confirms those by hand).
    const hit = incoming.find((t) => !usedIds.has(t.id) && normVs(t.vs) === d.payment_vs && t.amount >= Number(d.amount) - 0.001);
    if (!hit) continue;
    const { data: ok, error } = await svc.rpc('fio_settle_debt', {
      p_debt_id: d.id,
      p_movement_id: hit.id,
      p_note: `${prefix}: ${d.owed_by_name} (Fio)`,
    });
    if (!error && ok) {
      settled++;
      usedIds.add(hit.id);
    }
  }
  return { status: 'checked', settled };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: 'Missing Supabase env' }, 500);
  const svc = createClient(url, key);

  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));

  // 1) public debtor page
  if (typeof body.share_token === 'string') {
    const { data: debt } = await svc
      .from('debts')
      .select('target_account_id, status')
      .eq('share_token', body.share_token)
      .maybeSingle();
    if (!debt || !OPEN.includes(debt.status)) return json({ ok: true, settled: 0 });
    const r = await checkAccount(svc, debt.target_account_id);
    return json({ ok: r.status !== 'error', settled: r.settled }); // no error detail for anonymous callers
  }

  // 2) signed-in owner
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData } = await svc.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return json({ error: 'Not signed in' }, 401);

  const { data: accounts } = await svc.from('accounts').select('id').eq('owner_id', user.id).eq('bank_provider', 'FIO');
  const out = { checked: 0, throttled: 0, settled: 0, errors: [] as string[] };
  for (const a of accounts ?? []) {
    const r = await checkAccount(svc, a.id);
    if (r.status === 'checked') out.checked++;
    if (r.status === 'throttled') out.throttled++;
    if (r.status === 'error' && r.error) out.errors.push(r.error);
    out.settled += r.settled;
  }
  return json({ ok: true, ...out });
});
