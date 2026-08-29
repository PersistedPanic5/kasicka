import React, { createContext, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { palettes, ThemeMode, ThemeTokens } from './theme';

interface ThemeContextValue {
  mode: ThemeMode;
  tokens: ThemeTokens;
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Wraps the app so every screen can read the current palette and flip it —
 * matches the working light/dark toggle Pavel approved in every mockup.
 * Starts from the system color scheme, then remembers a manual override.
 * TODO(Phase 1): persist the override to `profile.theme` in Supabase once
 * auth/profile exist, instead of only living in memory per app launch.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [override, setOverride] = useState<ThemeMode | null>(null);
  const mode: ThemeMode = override ?? (system === 'dark' ? 'dark' : 'light');

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      tokens: palettes[mode],
      toggle: () => setOverride(mode === 'dark' ? 'light' : 'dark'),
      setMode: (m: ThemeMode) => setOverride(m),
    }),
    [mode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
