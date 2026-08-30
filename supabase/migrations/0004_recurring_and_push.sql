-- Phase 2 — Recurring items + notifications foundation (build-roadmap-v1.md).
--
-- Three additions:
--   1. transactions.recurring_item_id — links a generated transaction back
--      to the recurring_items row that produced it, so "has this specific
--      recurring item already been confirmed for the current budget month?"
--      can be answered precisely. `source = 'RECURRING'` alone (already in
--      the 0001 schema) isn't enough for that once there's more than one
--      active recurring item, since it doesn't say *which* one.
--   2. push_subscriptions — one row per browser/device that has granted
--      Web Push permission (a user can have more than one: phone + laptop).
--      Standard PushSubscription shape (endpoint + the two encryption keys)
--      — see lib/push.ts.
--   3. A private "receipts" Storage bucket for the entry form's photo
--      capture, with owner-scoped RLS on storage.objects. Files are stored
--      under `<user_id>/<filename>`, matching the common Supabase Storage
--      per-user-folder convention, so the policy can check the first path
--      segment against auth.uid() without needing a database join.

-- ── transactions.recurring_item_id ──────────────────────────────────────
alter table transactions
  add column recurring_item_id uuid references recurring_items (id) on delete set null;

create index transactions_recurring_item_idx on transactions (recurring_item_id) where recurring_item_id is not null;

-- ── push_subscriptions ───────────────────────────────────────────────────
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index push_subscriptions_owner_idx on push_subscriptions (owner_id);

alter table push_subscriptions enable row level security;

create policy "owner full access" on push_subscriptions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- The daily due-items check (supabase/functions/check-recurring-due) reads
-- this table with the service role key, which bypasses RLS entirely — no
-- extra policy needed for that.

-- ── receipts storage bucket ─────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "owner read own receipts" on storage.objects
  for select using (
    bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owner upload own receipts" on storage.objects
  for insert with check (
    bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owner delete own receipts" on storage.objects
  for delete using (
    bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text
  );
