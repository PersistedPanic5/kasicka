-- Kasička — a debt-specific payment message
-- Lets the "split with someone" panel set a message just for that debt's
-- shareable link / QR code, independent of the transaction's own note
-- (e.g. the transaction note might be "Concert tickets" while the debt
-- message says "for both our tickets" — or they're just the same thing,
-- since the description on the public page still falls back through
-- debt message -> transaction note -> category name).

alter table debts add column message text;

create or replace function public.get_debt_by_share_token(p_token text)
returns setof public.debt_share_view
language sql
security definer
set search_path = public
as $$
  select
    coalesce(d.message, t.note, c.name, 'Kasička') as description,
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
