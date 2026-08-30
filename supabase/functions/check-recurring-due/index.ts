// check-recurring-due — the Phase 2 "notifications foundation" daily job
// (build-roadmap-v1.md Phase 2, architecture-v1.md "Notifications").
//
// What it does, once per day (see README.md in this folder for how to
// schedule it): for every active recurring_items row that's due and not
// yet confirmed for the current cycle, send a Web Push notification to
// every device the owner has subscribed from (push_subscriptions). It
// NEVER writes a transaction itself — confirming a suggestion is always a
// person tapping Confirm in the app (lib/recurring.ts confirmRecurringItem)
// or opening the notification and doing it from there. This function only
// decides *whether to notify*, matching the "review before it counts" rule
// from core-app-requirements.md.
//
// Due-ness logic here intentionally mirrors lib/recurring.ts's
// computeDueRecurringItems() — duplicated rather than imported, since this
// function deploys standalone (Supabase Edge Functions are their own
// isolated bundle, not part of the Expo app build). Keep the two in sync
// if the rule ever changes.
//
// Uses the service role key (auto-injected as SUPABASE_SERVICE_ROLE_KEY —
// see README.md), which bypasses RLS entirely: this is the one place in
// the whole app allowed to see every user's data, because it's the only
// place that has to run across all users at once with nobody signed in.

import { createClient } from 'npm:@supabase/supabase-js@2.55.0';
import webpush from 'npm:web-push@3.6.7';

interface RecurringItemRow {
  id: string;
  owner_id: string;
  name: string;
  amount: number;
  frequency: 'MONTHLY' | 'YEARLY';
  day_of_month: number;
  active: boolean;
}

interface ConfirmedTx {
  recurring_item_id: string | null;
  transaction_date: string;
}

function computeDueRecurringItems(
  items: RecurringItemRow[],
  confirmedTransactions: ConfirmedTx[],
  today: Date
): RecurringItemRow[] {
  const todayDay = today.getDate();
  const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const currentYear = today.getFullYear();

  const confirmedDatesByItem = new Map<string, string[]>();
  for (const tx of confirmedTransactions) {
    if (!tx.recurring_item_id) continue;
    const dates = confirmedDatesByItem.get(tx.recurring_item_id) ?? [];
    dates.push(tx.transaction_date);
    confirmedDatesByItem.set(tx.recurring_item_id, dates);
  }

  return items.filter((item) => {
    if (!item.active) return false;
    if (todayDay < item.day_of_month) return false;
    const dates = confirmedDatesByItem.get(item.id) ?? [];
    if (item.frequency === 'MONTHLY') {
      return !dates.some((d) => d.slice(0, 7) === currentMonthKey);
    }
    return !dates.some((d) => new Date(d).getFullYear() === currentYear);
  });
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:pavel.skuhrovec@gmail.com';

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return new Response(
      JSON.stringify({ error: 'Missing required environment secrets — see README.md in this folder.' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const today = new Date();
  const yearStart = `${today.getFullYear()}-01-01`;

  const [itemsRes, txRes] = await Promise.all([
    supabase.from('recurring_items').select('id, owner_id, name, amount, frequency, day_of_month, active').eq('active', true),
    supabase
      .from('transactions')
      .select('recurring_item_id, transaction_date')
      .not('recurring_item_id', 'is', null)
      .gte('transaction_date', yearStart),
  ]);

  if (itemsRes.error) {
    return new Response(JSON.stringify({ error: itemsRes.error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const dueItems = computeDueRecurringItems(itemsRes.data ?? [], (txRes.data ?? []) as ConfirmedTx[], today);

  if (dueItems.length === 0) {
    return new Response(JSON.stringify({ checked: (itemsRes.data ?? []).length, due: 0, notified: 0 }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const ownerIds = Array.from(new Set(dueItems.map((i) => i.owner_id)));
  const { data: subscriptions } = await supabase
    .from('push_subscriptions')
    .select('id, owner_id, endpoint, p256dh, auth')
    .in('owner_id', ownerIds);

  const dueByOwner = new Map<string, RecurringItemRow[]>();
  for (const item of dueItems) {
    const arr = dueByOwner.get(item.owner_id) ?? [];
    arr.push(item);
    dueByOwner.set(item.owner_id, arr);
  }

  let notified = 0;
  let pruned = 0;

  for (const sub of subscriptions ?? []) {
    const ownerDue = dueByOwner.get(sub.owner_id) ?? [];
    if (ownerDue.length === 0) continue;

    const title = ownerDue.length === 1 ? ownerDue[0].name : `${ownerDue.length} recurring items due`;
    const body =
      ownerDue.length === 1
        ? `${ownerDue[0].amount} CZK — tap to confirm`
        : ownerDue.map((i) => i.name).join(', ');

    const payload = JSON.stringify({ title, body, url: '/planning' });
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };

    try {
      await webpush.sendNotification(pushSubscription, payload);
      notified++;
    } catch (err) {
      // 404/410 = the browser dropped this subscription (uninstalled,
      // cleared site data, etc.) — clean it up so future runs don't keep
      // retrying a dead endpoint.
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        pruned++;
      } else {
        console.error('[check-recurring-due] push failed', sub.id, err);
      }
    }
  }

  return new Response(
    JSON.stringify({ checked: (itemsRes.data ?? []).length, due: dueItems.length, notified, pruned }),
    { headers: { 'content-type': 'application/json' } }
  );
});
