import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { ensureBootstrapped } from '@/lib/bootstrap';
import type { Category } from '@/types/database';

interface AppData {
  defaultAccountId: string | null;
  categories: Category[];
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!user) {
      setDefaultAccountId(null);
      setCategories([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        await ensureBootstrapped(user.id);
      } catch (err) {
        console.warn('[use-app-data] Bootstrap failed', err);
      }

      const [profileRes, categoriesRes] = await Promise.all([
        supabase.from('profile').select('default_account_id').eq('id', user.id).maybeSingle(),
        supabase.from('categories').select('*').eq('category_type', 'EXPENSE').order('sort_order'),
      ]);

      if (cancelled) return;
      setDefaultAccountId(profileRes.data?.default_account_id ?? null);
      setCategories(categoriesRes.data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => refresh(), [refresh]);

  return { defaultAccountId, categories, loading, refresh };
}
