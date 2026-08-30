// Kasička service worker — Web Push only (build-roadmap-v1.md Phase 2).
// Deliberately minimal: no offline caching / asset precaching here, since
// that's a separate concern from push and the app is online-only via
// Supabase anyway. Registered from lib/push.ts, copied to the site root by
// Expo Router's static web export (files under /public are copied as-is —
// see https://docs.expo.dev/router/reference/static-rendering/).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The payload sent by supabase/functions/check-recurring-due is a JSON
// object: { title, body, url }. `url` is where a tap should land — the
// More → Recurring items section by default.
self.addEventListener('push', (event) => {
  let data = { title: 'Kasička', body: 'You have a notification.', url: '/more' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (err) {
    // Not JSON (or no payload) — fall back to the defaults above rather
    // than dropping the notification entirely.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/more';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
