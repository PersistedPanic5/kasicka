# check-fio-payments

Checks a Fio bank account for incoming payments and settles the matching
debts automatically. Backs: debtor page live confirmation, Debts page
auto-check + "Check Fio payments now". Design notes:
`claude/fio-payment-matching-v1.md` in the project.

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

## How matching works

Every debt has a unique 7-digit variable symbol (VS), put into the QR code
and shown under "Or enter manually". A payment settles a debt when its VS
equals the debt's VS, it is incoming CZK, and the amount is **at least** the
debt. Underpayments, payments without VS, and non-CZK payments are left for
you to confirm by hand. Each Fio movement ID can settle only one debt.

## Limits

- Fio allows one call per 30 s per token. The function enforces a 35 s gap
  per account, so any number of open pages is fine.
- There is no background schedule: checks run while a debtor page is open, or
  when you open Debts / press the button.
- Payments older than 90 days need a temporary unlock in internet banking.
- If the same token is used by another tool, avoid the `last/` endpoints there
  (they move a shared cursor); this function uses `periods/` only.
