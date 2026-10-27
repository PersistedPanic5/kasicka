# check-fio-payments

The one function that talks to Fio. It (a) settles debts when the matching
payment arrives and (b) for accounts in **Bank inbox** mode copies every bank
movement into the inbox and sends a push when new ones are waiting. Backs:
debtor page live confirmation, Debts page auto-check, the Bank inbox "Sync
now", and the scheduler. Design notes: `claude/fio-payment-matching-v1.md`
and `claude/fio-everyday-mode-v1.md` in the project.

Files: `index.ts` (I/O), `bank.ts` (pure parsing/classification),
`bank.test.ts` (run `bun supabase/functions/check-fio-payments/bank.test.ts`).

## One-time setup

1. Run `supabase/migrations/0016_fio_payments.sql` in the Supabase SQL editor
   (after `0015_events.sql` if you haven't run that yet).
2. Deploy (no extra secrets — it only uses the auto-injected service-role key):

   ```
   supabase login
   supabase link --project-ref <your-project-ref>   # if not already linked
   supabase functions deploy check-fio-payments
   ```
3. In **Fio internet banking → Settings → API** create a token:
   - type **"Pouze sledovat účet"** (read-only — it can never move money),
   - set the validity (max 180 days) and tick the auto-extend-on-login option
     if offered, otherwise put a reminder in your calendar,
   - confirm with strong authentication, then **wait ~5 minutes** before first use.
4. In the app: **Settings → Accounts → (your Fio account) → Fio**, paste the
   token and save. It is write-only: the app can never read it back.

## Bank inbox mode (everyday use)

1. Run `supabase/migrations/0017_bank_inbox.sql` in the SQL editor.
2. Re-deploy the function (it now has two files — the CLI bundles both):
   `supabase functions deploy check-fio-payments`
3. In the app: **Settings → Accounts → (Fio account) → How do you use this
   account? → Bank inbox**. Pick the first day to import; the inbox fills at once.
4. Push notifications (optional): needs the same VAPID secrets as
   `check-recurring-due` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
   `VAPID_SUBJECT`) — if that function already works, nothing more to do.
   Then switch notifications on in Settings for each browser/phone.
5. Scheduler (this is what makes it unattended). Choose a long random string
   and store it as a secret:

   ```
   supabase secrets set CRON_SECRET=<long random string>
   ```

   Then in the SQL editor (Database → Extensions: enable `pg_cron` and
   `pg_net` first). Replace the three placeholders:

   ```sql
   select cron.schedule(
     'check-fio-payments',
     '*/5 * * * *',
     $$ select net.http_post(
          url     := 'https://<project-ref>.supabase.co/functions/v1/check-fio-payments',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer <anon key>',
            'x-cron-secret', '<the CRON_SECRET>'),
          body    := '{"cron": true}'::jsonb) $$);
   ```

   It runs every 5 minutes; each account is only really checked when its own
   interval (10 / 15 / 60 min, Settings) has passed, and open debts are looked
   at on every tick, so a debtor's payment is also settled with nobody online.
   To stop it: `select cron.unschedule('check-fio-payments');`

What the inbox does with each movement (all suggestions, you always confirm):
card payments and transfers out -> expense (category suggested from merchants
you saved before); counter-account equals one of your own accounts -> "own
transfer"; ATM -> "move to Cash"; incoming -> "add as income"; a manual
expense with the same amount within 3 days -> "Is this the one you entered?".
Own transfers and cash moves are only marked on the bank row (no transaction,
no budget effect). Only CZK movements are imported.

## How matching works

Every debt has a unique 7-digit variable symbol (VS), put into the QR code
and shown under "Or enter manually". A payment settles a debt when its VS
equals the debt's VS, it is incoming CZK, and the amount is **at least** the
debt. Underpayments, payments without VS, and non-CZK payments are left for
you to confirm by hand. Each Fio movement ID can settle only one debt.

## Limits

- Fio allows one call per 30 s per token. The function enforces a 35 s gap
  per account, so any number of open pages is fine.
- Without the scheduler (step 5 above) checks only run while a debtor page is
  open, or when you open Debts / the Bank inbox / press a button.
- Payments older than 90 days need a temporary unlock in internet banking.
- If the same token is used by another tool, avoid the `last/` endpoints there
  (they move a shared cursor); this function uses `periods/` only.

## Group bills (migration 0019)

`{ "group_token": "<token>" }` (public, from `app/g/[token].tsx`) checks the group's account, same throttle as `share_token`.
One-QR groups: an incoming payment with the group's variable symbol and at least one share settles the person who tapped "I paid" first (one payment = one person). Nobody tapped yet → left alone, matched on a later check.
