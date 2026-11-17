-- Kasička — richer debts: details text, reciprocated expenses, attached files,
-- itemised "bills" (several expenses, ONE QR) and a link that lives on.
--
-- 1) debts.details         long free-text description of the split (optional).
-- 2) debt_offsets          "reciprocated expenses": things the debtor paid for you.
--                          They REDUCE what is payable (6000 bill, 5000 owed, she paid
--                          lunch 200 for you -> 4800 payable) but stay visible as a
--                          line on the link. A trigger keeps debts.amount = NET payable,
--                          so the QR, Fio matching and "Confirm settled" keep working
--                          unchanged; debts.base_amount remembers the gross.
-- 3) debt_files            PDF / image attachments on a debt or on one reciprocated
--                          expense (private `receipts` bucket; the public link gets
--                          short-lived signed URLs through the debt-file function).
--                          The receipt attached to the originating expense is shown too
--                          unless debts.hide_receipt is set.
-- 4) debts.breakdown       a "bill": one payable row (own QR + variable symbol) whose
--                          children are the folded-in expenses (status MERGED,
--                          merged_into_token = the bill's token). Unlike a plain merge
--                          the debtor SEES every child with its details/files.
--                          bill_merge() creates a bill, or adds to an existing one.
-- 5) get_debt_bill()       the public page's single lookup: resolves a (possibly old)
--                          link to the person's CURRENT bill — a settled debt's link
--                          continues to their next open debt — and returns details,
--                          reciprocated lines, files, items and a past-debts overview.

-- merged_from exists in production (added by hand as "0010", which is not in the repo); idempotent here.
alter table public.debts add column if not exists merged_from jsonb;
alter table public.debts add column details text;
alter table public.debts add column base_amount numeric(12, 2);
alter table public.debts add column breakdown boolean not null default false;
alter table public.debts add column hide_receipt boolean not null default false;

-- ── reciprocated expenses ────────────────────────────────────────────────
create table public.debt_offsets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  debt_id uuid not null references public.debts (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  note text,
  offset_date date not null default current_date,
  created_at timestamptz not null default now()
);
create index debt_offsets_debt_idx on public.debt_offsets (debt_id);

-- ── attached files ───────────────────────────────────────────────────────
create table public.debt_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  debt_id uuid not null references public.debts (id) on delete cascade,
  offset_id uuid references public.debt_offsets (id) on delete cascade,
  path text not null,
  name text not null,
  mime text,
  created_at timestamptz not null default now()
);
create index debt_files_debt_idx on public.debt_files (debt_id);

alter table public.debt_offsets enable row level security;
alter table public.debt_files enable row level security;
-- The row must be mine AND point at one of my debts (the trigger below is SECURITY
-- DEFINER, so without the second check somebody could adjust another user's debt).
create policy "owner full access" on public.debt_offsets
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid()
    and exists (select 1 from public.debts d where d.id = debt_id and d.owner_id = auth.uid()));
-- ...and the file must live in my own storage folder (otherwise a stranger's path could
-- be attached to my debt and then signed through the public link).
create policy "owner full access" on public.debt_files
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid()
    and split_part(path, '/', 1) = auth.uid()::text
    and exists (select 1 from public.debts d where d.id = debt_id and d.owner_id = auth.uid()));

-- ── keep debts.amount = gross − reciprocated expenses ───────────────────
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
  if d.status not in ('OUTSTANDING', 'CLAIMED_PAID') then
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

create or replace function public.debt_offsets_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.recalc_debt_amount(old.debt_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.debt_id is distinct from old.debt_id) then
    perform public.recalc_debt_amount(new.debt_id);
  end if;
  return null;
end;
$$;
revoke all on function public.debt_offsets_changed() from public, anon, authenticated;
create trigger debt_offsets_changed
  after insert or update or delete on public.debt_offsets
  for each row execute function public.debt_offsets_changed();

-- ── bills: one QR, itemised ──────────────────────────────────────────────
-- p_ids: the debts to combine. If exactly one of them is already a bill (open), the
-- others are added to it — same link, same QR symbol, higher amount, status back to
-- OUTSTANDING (the total changed). Otherwise a new bill is created over them.
-- Returns the bill's share_token. Runs with the caller's rights (RLS applies).
create or replace function public.bill_merge(p_ids uuid[], p_name text, p_message text)
returns text
language plpgsql
set search_path = public
as $$
declare
  n int;
  v_bills int;
  v_accounts int;
  v_total numeric;
  v_snap jsonb;
  bill debts%rowtype;
  v_token text;
  v_target uuid;
