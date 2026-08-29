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
 * Safe to call on every login — it checks for an existing profile row
 * first and does nothing if one's already there, so it only actually runs
 * once per user.
 */
export async function ensureBootstrapped(userId: string): Promise<void> {
  const { data: existingProfile } = await supabase
    .from('profile')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (existingProfile) return;

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

  const { error: profileError } = await supabase.from('profile').insert({
    id: userId,
    default_account_id: account.id,
  });
  if (profileError) {
    console.warn('[bootstrap] Failed to create the profile row', profileError);
  }
}
