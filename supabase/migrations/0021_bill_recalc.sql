-- Kasička — editing the debts inside a "bill with details" (0020).
--
-- A bill's amount is always: sum of its included debts (their net amounts)
-- minus the reciprocated expenses entered on the bill itself. When one of
-- the included debts changes (amount edited, reciprocated expense added or
-- removed, debt deleted) the bill is recalculated here, so the QR / Fio
-- matching / "Confirm settled" keep using the right number without any
-- client-side bookkeeping. Settled bills are never touched.

create or replace function public.recalc_bill(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b debts%rowtype;
  v_sum numeric;
  v_off numeric;
begin
  select * into b from debts
   where share_token = p_token and breakdown and status in ('OUTSTANDING', 'CLAIMED_PAID')
   for update;
  if not found then
    return;
  end if;
  select coalesce(sum(amount), 0) into v_sum from debts where merged_into_token = p_token and status = 'MERGED';
  select coalesce(sum(amount), 0) into v_off from debt_offsets where debt_id = b.id;
  if v_sum - v_off <= 0 then
    raise exception 'reciprocated expenses would cancel the whole debt' using errcode = 'P0001';
  end if;
  update debts
     set amount = v_sum - v_off,
         base_amount = case when v_off > 0 then v_sum else null end
   where id = b.id;
end;
$$;
revoke all on function public.recalc_bill(text) from public, anon, authenticated;

create or replace function public.debts_child_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'MERGED' and old.merged_into_token is not null then
      perform public.recalc_bill(old.merged_into_token);
    end if;
    return old;
  end if;
  if new.status = 'MERGED' and new.merged_into_token is not null and new.amount is distinct from old.amount then
    perform public.recalc_bill(new.merged_into_token);
  end if;
  return new;
end;
$$;
revoke all on function public.debts_child_changed() from public, anon, authenticated;

drop trigger if exists debts_child_amount_changed on public.debts;
create trigger debts_child_amount_changed
  after update of amount on public.debts
  for each row execute function public.debts_child_changed();
drop trigger if exists debts_child_deleted on public.debts;
create trigger debts_child_deleted
  after delete on public.debts
  for each row execute function public.debts_child_changed();

-- Reciprocated expenses may now also be put on an included debt, as long as its bill is still open.
create or replace function public.recalc_debt_amount(p_debt uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d debts%rowtype;
  v_sum numeric;
  v_base numeric;
  v_open boolean;
begin
  select * into d from debts where id = p_debt for update;
  if not found then
    return; -- the debt itself is being deleted
  end if;
  select coalesce(sum(amount), 0) into v_sum from debt_offsets where debt_id = p_debt;
  if v_sum = 0 then
    if d.base_amount is not null then
      update debts set amount = base_amount, base_amount = null where id = p_debt;
    end if;
    return;
  end if;
  v_open := d.status in ('OUTSTANDING', 'CLAIMED_PAID')
    or (d.status = 'MERGED' and exists (
         select 1 from debts p
          where p.share_token = d.merged_into_token and p.breakdown and p.status in ('OUTSTANDING', 'CLAIMED_PAID')));
  if not v_open then
    raise exception 'this debt is already closed' using errcode = 'P0001';
  end if;
  v_base := coalesce(d.base_amount, d.amount);
  if v_base - v_sum <= 0 then
    raise exception 'reciprocated expenses would cancel the whole debt' using errcode = 'P0001';
  end if;
  update debts set base_amount = v_base, amount = v_base - v_sum where id = p_debt;
end;
$$;
revoke all on function public.recalc_debt_amount(uuid) from public, anon, authenticated;
