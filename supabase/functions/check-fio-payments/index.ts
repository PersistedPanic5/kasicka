// check-fio-payments — the ONE place that talks to Fio.
//   a) matches incoming payments to open debts and settles them
//      (claude/fio-payment-matching-v1.md, migration 0016);
//   b) for accounts in Bank inbox mode, copies every movement into
//      bank_transactions and classifies it (claude/fio-everyday-mode-v1.md,
//      migration 0017), then sends a Web Push when new items are waiting.
// Both share one fetch and one throttle, so they can never fight over Fio's
// one-call-per-30-seconds limit.
//
// Three callers, one function:
//   1. The PUBLIC debtor page (app/d/[token].tsx) every few seconds while a
//      Fio-linked debt is open:   { "share_token": "<token>" }
//      Anonymous — it can only trigger a check of the account THAT debt is
//      paid into, and it learns nothing but "ok". Safe because the work is
//      throttled per account (below) no matter how many pages are open.
//      Group pages (app/g/[token].tsx) do the same with { "group_token": "<token>" }.
//   2. The signed-in owner (Debts page load + "Check Fio payments now"):
//      {}  with the user's JWT -> checks every Fio account of that user
//      that has open debts or is in Bank inbox mode, and returns a summary.
//   3. The scheduler (Supabase cron, every ~5 min):
//      { "cron": true } + header x-cron-secret — checks every due Fio account
//      of every user (each account's own interval applies) and sends pushes.
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
import { classify, parseFio, type BankRow, type Ctx, type FioTx } from './bank.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MIN_GAP_MS = 35_000;
const MAX_LOOKBACK_DAYS = 85;
const OVERLAP_DAYS = 3; // re-read the last few days every time: self-healing if a run was missed
const PUSH_GAP_MS = 60 * 60_000; // at most one "new payments" push per hour per account
const DAY_MS = 86_400_000;
const NOTE_PREFIX = { en: 'Settled', cs: 'Vyrovnáno' } as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Svc = any;
const OPEN = ['OUTSTANDING', 'CLAIMED_PAID'];
const pragueDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
const pragueHour = (d: Date) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hourCycle: 'h23' }).format(d));
const normVs = (s: string) => s.trim().replace(/^0+/, '');
const shiftDay = (iso: string, days: number) => pragueDate(new Date(Date.parse(iso) + days * DAY_MS));

type Result = { status: 'idle' | 'checked' | 'throttled' | 'error'; settled: number; added: number; error?: string };

interface Acc {
  id: string;
  owner_id: string;
  entry_mode: 'MANUAL' | 'BANK_INBOX';
  fio_sync_from: string | null;
  fio_synced_through: string | null;
  bank_notify_push: boolean;
  bank_notify_daily: boolean;
  bank_last_digest_on: string | null;
  bank_last_push_at: string | null;
}

