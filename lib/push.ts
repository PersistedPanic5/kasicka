import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';

/**
 * Web Push registration — build-roadmap-v1.md Phase 2 "Web Push
 * registration and the first live notification type (recurring item due)".
 * See architecture-v1.md "Notifications implication of PWA-first": no
 * native push service here (that assumes a native app install) — this is
 * the plain browser Push API instead, which needs three things working
 * together:
 *
 *   1. A service worker (public/sw.js) registered on the page — it's the
 *      thing that actually receives a push event and shows the OS
 *      notification, even if the tab/PWA isn't open.
 *   2. A subscription — the browser's own opaque endpoint + a pair of
 *      encryption keys, obtained via PushManager.subscribe(). Saved to
 *      push_subscriptions (supabase/migrations/0004_recurring_and_push.sql)
 *      so the daily server-side check (supabase/functions/
 *      check-recurring-due) knows where to send to.
 *   3. A VAPID key pair identifying *this app* to the push service —
 *      EXPO_PUBLIC_VAPID_PUBLIC_KEY (public half, safe to ship to the
 *      client) must be set in .env / Vercel env vars. See
 *      supabase/functions/check-recurring-due/README.md for how to
 *      generate the pair and where the private half goes (an Edge
 *      Function secret, never here).
 *
 * iOS Safari only supports any of this once the PWA has been added to the
 * home screen (not from a plain browser tab) — a real limitation, not a
 * bug here; see architecture-v1.md.
 */

const VAPID_PUBLIC_KEY = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY ?? '';

export function isPushSupported(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && VAPID_PUBLIC_KEY.length > 0;
}

// PushManager.subscribe wants the VAPID public key as a raw Uint8Array, not
// the base64url string it's normally shared as.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  return navigator.serviceWorker.register('/sw.js');
}

/** Whether *this* browser already has an active push subscription — used
 * to show the More screen's toggle in the right state on load. */
export async function getPushSubscriptionState(): Promise<boolean> {
  const reg = await getRegistration().catch(() => null);
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return sub !== null;
}

export async function subscribeToPush(ownerId: string): Promise<void> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const reg = await getRegistration();
  if (!reg) throw new Error('Could not register the service worker.');

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
  });

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('The browser returned an incomplete push subscription.');
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      owner_id: ownerId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
    { onConflict: 'endpoint' }
  );
  if (error) throw new Error(error.message);
}

export async function unsubscribeFromPush(_ownerId: string): Promise<void> {
  const reg = await getRegistration().catch(() => null);
  if (!reg) return;
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
