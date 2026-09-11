-- Recent inputs (migration 0012) now also shows each row's category, next
-- to whatever note/amount/date it already had — Pavel: "add a category
-- info to the list of last expenses". A long category name would wrap or
-- push the amount/date off a lightweight one-line row, so it's truncated
-- to a configurable character count (his: "shorten it to 8 signs or
-- something like that... have this in the settings as well") rather than
-- a fixed cutoff baked into the code.
alter table public.profile
  add column if not exists recent_inputs_category_chars int not null default 8
    check (recent_inputs_category_chars between 3 and 24);
