-- Kasička — Fio "Bank inbox" everyday mode (see claude/fio-everyday-mode-v1.md).
--
-- A Fio account can be switched from MANUAL entry to BANK_INBOX: the
-- check-fio-payments Edge Function copies every booked movement into
-- bank_transactions (a staging table), the app shows them in the Bank inbox
-- and NOTHING becomes a real transaction until the owner confirms it
-- (decision: "confirm every item" — there is deliberately no auto-post).
--
-- Own transfers and ATM withdrawals are recorded on the bank row only
-- (status TRANSFER + to_account_id). They create no transaction, so they can
-- never touch a budget; accounts stay labels (no balance tracking).

-- ── account settings ─────────────────────────────────────────────────────
alter table public.accounts
  add column entry_mode text not null default 'MANUAL' check (entry_mode in ('MANUAL', 'BANK_INBOX')),
  -- never import movements booked before this day (history stays as typed)
  add column fio_sync_from date,
  -- last day fully covered by a successful sync; next fetch starts 3 days earlier
  add column fio_synced_through date,
  add column bank_sync_minutes int not null default 15 check (bank_sync_minutes in (10, 15, 60)),
  add column bank_notify_push boolean not null default true,
  add column bank_notify_daily boolean not null default false,
  add column bank_last_digest_on date,
  add column bank_last_push_at timestamptz;

-- Bank inbox only makes sense for a Fio-linked account.
alter table public.accounts
  add constraint accounts_inbox_needs_fio check (entry_mode = 'MANUAL' or bank_provider = 'FIO');

-- 0016's set_fio_token, plus: disconnecting Fio switches the account back to
-- manual entry (otherwise the new check constraint would reject the update).
create or replace function public.set_fio_token(p_account_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from accounts where id = p_account_id and owner_id = auth.uid()) then
    raise exception 'account not found';
  end if;

  if p_token is null or btrim(p_token) = '' then
    delete from account_secrets where account_id = p_account_id;
    update accounts
      set bank_provider = null, fio_last_error = null, entry_mode = 'MANUAL'
      where id = p_account_id;
    return;
  end if;

  if btrim(p_token) !~ '^[A-Za-z0-9]{64}$' then
    raise exception 'invalid fio token format';
  end if;

  insert into account_secrets (account_id, owner_id, fio_token)
    values (p_account_id, auth.uid(), btrim(p_token))
    on conflict (account_id) do update
      set fio_token = excluded.fio_token, updated_at = now();
  update accounts
    set bank_provider = 'FIO', fio_last_error = null, fio_last_checked_at = null
    where id = p_account_id;
end;
$$;
revoke all on function public.set_fio_token(uuid, text) from public, anon;
grant execute on function public.set_fio_token(uuid, text) to authenticated;

-- ── staging table ────────────────────────────────────────────────────────
create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  movement_id text not null,                 -- Fio "ID pohybu" (dedupe key)
  booked_date date not null,
  amount numeric(14, 2) not null,            -- signed: negative = money out
  merchant text not null,                    -- display name derived from the feed
  merchant_key text not null default '',     -- normalised key used by bank_rules
  counter_account text,
  counter_bank text,
  movement_type text,                        -- Fio "Typ" (card payment, ATM, ...)
  details text,                              -- Fio "Upřesnění" / message / comment
  vs text,
  -- what the sync function thinks this is; the owner always has the last word
  kind text not null default 'EXPENSE' check (kind in ('EXPENSE', 'INCOME', 'TRANSFER', 'CASH')),
  suggested_category_id uuid references public.categories (id) on delete set null,
  suggested_uses int,                        -- "filed under Food N times"
  suggested_account_id uuid references public.accounts (id) on delete set null,
  recurring_item_id uuid references public.recurring_items (id) on delete set null,
  -- a manual entry that looks like the same payment ("Is this the one you entered?")
  match_transaction_id uuid references public.transactions (id) on delete set null,
  status text not null default 'NEW'
    check (status in ('NEW', 'POSTED', 'LINKED', 'TRANSFER', 'IGNORED', 'DEBT')),
  transaction_id uuid references public.transactions (id) on delete set null,
  to_account_id uuid references public.accounts (id) on delete set null,
  matched_debt_id uuid references public.debts (id) on delete set null,
  notified_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, movement_id)
);
create index bank_transactions_owner_status_idx on public.bank_transactions (owner_id, status, booked_date desc);

-- The app may only READ this table; every change goes through the sync
-- function (service role) or the bank_* functions below.
alter table public.bank_transactions enable row level security;
create policy "owner can read" on public.bank_transactions for select using (owner_id = auth.uid());
revoke insert, update, delete on public.bank_transactions from anon, authenticated;

-- ── remembered categories per merchant (suggest-only) ────────────────────
create table public.bank_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  match_key text not null,
  category_id uuid not null references public.categories (id) on delete cascade,
  uses int not null default 1,
  updated_at timestamptz not null default now(),
  unique (owner_id, match_key)
);
alter table public.bank_rules enable row level security;
create policy "owner full access" on public.bank_rules
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ── link from a real transaction to its bank movement ────────────────────
alter table public.transactions add column fio_movement_id text;
create unique index transactions_fio_movement_key on public.transactions (account_id, fio_movement_id)
  where fio_movement_id is not null;

