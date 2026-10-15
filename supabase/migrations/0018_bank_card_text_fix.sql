-- Repair inbox rows created before the card-text fix in check-fio-payments:
-- Fio card payments arrive as "Nákup: SHOP, CITY, CZ, dne 13.10.2026, částka …".
-- The first version showed that whole line as the merchant and used Fio's
-- booking day instead of the purchase day. This fixes the rows already
-- imported (inbox + already-saved), and the merchant→category memory that
-- was built from the wrong text. New imports are already right once the
-- function is redeployed. Safe to run twice.
do $$
declare
  r record;
  raw text;
  merch text;
  k text;
  m text[];
  paid date;
  newdate date;
begin
  for r in
    select * from bank_transactions
    where details ~* '^(Nákup|Nakup|Platba kartou|Online platba)\s*:'
  loop
    m := regexp_match(r.details, '^(?:Nákup|Nakup|Platba kartou|Online platba)\s*:\s*([^,]+)', 'i');
    raw := btrim(regexp_replace(m[1], '\s+', ' ', 'g'));
    raw := regexp_replace(raw, '(\s+\d+)+$', '');
    merch := case when raw = upper(raw) then initcap(lower(raw)) else raw end;
    select string_agg(w, ' ' order by o) into k
      from (select w, o from unnest(regexp_split_to_array(lower(merch), '[^[:alpha:]]+')) with ordinality as u(w, o)
            where w <> '' order by o limit 2) x;

    m := regexp_match(r.details, 'dne:?\s+(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})', 'i');
    paid := null;
    if m is not null then
      begin
        paid := make_date(m[3]::int, m[2]::int, m[1]::int);
      exception when others then paid := null;
      end;
    end if;
    newdate := case when paid is not null and paid <= r.booked_date and paid >= r.booked_date - 10 then paid else r.booked_date end;

    update bank_transactions
      set merchant = coalesce(nullif(merch, ''), 'Bank payment'), merchant_key = coalesce(k, ''), details = raw, booked_date = newdate
      where id = r.id;

    if r.transaction_id is not null then
      update transactions
        set transaction_date = newdate,
            budget_month = bank_budget_month(r.owner_id, newdate),
            note = case when note = r.merchant then merch else note end,
            updated_at = now()
        where id = r.transaction_id and owner_id = r.owner_id;
    end if;
  end loop;
end $$;

-- the remembered merchants were keyed on "nakup alza"-style text: rebuild from what was saved
delete from bank_rules where match_key ~ '^(nákup|nakup|platba kartou|online platba)( |$)';

insert into bank_rules (owner_id, match_key, category_id, uses)
select distinct on (b.owner_id, b.merchant_key) b.owner_id, b.merchant_key, t.category_id, 1
from bank_transactions b
join transactions t on t.id = b.transaction_id
where b.status = 'POSTED' and b.amount < 0 and t.category_id is not null and b.merchant_key <> ''
order by b.owner_id, b.merchant_key, b.decided_at desc
on conflict (owner_id, match_key) do nothing;

update bank_transactions b
  set suggested_category_id = r.category_id, suggested_uses = r.uses
  from bank_rules r
  where b.owner_id = r.owner_id and b.merchant_key = r.match_key
    and b.status = 'NEW' and b.kind = 'EXPENSE' and b.amount < 0 and b.suggested_category_id is null;
