-- Event/project-based expense tagging (Pavel: "mark some period e.g.
-- Weekend in Cracow and then automatically all bills would be marked with
-- this event... later I can filter by it in overview and/or prepare a
-- complex bill split"). See claude/event-based-expenses-v1.md for the full
-- design writeup this migration implements.

-- Owner-scoped tagging table — same shape as categories/accounts, not a
-- multi-tenant concept (data-model-v1.md's "no events/multi-tenant tables"
-- refers to that, not this).
create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index events_owner_active_idx on public.events (owner_id, active);

alter table public.events enable row level security;
create policy "owner full access" on public.events
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Nullable, on delete set null — deleting an event later must never take
-- real transactions or debts down with it.
alter table public.transactions add column event_id uuid references public.events (id) on delete set null;
create index transactions_owner_event_idx on public.transactions (owner_id, event_id);

-- debts.transaction_id has been nullable since 0009 for exactly this
-- reason: a combined amount that can't honestly point at one origin
-- transaction. An event-level split (one debt covering a whole event's
-- spend) is the same shape — transaction_id stays null, event_id says
-- which event it came from instead.
alter table public.debts add column event_id uuid references public.events (id) on delete set null;
