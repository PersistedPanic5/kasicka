-- Multi-currency support (Pavel's request): record an expense in EUR, USD,
-- PLN, HUF, etc. and have it stored in CZK (the app stays CZK-only for all
-- totals/budgets — core-app-requirements.md "CZK only, no multi-currency"
-- is still true for the ledger itself) while remembering what was actually
-- typed and what rate converted it.
--
-- ── exchange_rates ───────────────────────────────────────────────────────
-- A cache of Czech National Bank (ČNB) daily fixing rates against CZK, one
-- row per currency per date it was actually published on. Deliberately NOT
-- one row per calendar day — ČNB doesn't publish on weekends/bank holidays,
-- so a lookup for e.g. a Sunday reads the most recent row with
-- rate_date <= that Sunday (see lib/exchange-rates.ts), which is exactly
-- "use the last previous working day's rate" (the accounting rule Pavel
-- asked for) without ever storing a duplicate/synthetic row.
--
-- Not owner-scoped: these are public market rates, not personal data, and
-- there's one user anyway — every signed-in user may read; only the
-- fetch-exchange-rate Edge Function (service role, see supabase/functions/
-- fetch-exchange-rate) writes, so two tabs racing to fetch the same date
-- can't leave a half-written or duplicate row.
create table exchange_rates (
  currency_code text not null,
  rate_date date not null,
  -- ČNB quotes some currencies (HUF, JPY, ...) per 100 units rather than
  -- per 1 — this is that quoted unit; `rate` is CZK per `amount_unit` units
  -- of currency_code. lib/exchange-rates.ts always divides through so
  -- callers get a plain "CZK per 1 unit" figure and never have to think
  -- about this column.
  amount_unit int not null default 1,
  rate numeric(12, 6) not null,
  fetched_at timestamptz not null default now(),
  primary key (currency_code, rate_date)
);

create index exchange_rates_currency_date_idx on exchange_rates (currency_code, rate_date desc);

alter table exchange_rates enable row level security;

create policy "authenticated read" on exchange_rates
  for select using (auth.role() = 'authenticated');
-- No write policy for authenticated users — only the service-role Edge
-- Function writes (service role bypasses RLS entirely).

-- ── profile currency settings ───────────────────────────────────────────
-- tracked_currencies: everything Pavel has told Settings → Currencies he
-- wants rates downloaded/cached for. active_currencies: the subset that
-- actually shows up as a tap-through option on Record Expense (Pavel's
-- answer: selecting a currency in the tracked list auto-adds it here too;
-- he removes it from here separately if he doesn't want it cluttering
-- Record Expense yet). Both are plain ISO 4217 codes, CZK never included
-- in either — CZK is always the implicit base/rest state.
alter table profile
  add column tracked_currencies text[] not null default '{}',
  add column active_currencies text[] not null default '{}';

-- ── transactions: original-currency metadata ────────────────────────────
-- `amount` (existing column) is always CZK, same as before — every total,
-- budget bar, and Overview figure keeps working unmodified. These three
-- are purely informational, set only when the entry form's currency picker
-- was left on something other than CZK: what was actually typed, in what
-- currency, and at what CZK-per-unit rate it was converted at (so
-- original_amount * exchange_rate = amount, and a receipt/note can always
-- be traced back to "this was really 20 PLN").
alter table transactions
  add column original_currency text,
  add column original_amount numeric(12, 2),
  add column exchange_rate numeric(12, 6);
