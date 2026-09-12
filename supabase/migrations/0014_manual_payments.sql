-- One-off "I have an account number and an amount, just let me pay this"
-- payments (Pavel: "I need to pay something and I got only the account
-- number and value in text and I need to open the banking app and its
-- just complicated"). Separate from long_term_items, which model a
-- recurring reserve/payment CYCLE spread over months — this is a single
-- ad-hoc payment with no cycle at all, closer in shape to "type in some
-- bank details and get a QR" than to anything already in that table. Same
-- QR mechanism as everything else that pays out of Kasička
-- (lib/czech-qr-payment.ts): Pavel scans it in his own banking app, then
-- comes back and confirms it's paid — which posts a normal EXPENSE
-- transaction and clears the pending row. Nothing keeps a "paid one-off
-- payments" history of its own (Pavel's choice) — once confirmed, its
-- permanent record is that transaction, same as everything else he logs.

-- "a database of people I sent money to this way" so a repeat payment can
-- start from their saved account details instead of retyping a number out
-- of a text message again. Matched/reused by bank account (see
-- lib/manual-payments.ts's findOrCreatePayee), not by name, so paying the
-- same account under a slightly different typed name still lands on one
-- person instead of fragmenting them across duplicate entries.
create table public.payees (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  target_account_prefix text,
  target_account_number text not null,
  target_bank_code text not null,
  last_paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index payees_owner_idx on public.payees (owner_id);

alter table public.payees enable row level security;
create policy "owner full access" on public.payees
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- One row per payment still waiting to be marked paid. category_id/
-- account_id are fixed at creation time (same as long_term_items) so
-- confirming later is just "post it", not a second form to fill in.
create table public.manual_payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  payee_id uuid not null references public.payees (id) on delete cascade,
  category_id uuid not null references categories (id) on delete restrict,
  account_id uuid not null references accounts (id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  message text,
  variable_symbol text,
  created_at timestamptz not null default now()
);
create index manual_payments_owner_idx on public.manual_payments (owner_id);

alter table public.manual_payments enable row level security;
create policy "owner full access" on public.manual_payments
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- A confirmed one-off payment posts as a plain EXPENSE, tagged with its
-- own source value so it's distinguishable from a Record-Expense entry
-- (e.g. Settings → Recent inputs, which already filters by source) without
-- needing a whole new transaction type.
alter table public.transactions drop constraint transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source in ('MANUAL', 'RECURRING', 'LONG_TERM_QR', 'DEBT_SETTLEMENT', 'MANUAL_PAYMENT'));
