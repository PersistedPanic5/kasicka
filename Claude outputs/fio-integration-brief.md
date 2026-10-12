# Brief: Fio bank payment matching (copy into the prompt of the target app)

## What I want
My app tracks bills/invoices that people or companies pay to my **Fio banka** account (Czech Republic). I want the app to watch that account through Fio's read-only API, recognise incoming payments, match each one to the right bill, and mark the bill as paid automatically. The system must record that the bill was settled automatically (versus by me by hand). Where a payer sees a bill page, it should show "payment received" live. I also want a "Check Fio payments now" button for me as admin, and an automatic check when I open the bills page.

My app / stack: [describe here: framework, database, hosting, how bills are stored, who sees bill pages].

## Fio API facts (https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf)
- Base: `https://fioapi.fio.cz/v1/rest/`. Use `periods/{token}/{yyyy-mm-dd}/{yyyy-mm-dd}/transactions.json`. Do not use `last/...` (it moves a server-side "already downloaded" cursor, so several consumers of one token would steal data from each other).
- Limit: one request per token per 30 seconds, otherwise HTTP 409. Undocumented/odd statuses (409, 422, 500 for an invalid token) must be treated as "retry later" or "token problem", never as a crash.
- The token is 64 letters/digits, created by the account owner in Fio internet banking → Settings → API. Use type "Pouze sledovat účet" (read-only; it cannot send money). Needs strong authentication; usable about 5 minutes after creation. Maximum validity 180 days (offer auto-extend on login), one token per account. Data older than 90 days needs a temporary unlock in internet banking, so never request more than about 85 days back.
- JSON: `accountStatement.transactionList.transaction[]` (can be null when empty). Each item has `columnN: {value, name, id}`. Important columns: `column22` movement ID (the only reliable dedupe key), `column1` amount (positive = incoming), `column14` currency, `column5` variable symbol (VS), `column16` message for recipient, `column2`/`column3` counter-account and bank code, `column10` counter-party name, `column7` user identification, `column25` comment. Don't rely on the date format.

## How matching works (design I already use and trust)
- Every bill gets a **unique numeric variable symbol** (up to 10 digits; a database sequence is simplest). It goes into the payment QR (Czech QR Platba, SPD 1.0, field `X-VS:`), so the payer types nothing. It is also shown under "enter manually" next to the account number.
- A payment settles a bill when: incoming, currency equals the bill's currency, VS equals the bill's VS (ignore leading zeros), and amount is at least the bill amount. Underpayments, payments without VS and wrong currency are NOT settled automatically; they stay for me to confirm by hand.
- Each Fio movement ID may settle only one bill (unique index on the stored movement ID), so a repeated check never double-settles.
- Settling is one atomic database transaction (create the paid/credit record, set status PAID/SETTLED, store "settled by FIO" and the movement ID). It is idempotent: an already-settled bill is skipped.

## Architecture
- **Secret handling (most important):** the Fio token is stored server-side in its own table that no client role can read (row-level security on, no policies, no grants). It is written only by a server function that validates the format and checks that the account belongs to the caller, and it is never returned. I enter the token myself in the app's administration screen; nobody else (including the AI assistant) ever sees or types it. Disconnecting deletes it.
- **Account flag:** the bank account record gets `bank_provider = 'FIO'` (set together with the token), `last_checked_at`, `last_success_at`, `last_error` (a short code such as `fio_token_invalid`, `fio_unreachable`), shown in administration so I can see whether it works.
- **Server-side check function** (a serverless/edge function with a service-role key; the browser never calls Fio):
  1. Find open bills for the account; if none, do nothing (and don't call Fio).
  2. Atomically claim `last_checked_at` with a gap of at least 35 seconds (an `UPDATE ... WHERE last_checked_at < now() - 35s RETURNING`). If it didn't claim, answer "throttled". This protects Fio's 30-second limit however many pages poll at once.
  3. Read the token, request the `periods` range (oldest open bill date minus 1 day, capped at 85 days back, up to today in Europe/Prague), parse, match, settle, and record success or the error code.
  - Two ways to call it: public mode with a bill's share token (anonymous payer page; it only triggers a check of that bill's account and returns nothing sensitive), and admin mode with my login (checks all my Fio accounts, returns a summary: checked, throttled, settled count, error codes).
- **Payer page:** polls every ~8 seconds while the bill is open (call the function, then re-read the bill status). On settle it switches to "Payment received ✓ confirmed automatically from the bank". Show the VS in the QR and under manual entry.
- **Admin page:** auto-check once on load, a "Check Fio payments now" button with clear messages (settled N / nothing new / checked a moment ago, try in 30 s / problem: code), and a badge "Settled automatically (Fio)" on auto-settled bills.
- **Account settings UI:** "Connect Fio bank" only for accounts with bank code 2010; a write-only token field; the tips above (read-only type, 180-day validity, wait 5 minutes); status line with last success / last problem; "Replace token" and "Disconnect".

## Known limits to keep (or improve if I ask)
- No background schedule: checks happen only while a payer page is open or I open the admin page / click the button. A scheduled call of the function for all Fio accounts would make it fully unattended.
- If a bill is merged or reissued with a new VS, payments with the old VS won't match.
- No fallback matching on message text and no summing of partial payments.
- Payments older than 90 days need the manual unlock in Fio.

## Rules for the assistant
- Never ask me to paste the Fio token in chat and never type or log it. Tell me where to enter it myself.
- Never log the request URL (it contains the token) or return it in errors.
- I run database migrations, function deploys and secrets myself; give me exact steps.
- Give me one runnable check for the matching logic (fake Fio response in, expected settlements out).
