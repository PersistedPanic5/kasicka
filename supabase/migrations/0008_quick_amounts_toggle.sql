-- Lets Pavel turn off the quick-amount shortcut chips on Record Expense
-- entirely, instead of the row always falling back to a default set
-- (20/50/100/200) whenever profile.amount_buttons is empty. Defaulting to
-- true keeps today's behavior unchanged for everyone until they flip it
-- off in Settings → Quick amounts.
alter table public.profile
  add column if not exists quick_amounts_enabled boolean not null default true;
