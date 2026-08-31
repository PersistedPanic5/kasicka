import { supabase } from '@/lib/supabase';
import { CATEGORY_NAMES } from '@/lib/theme';

/**
 * First-sign-in setup. Google sign-in creates the `auth.users` row
 * automatically (that's Supabase Auth's job), but nothing in *our* schema
 * exists yet for a brand new user — profile/accounts/categories are all
 * owner-scoped and start empty (see supabase/migrations/0001_initial_schema.sql
 * "Row Level Security"). This creates the minimum a Phase 1 user needs:
 * one default cash account and the standard expense categories from
 * lib/theme.ts CATEGORY_NAMES (matching the Design canvas mockups).
 *
 * Safe to call on every login, including concurrently from multiple tabs or
 * components (useAppData() is invoked independently from more than one
 * screen). This used to check "does a profile row exist?" and then insert
 * the account/categories/profile in three separate steps — that's a classic
 * check-then-act race: two calls landing at the same moment can both pass
 * the check before either insert completes, and both go on to create their
 * own account + categories, leaving a duplicate "Cash" account behind.
 *
 * Fixed by inserting the `profile` row FIRST, with `default_account_id`
 * left null (the column is nullable — see migration 0001, no `not null`
 * there) and using its primary key (`profile.id references auth.users(id)`)
 * as an atomic mutex: only the caller whose insert actually succeeds goes
 * on to create the account + categories and then fills in
 * default_account_id. A racing second call's insert fails with a unique/PK
 * violation (Postgres error code 23505) — that's treated as "someone else
 * already bootstrapped this user," not an error, and the call just returns.
 *
 * `email` (migration 0006) is denormalized from the auth session onto the
 * profile row purely so Pavel can see who's signed up from the profile
 * table itself — sign-in has no allow-list (lib/auth-context.tsx), so
 * that's a real question, not a hypothetical. Backfilled on every call
 * (cheap update) rather than only at insert time, so an existing profile
 * row created before this column existed still gets filled in the next
 * time that user signs in.
 */
export async function ensureBootstrapped(userId: string, email: string | null = null): Promise<void> {
  const { data: existingProfile } = await supabase
    .from('profile')
    .select('id, default_account_id, email')
    .eq('id', userId)
    .maybeSingle();

  if (existingProfile) {
    // Profile already exists. In the old race, a duplicate account/category
    // set could still have been created by a second concurrent call before
    // this fix shipped — but the profile row itself is unique per user, so
    // once it's here there's nothing left for this call to do, beyond
    // backfilling email if it's missing or has changed.
    if (email && existingProfile.email !== email) {
      await supabase.from('profile').update({ email }).eq('id', userId);
    }
    return;
  }

  // Claim the mutex: try to be the one caller who creates this user's
  // profile row. default_account_id stays null until the account exists.
  const { error: profileInsertError } = await supabase.from('profile').insert({ id: userId, email });

  if (profileInsertError) {
    // 23505 = unique_violation — another concurrent call won the race and
    // already inserted this profile row first. That's expected and fine;
    // that other call is responsible for creating the account/categories.
    if (profileInsertError.code !== '23505') {
      console.warn('[bootstrap] Failed to create the profile row', profileInsertError);
    }
    return;
  }

  // We won the race — we're the only caller that will reach this point for
  // this user, so it's safe to create the account and categories now.
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .insert({ owner_id: userId, name: 'Cash', account_type: 'CASH' })
    .select('id')
    .single();

  if (accountError || !account) {
    console.warn('[bootstrap] Failed to create the default account', accountError);
    return;
  }

  const { error: categoriesError } = await supabase.from('categories').insert(
    CATEGORY_NAMES.map((name, i) => ({
      owner_id: userId,
      name,
      category_type: 'EXPENSE' as const,
      sort_order: i,
    }))
  );
  if (categoriesError) {
    console.warn('[bootstrap] Failed to create default categories', categoriesError);
  }

  const { error: updateError } = await supabase
    .from('profile')
    .update({ default_account_id: account.id })
    .eq('id', userId);
  if (updateError) {
    console.warn('[bootstrap] Failed to link the default account to the profile', updateError);
  }
}
