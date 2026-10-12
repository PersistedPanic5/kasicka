import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { palettes, ThemeMode, ThemeTokens } from './theme';

interface ThemeContextValue {
  mode: ThemeMode;
  tokens: ThemeTokens;
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'kasicka-theme';

/**
 * Wraps the app so every screen can read the current palette and flip it.
 * Dark is the default (Pavel: "make dark mode a priority") — deliberately
 * NOT the system scheme: the static web export is baked with this default,
 * and a first client render that disagreed with it (e.g. system = light)
 * left the public pages half-light, half-dark. A manual choice is kept in
 * localStorage and applied in an effect, i.e. after hydration has matched.
 * TODO(Phase 1): persist to `profile.theme` in Supabase instead.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark');

  useEffect(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (saved === 'light' || saved === 'dark') setMode(saved);
    } catch {}
  }, []);

  const choose = (m: ThemeMode) => {
    setMode(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {}
  };

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      tokens: palettes[mode],
      toggle: () => choose(mode === 'dark' ? 'light' : 'dark'),
      setMode: choose,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- choose only closes over the setter
    [mode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