alter table public.transactions drop constraint transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source in ('MANUAL', 'RECURRING', 'LONG_TERM_QR', 'DEBT_SETTLEMENT', 'MANUAL_PAYMENT', 'BANK_IMPORT'));

-- ── actions the app can take on an inbox row ─────────────────────────────
-- Budget month math mirrors lib/budget-month.ts (same as fio_settle_debt).
create or replace function public.bank_budget_month(p_owner uuid, p_date date)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select date_trunc('month', p_date - ((coalesce((select month_start_day from profile where id = p_owner), 1) - 1) * interval '1 day'))::date;
$$;
revoke all on function public.bank_budget_month(uuid, date) from public, anon, authenticated;

-- Confirm: turn the movement into a real transaction on its account.
-- Negative amount -> EXPENSE (needs a category), positive -> INCOME.
-- Remembers merchant -> category for next time. Returns the new transaction id.
create or replace function public.bank_post(p_id uuid, p_category_id uuid, p_event_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bank_transactions%rowtype;
  v_tx uuid;
begin
  select * into b from bank_transactions where id = p_id and owner_id = auth.uid() and status = 'NEW' for update;
  if not found then
    raise exception 'bank item not found';
  end if;
  if b.amount < 0 and p_category_id is null then
    raise exception 'category required';
  end if;
  if p_category_id is not null
     and not exists (select 1 from categories where id = p_category_id and owner_id = auth.uid()) then
    raise exception 'category not found';
  end if;
  if p_event_id is not null
     and not exists (select 1 from events where id = p_event_id and owner_id = auth.uid()) then
    raise exception 'event not found';
  end if;

  insert into transactions
    (owner_id, budget_month, transaction_date, type, category_id, account_id, amount, note,
     source, event_id, fio_movement_id, recurring_item_id)
  values
    (b.owner_id, bank_budget_month(b.owner_id, b.booked_date), b.booked_date,
     case when b.amount < 0 then 'EXPENSE' else 'INCOME' end,
     case when b.amount < 0 then p_category_id end,
     b.account_id, abs(b.amount), coalesce(nullif(btrim(p_note), ''), b.merchant),
     'BANK_IMPORT', p_event_id, b.movement_id, b.recurring_item_id)
  returning id into v_tx;

  update bank_transactions set status = 'POSTED', transaction_id = v_tx, decided_at = now() where id = b.id;

  if b.amount < 0 and b.merchant_key <> '' then
    insert into bank_rules (owner_id, match_key, category_id)
      values (b.owner_id, b.merchant_key, p_category_id)
    on conflict (owner_id, match_key) do update
      set uses = case when bank_rules.category_id = excluded.category_id then bank_rules.uses + 1 else 1 end,
          category_id = excluded.category_id,
          updated_at = now();
  end if;
  return v_tx;
end;
$$;

-- "Yes, link them": the movement IS an expense the owner already typed.
-- Keeps their category/note/photo and adopts the bank's exact date.
create or replace function public.bank_link(p_id uuid, p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bank_transactions%rowtype;
begin
  select * into b from bank_transactions where id = p_id and owner_id = auth.uid() and status = 'NEW' for update;
  if not found then
    raise exception 'bank item not found';
  end if;
  update transactions
    set fio_movement_id = b.movement_id,
        transaction_date = b.booked_date,
        budget_month = bank_budget_month(b.owner_id, b.booked_date),
        recurring_item_id = coalesce(recurring_item_id, b.recurring_item_id),
        updated_at = now()
    where id = p_transaction_id and owner_id = auth.uid() and account_id = b.account_id
      and fio_movement_id is null;
  if not found then
    raise exception 'transaction not available to link';
  end if;
  update bank_transactions set status = 'LINKED', transaction_id = p_transaction_id, decided_at = now() where id = b.id;
end;
$$;

-- Ignore, mark as own transfer / cash move, or put an ignored/transfer item
-- back into the inbox. p_to_account = where the money went (TRANSFER only).
create or replace function public.bank_decide(p_id uuid, p_status text, p_to_account uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('IGNORED', 'TRANSFER', 'NEW') then
    raise exception 'bad status';
  end if;
  if p_to_account is not null
     and not exists (select 1 from accounts where id = p_to_account and owner_id = auth.uid()) then
    raise exception 'account not found';
  end if;
  update bank_transactions
    set status = p_status,
        to_account_id = case when p_status = 'TRANSFER' then p_to_account end,
        decided_at = case when p_status = 'NEW' then null else now() end
    where id = p_id and owner_id = auth.uid()
      and ((p_status = 'NEW' and status in ('IGNORED', 'TRANSFER')) or (p_status <> 'NEW' and status = 'NEW'));
  if not found then
    raise exception 'bank item not found';
  end if;
end;
$$;

revoke all on function public.bank_post(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.bank_link(uuid, uuid) from public, anon;
revoke all on function public.bank_decide(uuid, text, uuid) from public, anon;
grant execute on function public.bank_post(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.bank_link(uuid, uuid) to authenticated;
grant execute on function public.bank_decide(uuid, text, uuid) to authenticated;
