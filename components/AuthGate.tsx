import type { ReactNode } from 'react';
import { Redirect, usePathname } from 'expo-router';
import { useAuth } from '@/lib/auth-context';

/**
 * Everything in the app requires a signed-in Pavel — single-user, no
 * roles (architecture-v1.md "Auth") — except the public debt-share page,
 * which by design has to work for a visitor who has never opened this app
 * (architecture-v1.md "The public debt-share link"). This is the one
 * place that distinction is enforced, so no individual screen has to
 * remember to check auth itself.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const pathname = usePathname();

  const isPublicDebtLink = pathname.startsWith('/d/');
  if (isPublicDebtLink) return <>{children}</>;

  // Don't redirect while we still don't know if a stored session exists —
  // that would bounce every fresh page load through sign-in for a split
  // second even when already signed in.
  if (loading) return null;

  if (!session && pathname !== '/sign-in') {
    return <Redirect href="/sign-in" />;
  }
  if (session && pathname === '/sign-in') {
    return <Redirect href="/" />;
  }

  return <>{children}</>;
}
