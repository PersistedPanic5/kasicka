/**
 * Hand-written types matching supabase/migrations/0001_initial_schema.sql
 * and 0002_public_debt_share.sql (which mirror claude/data-model-v1.md and
 * architecture-v1.md "The public debt-share link" in the project).
 *
 * TODO(Phase 0, once the Supabase project exists): replace this file with
 * the real generated types via `supabase gen types typescript` so it can
 * never drift from the actual database — this hand-written version is a
 * starting point for coding against before that project exists, not a
 * long-term source of truth.
 *
 * Row/Insert/Update types are each written out directly rather than derived
 * from `Database['public']['Tables'][...]` — matches what `supabase gen
 * types` itself emits, so switching to the real generated file later is a
 * drop-in swap rather than a restructure.
 *
 * IMPORTANT — see the @supabase/supabase-js version pin in package.json:
 * every published version from 2.56.0 through the current 2.112.4 has a
 * real regression where `supabase.rpc(name, args)` silently infers `args`
 * as `undefined` (a compile error on any real call) the moment the
 * Database type has both a Tables entry and a Functions entry — confirmed
 * by bisecting a minimal repro down to a single trivial table. 2.55.0 is
 * the last version before that broke. Don't bump this dependency without
 * re-testing `supabase.rpc(...)` against a schema with real Tables first.
 */

export type AccountType = 'BANK' | 'CASH' | 'SAVINGS' | 'RESERVE' | 'CARD';
export type CategoryType = 'EXPENSE' | 'INCOME';
export type TransactionType =
  | 'EXPENSE'
  | 'INCOME'
  | 'RESERVE_TRANSFER'
  | 'PAYMENT_FROM_RESERVE'
  | 'DEBT_SETTLEMENT_CREDIT';
export type TransactionStatus = 'PAID' | 'VOID';
export type TransactionSource = 'MANUAL' | 'RECURRING' | 'LONG_TERM_QR' | 'DEBT_SETTLEMENT';
export type RecurringFrequency = 'MONTHLY' | 'YEARLY';
export type ReserveAmountMode = 'AUTO' | 'MANUAL';
export type DebtStatus = 'OUTSTANDING' | 'CLAIMED_PAID' | 'SETTLED';
export type ThemeMode = 'light' | 'dark';

export interface Profile {
  id: string;
  default_account_id: string | null;
  month_start_day: number;
  amount_buttons: number[];
  notification_prefs: Record<string, unknown>;
  expo_push_token: string | null;
  theme: ThemeMode;
  language: 'en' | 'cs';
}
export type ProfileInsert = Partial<Profile> & Pick<Profile, 'id'>;
export type ProfileUpdate = Partial<Profile>;

export interface Account {
  id: string;
  name: string;
  account_type: AccountType;
  account_prefix: string | null;
  account_number: string | null;
  bank_code: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
}
export type AccountInsert = Partial<Account> & Pick<Account, 'name' | 'account_type'>;
export type AccountUpdate = Partial<Account>;

export interface Category {
  id: string;
  name: string;
  category_type: CategoryType;
  default_monthly_budget: number;
  sort_order: number;
  active: boolean;
}
export type CategoryInsert = Partial<Category> & Pick<Category, 'name' | 'category_type'>;
export type CategoryUpdate = Partial<Category>;

export interface MonthlyBudget {
  id: string;
  budget_month: string; // 'yyyy-mm-01'
  category_id: string;
  planned_amount: number;
}
export type MonthlyBudgetInsert = Partial<MonthlyBudget> &
  Pick<MonthlyBudget, 'budget_month' | 'category_id' | 'planned_amount'>;
export type MonthlyBudgetUpdate = Partial<MonthlyBudget>;

export interface Transaction {
  id: string;
  budget_month: string;
  transaction_date: string;
  type: TransactionType;
  category_id: string | null;
  account_id: string;
  amount: number;
  note: string | null;
  status: TransactionStatus;
  source: TransactionSource;
  receipt_photo_url: string | null;
  created_at: string;
  updated_at: string;
}
export type TransactionInsert = Partial<Transaction> &
  Pick<Transaction, 'transaction_date' | 'type' | 'account_id' | 'amount'>;
