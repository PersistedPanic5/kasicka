import { Redirect } from 'expo-router';

/**
 * "More" was renamed to "Settings" (app/(app)/settings.tsx) once Recurring
 * items and Long-term & reserve moved out into their own "Planning" tab —
 * see planning.tsx for why. This file stays only as a redirect so any old
 * bookmark or link to /more still lands somewhere real; safe to delete
 * once you're confident nothing still links here.
 */
export default function MoreRedirect() {
  return <Redirect href="/(app)/settings" />;
}
