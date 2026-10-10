-- Kasička — Fio bank payment matching (see claude/fio-payment-matching-v1.md).
--
-- Pavel's idea: bank account = Fio -> paste a read-only Fio API token in
-- Settings -> the server watches the account, matches incoming payments to
-- debts and settles them automatically; the debtor's share page shows
-- "payment received" live. The token is a SECRET: it lives in its own
-- table that no client role can read, is written only through
-- set_fio_token(), and is only ever read by the check-fio-payments Edge
-- Function (service role).

-- ── account flag + bookkeeping ───────────────────────────────────────────
-- bank_provider is only ever set by set_fio_token() below (together with
-- the token), so 'FIO' always means "token stored".
alter table public.accounts add column bank_provider text check (bank_provider in ('FIO'));
-- Fio allows one call per token per 30 s; check-fio-payments claims this
-- timestamp atomically before every call so any number of open debtor
-- pages / admin clicks can never exceed that.
alter table public.accounts add column fio_last_checked_at timestamptz;
alter table public.accounts add column fio_last_success_at timestamptz;
alter table public.accounts add column fio_last_error text;

-- ── the secret ───────────────────────────────────────────────────────────
create table public.account_secrets (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  fio_token text not null,
  updated_at timestamptz not null default now()
);
-- RLS on + deliberately NO policy + no grants = unreadable and unwritable
-- from the app (anon or signed-in). Only the service role (Edge Function)
-- and the SECURITY DEFINER function below touch it.
alter table public.account_secrets enable row level security;
revoke all on public.account_secrets from anon, authenticated;

-- The one way the app can set/clear a token. Passing NULL removes it and
-- turns Fio off for the account. The token is never returned.
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
      set bank_provider = null, fio_last_error = null
      where id = p_account_id;
    return;
  end if;

  -- Fio tokens are 64 letters/digits.
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

-- ── debts: matching key + how it was settled ─────────────────────────────
-- Unique variable symbol per debt (numeric, 7 digits, valid for QR Platba
-- X-VS). Existing rows get one too. Merged debts get a fresh one.
create sequence public.debt_payment_vs_seq start 1000001;
alter table public.debts
  add column payment_vs text not null default nextval('public.debt_payment_vs_seq')::text;
create unique index debts_payment_vs_key on public.debts (payment_vs);

-- NULL = settled by hand (Confirm settled); 'FIO' = matched from the bank.
alter table public.debts add column settled_via text check (settled_via in ('FIO'));
-- The Fio "movement ID" that settled it — a given bank movement can never
-- settle two debts.
alter table public.debts add column fio_movement_id text;
create unique index debts_fio_movement_key on public.debts (fio_movement_id)
  where fio_movement_id is not null;

-- ── automatic settlement (service role only) ─────────────────────────────
-- Same result as Debts -> "Confirm settled" (a DEBT_SETTLEMENT_CREDIT
-- transaction + debt SETTLED), done in one transaction and idempotent: a
-- debt that is already SETTLED/MERGED is left alone and false is returned.
-- Budget month math mirrors lib/budget-month.ts budgetMonthForDate.
create or replace function public.fio_settle_debt(p_debt_id uuid, p_movement_id text, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d debts%rowtype;
  v_cat uuid;
  v_acc uuid;
  v_start int;
  v_credit uuid;
  v_today date := (now() at time zone 'Europe/Prague')::date;
begin
  select * into d from debts
    where id = p_debt_id and status in ('OUTSTANDING', 'CLAIMED_PAID')
    for update;
  if not found then
    return false;
  end if;

  select t.category_id, t.account_id into v_cat, v_acc from transactions t where t.id = d.transaction_id;
  select month_start_day into v_start from profile where id = d.owner_id;

  insert into transactions
    (owner_id, budget_month, transaction_date, type, category_id, account_id, amount, note, source)
  values
    (d.owner_id,
     date_trunc('month', v_today - ((coalesce(v_start, 1) - 1) * interval '1 day'))::date,
     v_today, 'DEBT_SETTLEMENT_CREDIT', v_cat, coalesce(v_acc, d.target_account_id),
     d.amount, p_note, 'DEBT_SETTLEMENT')
  returning id into v_credit;

  update debts
    set status = 'SETTLED', settled_at = now(), settlement_transaction_id = v_credit,
        settled_via = 'FIO', fio_movement_id = p_movement_id
    where id = d.id;
  return true;
end;
$$;
revoke all on function public.fio_settle_debt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fio_settle_debt(uuid, text, text) to service_role;

-- ── public share page: expose only what the debtor needs ─────────────────
-- variable_symbol is returned only when the target account is Fio-linked
-- (otherwise it would be an unexplained number on the page).
alter type public.debt_share_view add attribute variable_symbol text;
alter type public.debt_share_view add attribute fio_enabled boolean;
alter type public.debt_share_view add attribute settled_automatically boolean;

create or replace function public.get_debt_by_share_token(p_token text)
returns setof public.debt_share_view
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_next text;
  v_token text;
  v_hops int := 0;
begin
  select d.status, d.merged_into_token into v_status, v_next
    from debts d
    where d.share_token = p_token;

  if not found then
    return; -- unknown or malformed token: no row, not an error (unchanged)
  end if;

  if v_status = 'MERGED' then
    v_token := v_next;
    while v_token is not null and v_hops < 20 loop
      select d.status, d.merged_into_token into v_status, v_next
        from debts d
        where d.share_token = v_token;
      exit when not found or v_status is distinct from 'MERGED';
      v_token := v_next;
      v_hops := v_hops + 1;
    end loop;

    return query select null::text, null::numeric, 'MERGED'::text, null::text, null::text, null::text, v_token,
      null::text, false, false;
    return;
  end if;

  return query
    select
      coalesce(d.message, t.note, c.name, 'Kasička') as description,
      d.amount,
      d.status,
      a.account_prefix as target_account_prefix,
      a.account_number as target_account_number,
      a.bank_code as target_bank_code,
      null::text as merged_into_token,
      case when f.fio then d.payment_vs end as variable_symbol,
      f.fio as fio_enabled,
      (d.settled_via = 'FIO') as settled_automatically
    from debts d
    left join transactions t on t.id = d.transaction_id
    left join categories c on c.id = t.category_id
    join accounts a on a.id = d.target_account_id
    cross join lateral (
      select a.bank_provider = 'FIO'
             and exists (select 1 from account_secrets s where s.account_id = a.id) as fio
    ) f
    where d.share_token = p_token;
end;
$$;

grant execute on function public.get_debt_by_share_token(text) to anon;
