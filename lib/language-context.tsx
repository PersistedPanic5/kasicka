import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { translations, type Language } from '@/lib/i18n';

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  /** Look up a UI string, e.g. `t('more.signOut')`. Dot-path into the
   * dictionaries in lib/i18n.ts — deliberately untyped-by-path (a plain
   * string) rather than a generated union, to keep this file simple; a
   * typo just falls back to the key itself, which is loud enough to spot
   * in testing. */
  t: (path: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function lookup(dict: Record<string, unknown>, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((node, key) => {
    if (node && typeof node === 'object' && key in node) return (node as Record<string, unknown>)[key];
    return undefined;
  }, dict);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Wraps the signed-in part of the app (inside AuthProvider, see
 * app/_layout.tsx). Backed by the real `profile.language` column
 * (supabase/migrations/0001_initial_schema.sql) — a manual EN/Čeština
 * toggle lives in More → Profile & preferences, no auto-detection here
 * (that's the public debt-share page's job — see lib/i18n.ts and
 * app/d/[token].tsx, which has no profile to read from and manages its
 * own language state independently).
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [language, setLanguageState] = useState<Language>('en');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('profile')
      .select('language')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.language) setLanguageState(data.language);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const setLanguage = useCallback(
    (lang: Language) => {
      setLanguageState(lang);
      if (user) {
        supabase.from('profile').update({ language: lang }).eq('id', user.id).then();
      }
    },
    [user]
  );

  const t = useCallback((path: string) => lookup(translations[language], path) ?? path, [language]);

  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
