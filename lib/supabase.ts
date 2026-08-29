import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import type { Database } from '@/types/database';

// Filled in once the Supabase project exists (Phase 0 setup) — see README.md
// for exactly where these come from. Read from app config (app.json `extra`
// or an EXPO_PUBLIC_ env var) rather than hardcoded, so the same build works
// against a local/dev project and the real one without a code change.
const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  (Constants.expoConfig?.extra?.supabaseUrl as string | undefined);
const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  (Constants.expoConfig?.extra?.supabaseAnonKey as string | undefined);

if (!supabaseUrl || !supabaseAnonKey) {
  // Loud on purpose during Phase 0 — silently running against no backend is
  // worse than a quiet fallback. createClient() itself needs a non-empty
  // URL/key to construct at all (it throws otherwise, which would crash
  // every screen and the static web export before a real project exists),
  // so a harmless placeholder is used below and every real network call
  // will fail loudly with its own error until README.md "Connect Supabase"
  // is done.
  console.warn(
    '[supabase] Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY — ' +
      'the app has no backend connected yet. See README.md "Connect Supabase".'
  );
}

export const supabase = createClient<Database>(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      // Single-user personal app — still use Supabase's session persistence
      // so Pavel doesn't have to re-authenticate with Google every launch.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