async function checkAccount(svc: Svc, accountId: string): Promise<Result> {
  const { data: acc } = (await svc
    .from('accounts')
    .select(
      'id, owner_id, entry_mode, fio_sync_from, fio_synced_through, bank_notify_push, bank_notify_daily, bank_last_digest_on, bank_last_push_at',
    )
    .eq('id', accountId)
    .eq('bank_provider', 'FIO')
    .maybeSingle()) as { data: Acc | null };
  if (!acc) return { status: 'idle', settled: 0, added: 0 };
  const inbox = acc.entry_mode === 'BANK_INBOX';

  const { data: debts } = await svc
    .from('debts')
    .select('id, owner_id, owed_by_name, amount, payment_vs, created_at, status, group_id, claimed_paid_at')
    .eq('target_account_id', accountId)
    .in('status', OPEN);
  if (!debts?.length && !inbox) return { status: 'idle', settled: 0, added: 0 };

  // Atomic claim: only one caller per 35 s gets past this for a given account.
  const threshold = new Date(Date.now() - MIN_GAP_MS).toISOString();
  const { data: claimed } = await svc
    .from('accounts')
    .update({ fio_last_checked_at: new Date().toISOString() })
    .eq('id', accountId)
    .eq('bank_provider', 'FIO')
    .or(`fio_last_checked_at.is.null,fio_last_checked_at.lt.${threshold}`)
    .select('id');
  if (!claimed?.length) return { status: 'throttled', settled: 0, added: 0 };

  const fail = async (error: string): Promise<Result> => {
    await svc.from('accounts').update({ fio_last_error: error }).eq('id', accountId);
    return { status: 'error', settled: 0, added: 0, error };
  };

  const { data: secret } = await svc.from('account_secrets').select('fio_token').eq('account_id', accountId).maybeSingle();
  if (!secret?.fio_token) return fail('no_token');

  // Range: open debts need their creation day; the inbox needs everything since the
  // last sync (minus a few days of overlap) or, the first time, since fio_sync_from.
  const today = pragueDate(new Date());
  const earliest = pragueDate(new Date(Date.now() - MAX_LOOKBACK_DAYS * DAY_MS));
  const starts: string[] = [];
  if (debts?.length) {
    const oldest = Math.min(...debts.map((d: { created_at: string }) => new Date(d.created_at).getTime()));
    starts.push(pragueDate(new Date(oldest - DAY_MS)));
  }
  if (inbox) {
    starts.push(acc.fio_synced_through ? shiftDay(acc.fio_synced_through, -OVERLAP_DAYS) : (acc.fio_sync_from ?? earliest));
  }
  const start = starts.reduce((a, b) => (a < b ? a : b));
  const from = start < earliest ? earliest : start;

  let res: Response;
  try {
    res = await fetch(`https://fioapi.fio.cz/v1/rest/periods/${secret.fio_token}/${from}/${today}/transactions.json`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail('fio_unreachable');
  }
  // Statuses per Fio's docs; anything undocumented is treated as "try again later".
  if (res.status === 409) return { status: 'throttled', settled: 0, added: 0 }; // Fio-side limit hit (e.g. another app uses the token)
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

  // ── 1) debts: incoming payment with the debt's exact VS and at least its amount ──
  let settled = 0;
  const debtByMovement = new Map<string, string>(); // movement id -> debt id
  const incoming = txs.filter((t) => t.amount > 0 && t.currency === 'CZK');
  if (incoming.length) {
    const { data: used } = await svc
      .from('debts')
      .select('id, fio_movement_id')
      .in('fio_movement_id', incoming.map((t) => t.id));
    for (const u of used ?? []) debtByMovement.set(u.fio_movement_id, u.id);
  }
  if (debts?.length && incoming.length) {
    const { data: profile } = await svc.from('profile').select('language').eq('id', debts[0].owner_id).maybeSingle();
    const prefix = NOTE_PREFIX[(profile?.language as 'en' | 'cs') ?? 'en'] ?? NOTE_PREFIX.en;
    for (const d of debts) {
      // Underpayments are NOT settled automatically (the owner confirms those by hand).
      const hit = incoming.find(
        (t) => t.vs && !debtByMovement.has(t.id) && normVs(t.vs) === d.payment_vs && t.amount >= Number(d.amount) - 0.001,
      );
      if (!hit) continue;
      const { data: ok, error } = await svc.rpc('fio_settle_debt', {
        p_debt_id: d.id,
        p_movement_id: hit.id,
        p_note: `${prefix}: ${d.owed_by_name} (Fio)`,
      });
      if (!error && ok) {
        settled++;
        debtByMovement.set(hit.id, d.id);
      }
    }
  }

  // ── 1b) one-QR group bills: a payment of one share with the GROUP's symbol
  // settles the person who tapped "I paid" first. Nobody tapped yet -> the payment
  // is left alone and matches on a later check, once somebody does (the lookback
  // window always covers open debts). One payment settles one person.
  const groupIds = [...new Set((debts ?? []).filter((d: { group_id: string | null }) => d.group_id).map((d: { group_id: string }) => d.group_id))];
  if (groupIds.length && incoming.length) {
    const { data: groups } = await svc
      .from('debt_groups')
      .select('id, group_vs, per_person')
      .in('id', groupIds)
      .eq('mode', 'ONE_QR');
    const { data: profile } = await svc.from('profile').select('language').eq('id', debts[0].owner_id).maybeSingle();
    const prefix = NOTE_PREFIX[(profile?.language as 'en' | 'cs') ?? 'en'] ?? NOTE_PREFIX.en;
    for (const g of groups ?? []) {
      const tapped = debts
        .filter((d: { id: string; group_id: string; status: string }) => d.group_id === g.id && d.status === 'CLAIMED_PAID' && ![...debtByMovement.values()].includes(d.id))
        .sort((a: { claimed_paid_at: string | null }, b: { claimed_paid_at: string | null }) =>
          (a.claimed_paid_at ?? '').localeCompare(b.claimed_paid_at ?? ''));
      for (const t of incoming) {
        if (!tapped.length) break;
        if (!t.vs || debtByMovement.has(t.id) || normVs(t.vs) !== g.group_vs || t.amount < Number(g.per_person) - 0.001) continue;
        const d = tapped.shift();
        const { data: ok, error } = await svc.rpc('fio_settle_debt', {
          p_debt_id: d.id,
          p_movement_id: t.id,
          p_note: `${prefix}: ${d.owed_by_name} (Fio)`,
        });
        if (!error && ok) {
          settled++;
          debtByMovement.set(t.id, d.id);
        }
      }
    }
  }

  // ── 2) inbox: stage every CZK movement since fio_sync_from ──
  let added = 0;
  if (inbox) {
    const n = await ingest(svc, acc, txs, debtByMovement, from, today);
    if (n === null) return fail('inbox_save_failed'); // keep fio_synced_through so the next run retries the same days
    added = n;
    await svc.from('accounts').update({ fio_synced_through: today }).eq('id', accountId);
    await notify(svc, acc);
  }
  return { status: 'checked', settled, added };
}

async function ingest(
  svc: Svc,
  acc: Acc,
  txs: FioTx[],
  debtByMovement: Map<string, string>,
  from: string,
  to: string,
): Promise<number | null> {
  // Only CZK (the account's own currency); nothing booked before the cut-off day.
  const wanted = txs.filter((t) => t.currency === 'CZK' && (!acc.fio_sync_from || t.date >= acc.fio_sync_from));

  if (!wanted.length) return 0;

  // A payment that settled a debt is not a personal transaction: file it as DEBT.
  const debtRows = wanted.filter((t) => debtByMovement.has(t.id));
  for (const t of debtRows) {
    await svc
      .from('bank_transactions')
      .update({ status: 'DEBT', matched_debt_id: debtByMovement.get(t.id) })
      .eq('account_id', acc.id)
      .eq('movement_id', t.id)
      .eq('status', 'NEW');
  }

  const { data: have } = await svc.from('bank_transactions').select('movement_id').eq('account_id', acc.id).in('movement_id', wanted.map((t) => t.id));
  const known = new Set((have ?? []).map((h: { movement_id: string }) => h.movement_id));
  const fresh = wanted.filter((t) => !known.has(t.id));
  if (!fresh.length) return 0;

  const lo = shiftDay(fresh.reduce((a, t) => (t.date < a ? t.date : a), to), -3);
  const hi = shiftDay(to, 3);
  const [accounts, rules, recurring, manual] = await Promise.all([
    svc.from('accounts').select('id, account_type, account_number, bank_code').eq('owner_id', acc.owner_id).eq('active', true),
    svc.from('bank_rules').select('match_key, category_id, uses').eq('owner_id', acc.owner_id),
    svc.from('recurring_items').select('id, name, amount, category_id').eq('owner_id', acc.owner_id).eq('active', true),
    svc
      .from('transactions')
      .select('id, transaction_date, type, amount')
      .eq('owner_id', acc.owner_id)
      .eq('account_id', acc.id)
      .eq('status', 'PAID')
      .is('fio_movement_id', null)
      .in('type', ['EXPENSE', 'INCOME'])
      .gte('transaction_date', lo)
      .lte('transaction_date', hi),
  ]);
  const ctx: Ctx = {
    accountId: acc.id,
    accounts: accounts.data ?? [],
    rules: new Map((rules.data ?? []).map((r: { match_key: string; category_id: string; uses: number }) => [r.match_key, r])),
    recurring: (recurring.data ?? []).map((r: { amount: number }) => ({ ...r, amount: Number(r.amount) })),
    manual: manual.data ?? [],
    taken: new Set(),
  };

  const rows: (BankRow & Record<string, unknown>)[] = fresh
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => {
      const row = classify(t, ctx) as BankRow & Record<string, unknown>;
      row.owner_id = acc.owner_id;
      row.account_id = acc.id;
      if (debtByMovement.has(t.id)) {
        row.status = 'DEBT';
        row.matched_debt_id = debtByMovement.get(t.id);
      }
      return row;
    });
  const { error } = await svc.from('bank_transactions').upsert(rows, { onConflict: 'account_id,movement_id', ignoreDuplicates: true });
  if (error) {
    console.error('[check-fio-payments] ingest failed', error.message);
    return null;
  }
  return rows.filter((r) => r.status !== 'DEBT').length;
}

