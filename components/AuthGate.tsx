import type { ReactNode } from 'react';
import { Redirect, usePathname } from 'expo-router';
import { useAuth } from '@/lib/auth-context';

/**
 * Everything in the app requires a signed-in Pavel — single-user, no
 * roles (architecture-v1.md "Auth") — except two public routes that by
 * design have to work for a visitor who has never opened this app: the
 * debt-share page (architecture-v1.md "The public debt-share link") and,
 * since the marketing landing page landed at `/`, the root route itself —
 * app/index.tsx handles sending an already-signed-in visitor on into the
 * app on its own, so this just needs to stop forcing signed-out visitors
 * through /sign-in before they ever see it. This is the one place the
 * public/private distinction is enforced, so no individual screen has to
 * remember to check auth itself.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const pathname = usePathname();

  const isPublicRoute = pathname === '/' || pathname.startsWith('/d/');
  if (isPublicRoute) return <>{children}</>;

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
