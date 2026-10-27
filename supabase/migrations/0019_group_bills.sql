-- Kasička — one bill, one link for the whole group.
--
-- A group is just a label over ordinary debts: every person is still a normal
-- `debts` row (so settling by hand, Fio auto-settle, the Debts page and
-- reports keep working unchanged); `debts.group_id` ties them together.
--
--   ONE_QR      even split. One QR + one link for everybody (amount = per_person,
--               variable symbol = group_vs). Each person taps their name = "I paid"
--               (the existing claim_debt_paid on their own token). The Fio check
--               then matches an incoming payment of one share with group_vs to the
--               oldest tapped person.
--   PER_PERSON  any amounts. One link lists everybody; picking your name opens
--               your own /d/<token> page with your own QR and symbol.

create table public.debt_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  target_account_id uuid not null references public.accounts (id) on delete restrict,
  mode text not null check (mode in ('ONE_QR', 'PER_PERSON')),
  message text,
  per_person numeric(12, 2) check (per_person > 0),
  -- Same sequence as debts.payment_vs, so the two can never collide.
  group_vs text not null default nextval('public.debt_payment_vs_seq')::text,
  share_token text not null unique default encode(gen_random_bytes(12), 'hex'),
  created_at timestamptz not null default now(),
  check (mode <> 'ONE_QR' or per_person is not null)
);
create unique index debt_groups_vs_key on public.debt_groups (group_vs);
create index debt_groups_owner_idx on public.debt_groups (owner_id);

alter table public.debt_groups enable row level security;
create policy "owner full access" on public.debt_groups
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.debts add column group_id uuid references public.debt_groups (id) on delete set null;
create index debts_group_idx on public.debts (group_id) where group_id is not null;

-- Public lookup for /g/<token>. Returns one JSON object (or NULL for an unknown
-- token). Members carry their own share_token: that is what the page uses to
-- call claim_debt_paid / undo_claim_debt_paid, or to open their own /d page.
create or replace function public.get_group_by_share_token(p_token text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'mode', g.mode,
    'description', coalesce(g.message, 'Kasička'),
    'per_person', g.per_person,
    'target_account_prefix', a.account_prefix,
    'target_account_number', a.account_number,
    'target_bank_code', a.bank_code,
    'fio_enabled', f.fio,
    'variable_symbol', case when f.fio then g.group_vs end,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', d.owed_by_name,
        'amount', d.amount,
        'token', d.share_token,
        'status', d.status,
        'automatic', coalesce(d.settled_via = 'FIO', false)
      ) order by d.created_at, d.id)
      from debts d
      where d.group_id = g.id and d.status <> 'MERGED'
    ), '[]'::jsonb)
  )
  from debt_groups g
  join accounts a on a.id = g.target_account_id
  cross join lateral (
    select a.bank_provider = 'FIO'
           and exists (select 1 from account_secrets s where s.account_id = a.id) as fio
  ) f
  where g.share_token = p_token;
$$;
grant execute on function public.get_group_by_share_token(text) to anon;