begin
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) < 2 then
    raise exception 'pick at least two debts';
  end if;
  select count(*), count(*) filter (where breakdown), count(distinct target_account_id)
    into n, v_bills, v_accounts
    from debts where id = any (p_ids) and owner_id = auth.uid();
  if n <> array_length(p_ids, 1) then
    raise exception 'debt not found';
  end if;
  if v_bills > 1 then
    raise exception 'only one existing bill can be extended';
  end if;
  if v_accounts > 1 then
    raise exception 'these debts are paid into different accounts';
  end if;
  if exists (
    select 1 from debts
    where id = any (p_ids)
      and not (status = 'OUTSTANDING' or (breakdown and status = 'CLAIMED_PAID'))
  ) then
    raise exception 'only outstanding debts can be combined';
  end if;

  if v_bills = 1 then
    select * into bill from debts where id = any (p_ids) and breakdown for update;
    select coalesce(sum(amount), 0),
           coalesce(jsonb_agg(jsonb_build_object(
             'owed_by_name', owed_by_name, 'amount', amount, 'message', message,
             'transaction_id', transaction_id, 'target_account_id', target_account_id,
             'merged_from', merged_from)), '[]'::jsonb)
      into v_total, v_snap
      from debts where id = any (p_ids) and id <> bill.id;
    update debts set status = 'MERGED', merged_into_token = bill.share_token
      where id = any (p_ids) and id <> bill.id;
    update debts set
        amount = amount + v_total,
        base_amount = case when base_amount is null then null else base_amount + v_total end,
        status = 'OUTSTANDING',
        claimed_paid_at = null,
        merged_from = coalesce(merged_from, '[]'::jsonb) || v_snap
      where id = bill.id;
    return bill.share_token;
  end if;

  select coalesce(sum(amount), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'owed_by_name', owed_by_name, 'amount', amount, 'message', message,
           'transaction_id', transaction_id, 'target_account_id', target_account_id,
           'merged_from', merged_from) order by created_at), '[]'::jsonb),
         (array_agg(target_account_id order by created_at))[1]
    into v_total, v_snap, v_target
    from debts where id = any (p_ids);
  insert into debts (owner_id, transaction_id, owed_by_name, amount, target_account_id, message, breakdown, merged_from)
    values (auth.uid(), null, btrim(p_name), v_total, v_target, nullif(btrim(coalesce(p_message, '')), ''), true, v_snap)
    returning share_token into v_token;
  update debts set status = 'MERGED', merged_into_token = v_token where id = any (p_ids);
  return v_token;
end;
$$;
revoke all on function public.bill_merge(uuid[], text, text) from public, anon;
grant execute on function public.bill_merge(uuid[], text, text) to authenticated;

-- ── public lookup helpers (not callable by clients) ──────────────────────
create or replace function public._file_mime(p_name text)
returns text
language sql
immutable
as $$
  select case lower(coalesce(substring(p_name from '\.([A-Za-z0-9]+)$'), ''))
    when 'pdf' then 'application/pdf'
    when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png' when 'webp' then 'image/webp'
    when 'gif' then 'image/gif' when 'heic' then 'image/heic'
    else 'application/octet-stream' end;
$$;

-- Files the debtor may see for a debt: the originating expense's receipt (unless hidden)
-- and the files attached to the debt itself. Reciprocated-expense files come with the offset.
create or replace function public._debt_files(p_debt uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.ord, x.created), '[]'::jsonb)
  from (
    select 0 as ord, d.created_at as created,
           jsonb_build_object(
             'id', 'tx:' || t.id::text,
             'name', 'receipt.' || lower(coalesce(substring(t.receipt_photo_url from '\.([A-Za-z0-9]+)$'), 'jpg')),
             'mime', public._file_mime(t.receipt_photo_url)) as j
      from debts d join transactions t on t.id = d.transaction_id
      where d.id = p_debt and not d.hide_receipt and t.receipt_photo_url is not null
    union all
    select 1, f.created_at,
           jsonb_build_object('id', f.id::text, 'name', f.name, 'mime', coalesce(f.mime, public._file_mime(f.name)))
      from debt_files f where f.debt_id = p_debt and f.offset_id is null
  ) x;
$$;
revoke all on function public._debt_files(uuid) from public, anon, authenticated;

create or replace function public._debt_offsets(p_debt uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'amount', o.amount,
      'note', o.note,
      'date', o.offset_date,
      'files', coalesce((
        select jsonb_agg(jsonb_build_object('id', f.id::text, 'name', f.name, 'mime', coalesce(f.mime, public._file_mime(f.name))) order by f.created_at)
        from debt_files f where f.offset_id = o.id), '[]'::jsonb)
    ) order by o.offset_date, o.created_at), '[]'::jsonb)
  from debt_offsets o where o.debt_id = p_debt;
$$;
revoke all on function public._debt_offsets(uuid) from public, anon, authenticated;