// ── Web Push ("N new bank payments to review") ─────────────────────────────
async function notify(svc: Svc, acc: Acc) {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!publicKey || !privateKey || !(acc.bank_notify_push || acc.bank_notify_daily)) return;

  const now = new Date();
  const { data: waiting } = await svc
    .from('bank_transactions')
    .select('id, notified_at')
    .eq('account_id', acc.id)
    .eq('status', 'NEW');
  const total = waiting?.length ?? 0;
  const unannounced = (waiting ?? []).filter((w: { notified_at: string | null }) => !w.notified_at).map((w: { id: string }) => w.id);

  let message: string | null = null;
  const lastPush = acc.bank_last_push_at ? Date.parse(acc.bank_last_push_at) : 0;
  if (acc.bank_notify_push && unannounced.length && now.getTime() - lastPush >= PUSH_GAP_MS) {
    message = `${total} bank payment${total === 1 ? '' : 's'} waiting for a category`;
  } else if (
    acc.bank_notify_daily && total && pragueHour(now) >= 20 && acc.bank_last_digest_on !== pragueDate(now)
  ) {
    message = `Today: ${total} bank payment${total === 1 ? '' : 's'} still to review`;
  }
  if (!message) return;

  const { data: subs } = await svc.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('owner_id', acc.owner_id);
  if (!subs?.length) return;
  const webpush = (await import('npm:web-push@3.6.7')).default;
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:pavel.skuhrovec@gmail.com', publicKey, privateKey);
  const payload = JSON.stringify({ title: 'Kasička · Bank inbox', body: message, url: '/bank' });
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      delivered++;
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) await svc.from('push_subscriptions').delete().eq('id', s.id);
      else console.error('[check-fio-payments] push failed', code);
    }
  }
  if (!delivered) return; // keep items "unannounced" so the next run tries again
  const stamp = { bank_last_push_at: now.toISOString() } as Record<string, string>;
  if (message.startsWith('Today')) stamp.bank_last_digest_on = pragueDate(now);
  await svc.from('accounts').update(stamp).eq('id', acc.id);
  if (unannounced.length) await svc.from('bank_transactions').update({ notified_at: now.toISOString() }).in('id', unannounced);
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

  // 1b) public group page (app/g/[token].tsx): same idea, for the group's account
  if (typeof body.group_token === 'string') {
    const { data: g } = await svc.from('debt_groups').select('id, target_account_id').eq('share_token', body.group_token).maybeSingle();
    if (!g) return json({ ok: true, settled: 0 });
    const r = await checkAccount(svc, g.target_account_id);
    return json({ ok: r.status !== 'error', settled: r.settled });
  }

  // 3) scheduler — shared secret, all users
  if (body.cron === true) {
    const secret = Deno.env.get('CRON_SECRET');
    if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Forbidden' }, 403);
    const { data: accounts } = await svc
      .from('accounts')
      .select('id, entry_mode, bank_sync_minutes, fio_last_success_at')
      .eq('bank_provider', 'FIO');
    const out = { checked: 0, skipped: 0, throttled: 0, settled: 0, added: 0, errors: 0 };
    for (const a of accounts ?? []) {
      // Each account's own interval; open debts are looked at on every tick.
      const every = (a.entry_mode === 'BANK_INBOX' ? a.bank_sync_minutes : 5) * 60_000;
      if (a.fio_last_success_at && Date.now() - Date.parse(a.fio_last_success_at) < every - 60_000) {
        out.skipped++;
        continue;
      }
      const r = await checkAccount(svc, a.id);
      if (r.status === 'checked') out.checked++;
      if (r.status === 'throttled') out.throttled++;
      if (r.status === 'error') out.errors++;
      out.settled += r.settled;
      out.added += r.added;
    }
    return json({ ok: true, ...out });
  }

  // 2) signed-in owner
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData } = await svc.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return json({ error: 'Not signed in' }, 401);

  const { data: accounts } = await svc.from('accounts').select('id').eq('owner_id', user.id).eq('bank_provider', 'FIO');
  const out = { checked: 0, throttled: 0, settled: 0, added: 0, errors: [] as string[] };
  for (const a of accounts ?? []) {
    const r = await checkAccount(svc, a.id);
    if (r.status === 'checked') out.checked++;
    if (r.status === 'throttled') out.throttled++;
    if (r.status === 'error' && r.error) out.errors.push(r.error);
    out.settled += r.settled;
    out.added += r.added;
  }
  return json({ ok: true, ...out });
});
