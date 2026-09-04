-- Kasička — support for merging multiple debts into one (Pavel: "suddenly
-- I have one person with like 3 bills and I need to share 3 links with
-- them" — Debts page gets a select-two-and-confirm Merge action).
--
-- A merged debt combines debts that may come from different original
-- expense transactions (possibly different categories), so it can't
-- honestly point transaction_id at any single one of them — nullable lets
-- it point at none, rather than silently misattributing the combined
-- amount to whichever origin transaction happened to be picked.
alter table debts alter column transaction_id drop not null;

-- get_debt_by_share_token (0003) used `join transactions` — an INNER join,
-- which would make a merged debt's public link resolve to zero rows once
-- transaction_id can be null. Switched to LEFT JOIN; the coalesce() still
-- works fine since a merged debt always gets an explicit d.message.
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
  left join transactions t on t.id = d.transaction_id
  left join categories c on c.id = t.category_id
  join accounts a on a.id = d.target_account_id
  where d.share_token = p_token;
$$;
