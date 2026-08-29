import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  /** True until the first getSession() resolves — distinguishes "no one's
   * signed in" from "we don't know yet", so AuthGate doesn't flash the
   * sign-in screen on every reload before the stored session loads. */
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Wraps the whole app (see app/_layout.tsx). Single-user, Google sign-in
 * only — architecture-v1.md "Auth". Web-first (screens-and-flows.md /
 * architecture-v1.md "Distribution model"): signInWithGoogle does a
 * full-page OAuth redirect through Supabase; Google sends the browser back
 * with the session in the URL fragment, and lib/supabase.ts already sets
 * detectSessionInUrl: true, so getSession()/onAuthStateChange below pick it
 * up automatically — no manual token parsing needed here.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signInWithGoogle() {
    if (Platform.OS !== 'web') {
      // Native Google sign-in needs a browser-popup flow (expo-web-browser
      // + a custom scheme redirect) — deliberately deferred, see
      // architecture-v1.md "Distribution model": PWA-first, native later.
      console.warn('[auth] Native Google sign-in isn’t built yet — use the web/PWA build for now.');
      return;
    }
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider
      value={{ session, user: session?.user ?? null, loading, signInWithGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
