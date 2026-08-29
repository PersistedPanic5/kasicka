-- Kasička — public debt-share access
-- Implements architecture-v1.md "The public debt-share link": a visitor
-- with nothing but a share_token (no login) can look up exactly one debt
-- and mark it CLAIMED_PAID. Nothing else about the account is reachable.
-- Both functions are SECURITY DEFINER so they can read/write `debts`
-- despite RLS, but each is deliberately narrow in what it accepts/returns.

create type public.debt_share_view as (
  description text,
  amount numeric,
  status text,
  target_account_prefix text,
  target_account_number text,
  target_bank_code text
);

-- Looks up a debt by its public token. Returns nothing (no row, not an
-- error) for an unknown or malformed token, so this can never be used to
-- probe which tokens exist. Description comes from the linked transaction's
-- note/category, never any other field on the transaction.
create or replace function public.get_debt_by_share_token(p_token text)
returns setof public.debt_share_view
language sql
security definer
set search_path = public
as $$
  select
    coalesce(t.note, c.name, 'Kasička') as description,
    d.amount,
    d.status,
    a.account_prefix as target_account_prefix,
    a.account_number as target_account_number,
    a.bank_code as target_bank_code
  from debts d
  join transactions t on t.id = d.transaction_id
  left join categories c on c.id = t.category_id
  join accounts a on a.id = d.target_account_id
  where d.share_token = p_token;
$$;

-- The one write a debtor is allowed to make: OUTSTANDING -> CLAIMED_PAID.
-- Silently a no-op for any other current status (already claimed/settled,
-- or an unknown token) rather than erroring, since a debtor double-tapping
-- "I've paid this" shouldn't see a scary failure.
create or replace function public.claim_debt_paid(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update debts
  set status = 'CLAIMED_PAID', claimed_paid_at = now()
  where share_token = p_token and status = 'OUTSTANDING';
$$;

-- Matches the mockup's "Undo" link on the just-claimed confirmation state.
create or replace function public.undo_claim_debt_paid(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update debts
  set status = 'OUTSTANDING', claimed_paid_at = null
  where share_token = p_token and status = 'CLAIMED_PAID';
$$;

-- Let the anon (signed-out) role call these three specific functions —
-- and nothing else. `debts`/`transactions`/`accounts` themselves stay
-- fully closed to anon via RLS from 0001.
grant execute on function public.get_debt_by_share_token(text) to anon;
grant execute on function public.claim_debt_paid(text) to anon;
grant execute on function public.undo_claim_debt_paid(text) to anon;
