-- Record Expense: a lightweight "what did I just input" list under Save,
-- so Pavel can tell at a glance whether something's already logged instead
-- of guessing or flipping over to Transactions (his report: "I am inputing
-- the expenses but then I am not sure what exactly have I already input").
-- Configurable in Settings → Recent inputs: on/off, how many rows, and
-- whether it's always the last N overall or just the last N in whichever
-- category is currently selected on the form. Defaults to enabled — same
-- reasoning as 0008_quick_amounts_toggle.sql's quick_amounts_enabled: a
-- passive, read-only convenience, not something that needs an opt-in.
alter table public.profile
  add column if not exists recent_inputs_enabled boolean not null default true,
  add column if not exists recent_inputs_count int not null default 5 check (recent_inputs_count between 1 and 20),
  add column if not exists recent_inputs_scope text not null default 'all' check (recent_inputs_scope in ('all', 'category'));