export type TransactionUpdate = Partial<Transaction>;

export interface RecurringItem {
  id: string;
  name: string;
  category_id: string;
  account_id: string;
  amount: number;
  frequency: RecurringFrequency;
  day_of_month: number;
  active: boolean;
}
export type RecurringItemInsert = Partial<RecurringItem> &
  Pick<RecurringItem, 'name' | 'category_id' | 'account_id' | 'amount' | 'frequency' | 'day_of_month'>;
export type RecurringItemUpdate = Partial<RecurringItem>;

export interface LongTermItem {
  id: string;
  name: string;
  category_id: string;
  full_payment_amount: number;
  payment_month: string;
  first_reserve_month: string;
  reserve_amount_mode: ReserveAmountMode;
  manual_monthly_reserve: number | null;
  opening_reserve_balance: number;
  repeat_yearly: boolean;
  reserve_account_id: string | null;
  target_account_prefix: string | null;
  target_account_number: string | null;
  target_bank_code: string | null;
  variable_symbol: string | null;
  constant_symbol: string | null;
  specific_symbol: string | null;
  payment_message: string | null;
  active: boolean;
}
export type LongTermItemInsert = Partial<LongTermItem> &
  Pick<LongTermItem, 'name' | 'category_id' | 'full_payment_amount' | 'payment_month' | 'first_reserve_month' | 'reserve_amount_mode'>;
export type LongTermItemUpdate = Partial<LongTermItem>;

export interface Debt {
  id: string;
  transaction_id: string;
  owed_by_name: string;
  amount: number;
  target_account_id: string;
  status: DebtStatus;
  share_token: string;
  claimed_paid_at: string | null;
  settled_at: string | null;
  settlement_transaction_id: string | null;
  created_at: string;
}
export type DebtInsert = Partial<Debt> &
  Pick<Debt, 'transaction_id' | 'owed_by_name' | 'amount' | 'target_account_id'>;
export type DebtUpdate = Partial<Debt>;

/** Shape returned by the public `get_debt_by_share_token` RPC — see 0002. */
export interface DebtShareView {
  description: string;
  amount: number;
  status: DebtStatus;
  target_account_prefix: string | null;
  target_account_number: string | null;
  target_bank_code: string | null;
}

export interface Database {
  // Required by @supabase/supabase-js's type-inference so it knows which
  // PostgREST version's rpc()/query typing rules to apply — matches what
  // `supabase gen types typescript` emits automatically once the real
  // Supabase project exists (see the TODO at the top of this file).
  __InternalSupabase: {
    PostgrestVersion: '13';
  };
  public: {
    Views: {};
    Tables: {
      profile: { Row: Profile; Insert: ProfileInsert; Update: ProfileUpdate };
      accounts: { Row: Account; Insert: AccountInsert; Update: AccountUpdate };
      categories: { Row: Category; Insert: CategoryInsert; Update: CategoryUpdate };
      monthly_budgets: { Row: MonthlyBudget; Insert: MonthlyBudgetInsert; Update: MonthlyBudgetUpdate };
      transactions: { Row: Transaction; Insert: TransactionInsert; Update: TransactionUpdate };
      recurring_items: { Row: RecurringItem; Insert: RecurringItemInsert; Update: RecurringItemUpdate };
      long_term_items: { Row: LongTermItem; Insert: LongTermItemInsert; Update: LongTermItemUpdate };
      debts: { Row: Debt; Insert: DebtInsert; Update: DebtUpdate };
    };
    Functions: {
      // From supabase/migrations/0002_public_debt_share.sql — the narrow,
      // no-login RPCs the public /d/[token] page is allowed to call.
      get_debt_by_share_token: {
        Args: { p_token: string };
        Returns: DebtShareView[];
      };
      claim_debt_paid: {
        Args: { p_token: string };
        Returns: void;
      };
      undo_claim_debt_paid: {
        Args: { p_token: string };
        Returns: void;
      };
    };
  };
}
