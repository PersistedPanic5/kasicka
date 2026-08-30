-- ============================================================================
-- One-time cleanup: merge duplicate "Cash" accounts (and any duplicate
-- categories) created by the bootstrap race condition that lib/bootstrap.ts
-- used to have. Not a migration — this is a one-off data fix, meant to be
-- pasted into the Supabase SQL Editor and run by hand once.
--
-- Background: ensureBootstrapped() used to check "does a profile row exist
-- for this user yet?" and then, if not, insert an account + categories +
-- profile as three separate calls. Two concurrent sign-ins for the same
-- user (two browser tabs open at once, or two components on the same page
-- each calling useAppData() independently) could both pass that check
-- before either insert had landed, so both went on to create their own
-- "Cash" account (and potentially their own full set of default
-- categories). The code has been fixed to make this atomic going forward
-- (see the comment at the top of lib/bootstrap.ts) — this script cleans up
-- any duplicates that already exist from before that fix.
--
-- What it does, per user, independently:
--   1. Groups accounts by (owner_id, name, account_type) and keeps the
--      oldest row (by created_at, then id) as the "keeper"; every other row
--      in a group is a "duplicate".
--   2. Repoints every foreign key that can reference an account
--      (transactions.account_id, debts.target_account_id,
--      recurring_items.account_id, long_term_items.reserve_account_id,
--      profile.default_account_id) from each duplicate to its keeper.
--   3. Deletes the now-unreferenced duplicate accounts.
--   4. Does the same for categories, grouped by (owner_id, name,
--      category_type) — categories have no created_at column, so ties are
--      broken by id instead; that only affects which physical row survives
--      (same name either way), never correctness.
--      monthly_budgets has a UNIQUE (owner_id, budget_month, category_id)
--      constraint, so before repointing it, any duplicate-side budget row
--      that would collide with a keeper-side row for the same month is
--      deleted first (the keeper's own row for that month wins).
--
-- A user with no duplicates is untouched — every step here only ever
-- selects rows where a duplicate genuinely exists.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL Editor.
--   - To preview with zero risk first, change the final COMMIT to ROLLBACK,
--     run it, and check the summary row it prints (accounts_merged /
--     categories_merged) — nothing will actually change.
--   - When you're happy, change it back to COMMIT and run it for real.
--   - Safe to run more than once: if there's nothing left to merge, both
--     temp tables come back empty and it's a no-op.
-- ============================================================================

BEGIN;

-- ---- Accounts ---------------------------------------------------------

CREATE TEMP TABLE _account_dupes ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY owner_id, name, account_type
      ORDER BY created_at ASC, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY owner_id, name, account_type
      ORDER BY created_at ASC, id ASC
    ) AS keeper_id
  FROM accounts
)
SELECT id AS dup_id, keeper_id
FROM ranked
WHERE rn > 1;

-- Repoint every FK that can point at an account, from duplicate -> keeper.
UPDATE transactions t
SET account_id = d.keeper_id
FROM _account_dupes d
WHERE t.account_id = d.dup_id;

UPDATE debts deb
SET target_account_id = d.keeper_id
FROM _account_dupes d
WHERE deb.target_account_id = d.dup_id;

UPDATE recurring_items r
SET account_id = d.keeper_id
FROM _account_dupes d
WHERE r.account_id = d.dup_id;

UPDATE long_term_items l
SET reserve_account_id = d.keeper_id
FROM _account_dupes d
WHERE l.reserve_account_id = d.dup_id;

UPDATE profile p
SET default_account_id = d.keeper_id
FROM _account_dupes d
WHERE p.default_account_id = d.dup_id;

-- Now safe to delete — nothing references the duplicate rows any more.
DELETE FROM accounts a
USING _account_dupes d
WHERE a.id = d.dup_id;

-- ---- Categories ---------------------------------------------------------

CREATE TEMP TABLE _category_dupes ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY owner_id, name, category_type
      ORDER BY id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY owner_id, name, category_type
      ORDER BY id ASC
    ) AS keeper_id
  FROM categories
)
SELECT id AS dup_id, keeper_id
FROM ranked
WHERE rn > 1;

-- monthly_budgets has UNIQUE (owner_id, budget_month, category_id). If both
-- a duplicate category and its keeper already have a budget row for the
-- same month, repointing the duplicate's row onto the keeper would violate
-- that constraint — so drop the duplicate-side row in that case; the
-- keeper's own row for that month (if any) is left exactly as it is.
DELETE FROM monthly_budgets mb
USING _category_dupes d
WHERE mb.category_id = d.dup_id
  AND EXISTS (
    SELECT 1 FROM monthly_budgets keeper_mb
    WHERE keeper_mb.category_id = d.keeper_id
      AND keeper_mb.owner_id = mb.owner_id
      AND keeper_mb.budget_month = mb.budget_month
  );

UPDATE monthly_budgets mb
SET category_id = d.keeper_id
FROM _category_dupes d
WHERE mb.category_id = d.dup_id;

UPDATE transactions t
SET category_id = d.keeper_id
FROM _category_dupes d
WHERE t.category_id = d.dup_id;

UPDATE recurring_items r
SET category_id = d.keeper_id
FROM _category_dupes d
WHERE r.category_id = d.dup_id;

UPDATE long_term_items l
SET category_id = d.keeper_id
FROM _category_dupes d
WHERE l.category_id = d.dup_id;

-- Now safe to delete — nothing references the duplicate rows any more.
DELETE FROM categories c
USING _category_dupes d
WHERE c.id = d.dup_id;

-- ---- Summary --------------------------------------------------------------
-- Row counts of what was just merged. Check this before trusting COMMIT —
-- or read it after a ROLLBACK run to preview with no risk.

SELECT
  (SELECT count(*) FROM _account_dupes) AS accounts_merged,
  (SELECT count(*) FROM _category_dupes) AS categories_merged;

COMMIT;