-- ── the public page's lookup ─────────────────────────────────────────────
create or replace function public.get_debt_bill(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a debts%rowtype;   -- the debt the visitor's link points at
  h debts%rowtype;   -- the debt to show (the person's current one)
  n debts%rowtype;
  v_hops int := 0;
  v_token text;
  v_status text;
  v_next text;
begin
  select * into a from debts where share_token = p_token;
  if not found then
    return null; -- unknown token: nothing, not an error
  end if;

  if a.status = 'MERGED' then
    -- Folded into another debt: hand the visitor the current token (same walk as before).
    v_token := a.merged_into_token;
    while v_token is not null and v_hops < 20 loop
      select d.status, d.merged_into_token into v_status, v_next from debts d where d.share_token = v_token;
      exit when not found or v_status is distinct from 'MERGED';
      v_token := v_next;
      v_hops := v_hops + 1;
    end loop;
    return jsonb_build_object('status', 'MERGED', 'merged_into_token', v_token);
  end if;

  h := a;
  if a.status = 'SETTLED' then
    -- The link lives on: the person's next open debt (oldest first) takes over.
    select * into n from debts
      where owner_id = a.owner_id
        and lower(btrim(owed_by_name)) = lower(btrim(a.owed_by_name))
        and status in ('OUTSTANDING', 'CLAIMED_PAID')
        and created_at > a.created_at
      order by created_at
      limit 1;
    if found then
      h := n;
    end if;
  end if;

  return (
    select jsonb_build_object(
      'status', h.status,
      'token', h.share_token,
      'continued', h.id <> a.id,
      'amount', h.amount,
      'base_amount', h.base_amount,
      'breakdown', h.breakdown,
      'description', coalesce(h.message, t.note, c.name, 'Kasička'),
      'details', h.details,
      'date', coalesce(t.transaction_date, (h.created_at at time zone 'Europe/Prague')::date),
      'target_account_prefix', ac.account_prefix,
      'target_account_number', ac.account_number,
      'target_bank_code', ac.bank_code,
      'fio_enabled', f.fio,
      'variable_symbol', case when f.fio then h.payment_vs end,
      'settled_automatically', coalesce(h.settled_via = 'FIO', false),
      'offsets', public._debt_offsets(h.id),
      'files', public._debt_files(h.id),
      'items', case when h.breakdown then coalesce((
          select jsonb_agg(jsonb_build_object(
              'title', coalesce(ch.message, ct.note, cc.name, 'Kasička'),
              'amount', ch.amount,
              'base_amount', ch.base_amount,
              'details', ch.details,
              'date', coalesce(ct.transaction_date, (ch.created_at at time zone 'Europe/Prague')::date),
              'offsets', public._debt_offsets(ch.id),
              'files', public._debt_files(ch.id)
            ) order by ch.created_at, ch.id)
          from debts ch
          left join transactions ct on ct.id = ch.transaction_id
          left join categories cc on cc.id = ct.category_id
          where ch.merged_into_token = h.share_token and ch.status = 'MERGED'
        ), '[]'::jsonb) else '[]'::jsonb end,
      'past', coalesce((
          select jsonb_agg(jsonb_build_object(
              'amount', s.amount,
              'paid_on', (s.settled_at at time zone 'Europe/Prague')::date,
              'title', coalesce(s.message, st.note, sc.name)
            ) order by s.settled_at desc)
          from (
            select * from debts
            where owner_id = h.owner_id
              and lower(btrim(owed_by_name)) = lower(btrim(h.owed_by_name))
              and status = 'SETTLED' and id <> h.id and settled_at is not null
            order by settled_at desc limit 50
          ) s
          left join transactions st on st.id = s.transaction_id
          left join categories sc on sc.id = st.category_id
        ), '[]'::jsonb)
    )
    from (select 1) one
    left join transactions t on t.id = h.transaction_id
    left join categories c on c.id = t.category_id
    join accounts ac on ac.id = h.target_account_id
    cross join lateral (
      select ac.bank_provider = 'FIO'
             and exists (select 1 from account_secrets s2 where s2.account_id = ac.id) as fio
    ) f
  );
end;
$$;
grant execute on function public.get_debt_bill(text) to anon;

-- Which storage path may be shown for this link? Used only by the debt-file Edge
-- Function (service role): the file id must appear in what get_debt_bill() returns.
create or replace function public.debt_file_path(p_token text, p_file_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  j jsonb;
  v_path text;
begin
  j := public.get_debt_bill(p_token);
  if j is null or not jsonb_path_exists(j, '$.** ? (@.id == $fid)', jsonb_build_object('fid', to_jsonb(p_file_id))) then
    return null;
  end if;
  if p_file_id like 'tx:%' then
    select t.receipt_photo_url into v_path from transactions t where t.id = substr(p_file_id, 4)::uuid;
  else
    select f.path into v_path from debt_files f where f.id = p_file_id::uuid;
  end if;
  return v_path;
end;
$$;
revoke all on function public.debt_file_path(text, text) from public, anon, authenticated;
grant execute on function public.debt_file_path(text, text) to service_role;
