import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { ensureBootstrapped } from '@/lib/bootstrap';
import type { Account, Category } from '@/types/database';

interface AppData {
  defaultAccountId: string | null;
  categories: Category[];
  /** Active accounts, for the entry form's collapsed account picker —
   * added alongside that panel (build-roadmap-v1.md Phase 1 remainder). */
  accounts: Account[];
  /** `profile.month_start_day` (1–28, default 1) — see lib/budget-month.ts.
   * Defaults to 1 (plain calendar month) while still loading. */
  monthStartDay: number;
  /** True while the first-sign-in bootstrap and/or the fetch below is
   * still in flight — callers should disable Save rather than let it
   * write with a null account/category. */
  loading: boolean;
  refresh: () => void;
}

/**
 * The signed-in user's default account + expense categories — created once
 * by lib/bootstrap.ts on first sign-in (see that file). Owns calling
 * ensureBootstrapped() itself so any screen that needs this data works
 * standalone, with no separate "did bootstrap run yet" coordination
 * needed elsewhere. Phase 1 scope: expense categories only — full
 * Accounts/Categories management is a later More-tab build
 * (build-roadmap-v1.md Phase 1 "Categories & Accounts").
 */
export function useAppData(): AppData {
  const { user } = useAuth();
  const [defaultAccountId, setDefaultAccountId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [monthStartDay, setMonthStartDay] = useState(1);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!user) {
      setDefaultAccountId(null);
      setCategories([]);
      setAccounts([]);
      setMonthStartDay(1);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        await ensureBootstrapped(user.id, user.email ?? null);
      } catch (err) {
        console.warn('[use-app-data] Bootstrap failed', err);
      }

      const [profileRes, categoriesRes, accountsRes] = await Promise.all([
        supabase.from('profile').select('default_account_id, month_start_day').eq('id', user.id).maybeSingle(),
        supabase.from('categories').select('*').eq('category_type', 'EXPENSE').order('sort_order'),
        supabase.from('accounts').select('*').eq('active', true).order('sort_order'),
      ]);

      if (cancelled) return;
      setDefaultAccountId(profileRes.data?.default_account_id ?? null);
      setMonthStartDay(profileRes.data?.month_start_day ?? 1);
      setCategories(categoriesRes.data ?? []);
      setAccounts(accountsRes.data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => refresh(), [refresh]);

  return { defaultAccountId, categories, accounts, monthStartDay, loading, refresh };
}
