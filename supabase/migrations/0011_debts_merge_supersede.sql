-- Kasička — merged debts point to their replacement instead of vanishing.
--
-- Pavel's report: he shared a debt's QR link, then added more debts for the
-- same person and merged them under a new link before his friend paid. The
-- friend paid the NEW link, then reopened the OLD one (the one he'd
-- actually been sent first) — which showed the generic "this link isn't
-- valid" message, because merging used to hard-delete the folded-in debt
-- rows (see 0009_debts_merge_support.sql's confirmMerge and
-- lib/split-people.ts's createOrMergeDebtsForSplit, both of which deleted
-- the source row right after inserting its replacement).
--
-- Fix: a merge now marks the folded-in debt(s) MERGED and points them at
-- the replacement's share_token instead of deleting them. The public share
-- page (app/d/[token].tsx) can then tell a visitor who opens a superseded
-- link that it was merged and hand them the current one, instead of a
-- dead end that looks like a mistake or a scam.

alter table debts drop constraint debts_status_check;
alter table debts add constraint debts_status_check
  check (status in ('OUTSTANDING', 'CLAIMED_PAID', 'SETTLED', 'MERGED'));

-- Points a MERGED debt at whichever debt replaced it (by share_token, same
-- key the public page already looks up by — no need to expose or join on
-- internal ids). `on delete set null` rather than cascade: deleting the
-- *replacement* debt later shouldn't cascade into deleting the history of
-- what was folded into it — it just leaves the pointer empty, and the
-- share page falls back to a plainer "no longer available" message in
-- that rare case rather than a link to nowhere.
alter table debts add column merged_into_token text
  references debts (share_token) on delete set null;

create index debts_merged_into_token_idx on debts (merged_into_token)
  where merged_into_token is not null;

-- get_debt_by_share_token now needs to hand back a MERGED status plus
-- where to go next, so the share page can show that notice instead of
-- pretending the debt is still OUTSTANDING or claiming the link is
-- invalid. Rewritten as plpgsql so it can walk the merge chain: a merged
-- debt can itself later be merged again (Pavel merges again next month),
-- so this resolves all the way to the current, non-merged token — a
-- visitor should never have to click through "merged" more than once.
-- Capped at 20 hops purely as a guard against a corrupt cycle, not a
-- realistic chain length.
alter type public.debt_share_view add attribute merged_into_token text;

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

    -- v_token is now either the current live token to send the visitor
    -- to, or null if that chain dead-ends (the replacement itself was
    -- since deleted) — either way, no payment details go out for a
    -- superseded link, only the merged flag and where to go next.
    return query select null::text, null::numeric, 'MERGED'::text, null::text, null::text, null::text, v_token;
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
      null::text as merged_into_token
    from debts d
    left join transactions t on t.id = d.transaction_id
    left join categories c on c.id = t.category_id
    join accounts a on a.id = d.target_account_id
    where d.share_token = p_token;
end;
$$;

grant execute on function public.get_debt_by_share_token(text) to anon;
