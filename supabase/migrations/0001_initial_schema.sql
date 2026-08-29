-- Kasička — initial schema
-- Mirrors claude/data-model-v1.md in the project. Single-user app (Pavel
-- only, via Google sign-in) — no multi-tenant tables, RLS just needs to
-- scope every row to auth.uid() except the narrow public debt-share lookup.

create extension if not exists "pgcrypto";

-- ── profile (single row) ────────────────────────────────────────────────
create table profile (
  id uuid primary key references auth.users (id) on delete cascade,
  default_account_id uuid, -- fk added after accounts exists, below
  month_start_day int not null default 1 check (month_start_day between 1 and 28),
  amount_buttons int[] not null default '{20,50,100,200}',
  notification_prefs jsonb not null default '{}'::jsonb,
  expo_push_token text,
  theme text not null default 'light' check (theme in ('light', 'dark')),
  language text not null default 'en' check (language in ('en', 'cs'))
);

-- ── accounts ─────────────────────────────────────────────────────────────
create table accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('BANK', 'CASH', 'SAVINGS', 'RESERVE', 'CARD')),
  account_prefix text,
  account_number text,
  bank_code text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table profile
  add constraint profile_default_account_fk
  foreign key (default_account_id) references accounts (id) on delete set null;

-- ── categories ───────────────────────────────────────────────────────────
create table categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  category_type text not null check (category_type in ('EXPENSE', 'INCOME')),
  default_monthly_budget numeric(12, 2) not null default 0,
  sort_order int not null default 0,
  active boolean not null default true
);

-- ── monthly_budgets ──────────────────────────────────────────────────────
create table monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  budget_month date not null, -- always the 1st of the month, e.g. '2026-08-01'
  category_id uuid not null references categories (id) on delete cascade,
  planned_amount numeric(12, 2) not null default 0,
  unique (owner_id, budget_month, category_id)
);

-- ── transactions ─────────────────────────────────────────────────────────
create table transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  budget_month date not null,
  transaction_date date not null,
  type text not null check (
    type in ('EXPENSE', 'INCOME', 'RESERVE_TRANSFER', 'PAYMENT_FROM_RESERVE', 'DEBT_SETTLEMENT_CREDIT')
  ),
  category_id uuid references categories (id) on delete set null,
  account_id uuid not null references accounts (id) on delete restrict,
  amount numeric(12, 2) not null,
  note text,
  status text not null default 'PAID' check (status in ('PAID', 'VOID')),
  source text not null default 'MANUAL' check (source in ('MANUAL', 'RECURRING', 'LONG_TERM_QR', 'DEBT_SETTLEMENT')),
  receipt_photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index transactions_owner_month_idx on transactions (owner_id, budget_month);

-- ── recurring_items ──────────────────────────────────────────────────────
create table recurring_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  category_id uuid not null references categories (id) on delete restrict,
  account_id uuid not null references accounts (id) on delete restrict,
  amount numeric(12, 2) not null,
  frequency text not null check (frequency in ('MONTHLY', 'YEARLY')),
  day_of_month int not null check (day_of_month between 1 and 28),
  active boolean not null default true
);

-- ── long_term_items ──────────────────────────────────────────────────────
-- Carried over from the old app's Long_Term_Items sheet almost unchanged —
-- reserve account is one of *our* accounts (fk); the final-payment target
-- is usually an external payee (an insurer, say), so it stays raw fields
-- rather than a fk, same as the old app. See data-model-v1.md "Open items".
create table long_term_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  category_id uuid not null references categories (id) on delete restrict,
  full_payment_amount numeric(12, 2) not null,
  payment_month date not null,
  first_reserve_month date not null,
  reserve_amount_mode text not null check (reserve_amount_mode in ('AUTO', 'MANUAL')),
  manual_monthly_reserve numeric(12, 2),
  opening_reserve_balance numeric(12, 2) not null default 0,
  repeat_yearly boolean not null default false,
  reserve_account_id uuid references accounts (id) on delete set null,
  target_account_prefix text,
  target_account_number text,
  target_bank_code text,
  variable_symbol text,
  constant_symbol text,
  specific_symbol text,
  payment_message text,
  active boolean not null default true
);

-- ── debts ────────────────────────────────────────────────────────────────
create table debts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  transaction_id uuid not null references transactions (id) on delete cascade,
  owed_by_name text not null,
  amount numeric(12, 2) not null check (amount > 0),
  target_account_id uuid not null references accounts (id) on delete restrict,
  status text not null default 'OUTSTANDING' check (status in ('OUTSTANDING', 'CLAIMED_PAID', 'SETTLED')),
  share_token text not null unique default encode(gen_random_bytes(12), 'base64url'),
  claimed_paid_at timestamptz,
  settled_at timestamptz,
  settlement_transaction_id uuid references transactions (id) on delete set null,
  created_at timestamptz not null default now()
);

create index debts_owner_status_idx on debts (owner_id, status);
create index debts_share_token_idx on debts (share_token);

-- ── Row Level Security ───────────────────────────────────────────────────
-- Everything is scoped to owner_id = auth.uid() for the normal app. The one
-- deliberate exception is the public debt-share page: it must work for a
-- signed-out visitor holding nothing but a share_token. Rather than opening
-- RLS on `debts` itself, that lookup goes through a SECURITY DEFINER
-- function (0002) that returns only the handful of fields the public page
-- needs — never a raw SELECT against the table for anon.

alter table profile enable row level security;
alter table accounts enable row level security;
alter table categories enable row level security;
alter table monthly_budgets enable row level security;
alter table transactions enable row level security;
alter table recurring_items enable row level security;
alter table long_term_items enable row level security;
alter table debts enable row level security;

create policy "owner full access" on profile
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "owner full access" on accounts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner full access" on categories
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner full access" on monthly_budgets
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner full access" on transactions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner full access" on recurring_items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner full access" on long_term_items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner full access" on debts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- No policy grants anon/public access to `debts` directly — see 0002.
