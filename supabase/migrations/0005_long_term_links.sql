-- Phase 3 — Long-term/reserve payments (build-roadmap-v1.md Phase 3).
--
-- transactions.long_term_item_id mirrors the recurring_item_id column added
-- in 0004: it links a RESERVE_TRANSFER or PAYMENT_FROM_RESERVE transaction
-- back to the long_term_items row that produced it, so the wizard (and
-- Planning's accrual progress bars) can answer "how much has been reserved
-- so far this cycle" and "has this cycle's final payment already been
-- made" precisely — source = 'LONG_TERM_QR' alone doesn't say *which* item.
--
-- long_term_items itself needs no schema change — every column the reserve
-- math and QR generation need (full_payment_amount, payment_month,
-- first_reserve_month, reserve_amount_mode, manual_monthly_reserve,
-- opening_reserve_balance, repeat_yearly, reserve_account_id, and the raw
-- target_account_prefix/number/bankcode + symbol fields for an external
-- payee) already exists from 0001_initial_schema.sql.

alter table transactions
  add column long_term_item_id uuid references long_term_items (id) on delete set null;

create index transactions_long_term_item_idx on transactions (long_term_item_id) where long_term_item_id is not null;
