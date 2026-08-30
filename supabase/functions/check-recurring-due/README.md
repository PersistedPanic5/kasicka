# check-recurring-due

The Phase 2 "notifications foundation" daily job (`build-roadmap-v1.md`
Phase 2). Checks every active recurring item; for anything due and not yet
confirmed this cycle, sends a Web Push notification to every device you've
subscribed from (More → Profile & preferences → Notifications). It never
posts a transaction itself — see the comment at the top of `index.ts`.

This is genuinely new infrastructure (a scheduled Edge Function + Web Push),
so — unlike the app code, which you just get committed to your working
folder — this piece needs a few manual one-time setup steps in your own
Supabase project and the Supabase CLI. Nothing here can be done for you
without your project credentials, so it's all steps you run yourself.

## 1. Install the Supabase CLI (if you haven't already)

```
npm install -g supabase
```

## 2. Generate a VAPID key pair

VAPID keys identify *this app* to the browser push services (Google's,
Mozilla's, etc.) — one pair, used for every subscriber.

```
npx web-push generate-vapid-keys
```

This prints a Public Key and a Private Key. Keep both somewhere safe (a
password manager) — you'll need the public one in two places and the
private one in one place, below.

## 3. Add the public key to the app

In `.env` (and in Vercel's project environment variables, so it's there on
the deployed site too):

```
EXPO_PUBLIC_VAPID_PUBLIC_KEY=<the public key from step 2>
```

Redeploy the app (a normal `git push` — Vercel picks up env var changes on
the next build) after adding it to Vercel.

## 4. Set the Edge Function's secrets

The private key must never reach the client — it only goes here, as a
Supabase Edge Function secret:

```
supabase login
supabase link --project-ref <your-project-ref>   # find this in your Supabase project URL/settings

supabase secrets set VAPID_PUBLIC_KEY=<the public key from step 2>
supabase secrets set VAPID_PRIVATE_KEY=<the private key from step 2>
supabase secrets set VAPID_SUBJECT=mailto:pavel.skuhrovec@gmail.com
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
into every deployed function — you don't set those yourself.)

## 5. Deploy the function

From the repo root:

```
supabase functions deploy check-recurring-due
```

You can test it immediately with:

```
supabase functions invoke check-recurring-due
```

— it'll report `{"checked":N,"due":0,"notified":0}` if nothing's due yet,
or actually send a notification if something is (try it after adding a
recurring item with a `day_of_month` at or before today).

## 6. Schedule it to run daily

Easiest path: **Supabase Dashboard → Database → Cron Jobs → Create a new
cron job.** Point it at this function's URL (shown in Functions →
check-recurring-due) on whatever daily schedule you like, e.g. `0 8 * * *`
for 8am UTC.

If your project doesn't have that dashboard page yet (or you'd rather do it
in SQL), this is the underlying mechanism — run once in the SQL Editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'check-recurring-due-daily',
  '0 8 * * *',  -- 8am UTC daily — adjust to your preference
  $$
  select net.http_post(
    url := 'https://<your-project-ref>.supabase.co/functions/v1/check-recurring-due',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <your-service-role-key>',
      'Content-Type', 'application/json'
    )
  );
  $$
);
```

Replace `<your-project-ref>` and `<your-service-role-key>` (Project
Settings → API — the `service_role` secret, not the anon/publishable key).
Since that embeds a real secret in a stored cron job definition, the
dashboard Cron Jobs UI (which handles auth for you) is the tidier option if
it's available on your project — use the raw SQL only as a fallback.

To check it's actually running: `select * from cron.job_run_details order
by start_time desc limit 5;` after it's had a day to fire.

## Notes

- iOS only supports any of this once the PWA has been added to the home
  screen (Settings-app-installed, not a plain Safari tab) — a real
  platform limitation, not a bug here.
- If you ever add another recurring-notification type (a stale debt, a
  long-term payment coming due — both still open items per
  architecture-v1.md "Notifications"), it's the same shape: compute
  who's due, look up their `push_subscriptions`, send.
