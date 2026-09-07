# Kasička

A personal finance app — expense tracking, budgeting, long-term/reserve
payments with Czech QR codes, and a "who owes me" debts ledger with
shareable payment-request links. Rebuilt from an earlier Google Apps
Script prototype ("Budgetor"). Full planning docs (requirements, data
model, architecture, screens, roadmap) live in the Claude project this
was built alongside, not in this repo.

**Current status: live and in daily use at kasicka.eu.** Phases 0–3 are
fully built (core expense loop, debts ledger + shareable QR links,
recurring items + Web Push notifications, long-term/reserve payments +
the monthly wizard, the Settings/Planning nav split). Phase 4 is
partially built — multi-currency support, quick-amount toggle, and a
round of debts-ledger refinements (multi-person splits, name
autocomplete, merging/unmerging debts) all landed from real day-to-day
usage feedback; income tracking and receipt viewing are still open. See
`build-roadmap-v1.md` (in the Claude project) for the exact phase-by-phase
breakdown of what's done vs. still open.

## What's built

- **Fast expense entry** (mobile-first, also on desktop Home) — amount +
  configurable quick-add chips (or none, if turned off in Settings),
  category chips, ±day date shifter, note, an account/receipt-photo
  panel, and an optional currency picker (record in EUR/USD/PLN/etc.,
  auto-converted to CZK at the Czech National Bank's daily rate — see the
  ČNB note under "Known scaffold-stage details" below).
- **Splitting an expense with someone** — flag part of any expense as
  owed by one or more people at uneven amounts. Typing a name offers
  autocomplete against everyone you've split with before (prefix match
  first, so "Ma" suggests "Maty"), and if that person already has an
  outstanding debt, Save offers to fold the new amount into it instead of
  creating another separate link for them.
- **Debts tab** — OUTSTANDING / awaiting-your-confirmation
  (CLAIMED_PAID) / SETTLED views, a public no-login share link with a
  Czech payment QR code per debt, edit, delete, and multi-select **Merge**
  (combine several debts into one, amounts summed and messages combined)
  with a matching **Unmerge** to undo it.
- **Transactions tab** — searchable/filterable list, edit, void
  (soft-delete), split off an existing transaction after the fact.
- **Overview tab** — month switcher, income/spent/net, per-category
  budget-vs-actual bars with inline budget editing.
- **Planning tab** — recurring items (add once, confirm-to-post each
  cycle, Web Push reminders) and long-term/reserve items (accrual
  progress, AUTO/MANUAL monthly reserve, QR payments), plus the launch
  button for the 5-step monthly budgeting wizard.
- **Payments tab** — the wizard's QR-view/confirm actions for long-term
  and reserve items, reachable any time rather than only mid-wizard.
- **Settings tab** — Categories, Accounts, Currencies (which ISO codes to
  track/show), quick-amounts toggle, profile & preferences
  (language/theme/month-start-day/default account).
- **Public debt-share page** (`/d/<token>`) — no login, real QR code,
  plain-text account number, "I've paid this" → CLAIMED_PAID, auto-detected
  + switchable language.
- Localization (English/Czech) and a light/dark theme toggle throughout.

## Stack

- [Expo Router](https://docs.expo.dev/router/introduction/) (React Native +
  web, one codebase) — SDK 57
- [Supabase](https://supabase.com) — Postgres, Auth (Google sign-in),
  Storage, scheduled/on-demand Edge Functions
- Distribution: **PWA-first** — the web build is installed via "Add to Home
  Screen," no App Store / Play Store submission planned for now (see
  architecture doc's "Native app path" for the free-testing option if
  that changes)
- No GCP anywhere in this stack (see architecture doc for why)

## Project layout

```
app/                    Expo Router routes (file-based)
  (mobile)/              the fast expense-capture screen (phones, narrow web)
  (app)/                 the desktop "admin" shell — Home / Payments / Debts /
                          Transactions / Overview / Planning / Settings, top nav
  wizard.tsx              the 5-step monthly budgeting wizard (nav-free route)
  d/[token].tsx           public, no-login debt share page
components/              shared UI (ExpenseEntryForm, NameAutocompleteInput,
                          ThemeToggle, ...)
lib/                     theme tokens/context, Supabase client, i18n,
                          exchange-rates, split-people/debt-merge logic,
                          recurring/long-term math, budget-month helpers
types/database.ts        hand-written types matching the schema below
supabase/migrations/     the actual SQL — source of truth for the schema
                          (0001 through 0010 — run in order, see below)
supabase/functions/      Edge Functions: check-recurring-due (daily push),
                          fetch-exchange-rate (ČNB rate lookups)
supabase/maintenance/    one-off SQL for fixing already-existing data
                          (currently: a bootstrap-race dedupe script)
scripts/                 one-off helper scripts (see oklch-to-hex.mjs)
design/                  app icon/splash source assets (svg/png)
```

## Running it locally

```bash
npm install
npm run web      # opens the web version — the one that matters most
                  # right now (PWA-first, see architecture doc)
npm run ios       # requires Xcode / a Mac, or the Expo Go app on a phone
npm run android   # requires Android Studio, or the Expo Go app on a phone
```

Without a `.env` file (see below), the app still runs — every screen renders
— but nothing that touches Supabase will actually work yet (you'll see a
console warning and any real query will fail). That's expected until the
steps below are done.

## Setting up the real backend (do this once)

Claude can't create accounts on your behalf (GitHub, Supabase, Vercel) — the
usual sandboxed-assistant restriction, not a technical limitation — so these
three steps are for you to do directly, then hand back to Claude. If
you're reading this on an already-live install, you can skip straight to
"Running it locally" above — this section is only for standing up a new
environment from scratch.

### 1. GitHub

Create a new **private** repo (e.g. `kasicka`) at github.com/new, then from
this project folder:

```bash
git remote add origin https://github.com/<your-username>/kasicka.git
git branch -M main
git push -u origin main
```

### 2. Supabase

1. Sign up / log in at [supabase.com](https://supabase.com), create a new
   project (free tier is enough — see architecture doc "Cost").
2. In the project's SQL Editor, run every file in `supabase/migrations/`
   **in numeric order**, `0001` through `0010` — paste each in and run it.
   `0004` also creates a private `receipts` Storage bucket (used by the
   entry form's photo capture) — nothing extra to do there, the migration
   handles it. A couple of migrations are worth knowing what they do before
   you run them: `0007_currencies.sql` adds the `exchange_rates` table and
   the currency columns behind multi-currency support; `0009` and `0010`
   add the debts-merge/unmerge support (a nullable `transaction_id`, a
   relaxed public-share join, and a `merged_from` snapshot column).
3. In **Authentication → Providers**, enable Google, and follow Supabase's
   instructions to create a Google OAuth client (this happens in Google
   Cloud Console — a free Google Cloud project just for the OAuth
   credentials, not for hosting anything).
4. In **Project Settings → API**, copy the **Project URL** and the
   **anon/public key**.
5. Copy `.env.example` to `.env` in this project and paste those two values
   in. `.env` is git-ignored on purpose — never commit real credentials.
6. Once auth exists, insert your own `profile` row (id = your
   `auth.users.id` after your first Google sign-in) — Claude can script this
   with you once you're at this step.
7. Deploy the two Edge Functions once you're ready to use recurring-item
   push reminders and multi-currency: see
   `supabase/functions/check-recurring-due/README.md` and
   `supabase/functions/fetch-exchange-rate/README.md` for the exact
   one-time setup (VAPID keys, secrets, a daily cron schedule). The rest of
   the app works fine before this is done — the notifications toggle and
   the currency picker just stay effectively unused until their respective
   function is deployed.

### 3. Vercel (web hosting + the domain)

Not needed to develop locally, only to get a real public URL (which the
debt share links require to work for someone without the app). When you're
ready:

1. Sign up / log in at [vercel.com](https://vercel.com), preferably with
   your GitHub account so it can connect directly to the repo from step 1.
2. Import the `kasicka` repo as a new Vercel project. Build command:
   `npx expo export --platform web && cp "dist/d/[token].html" dist/d/index.html`,
   output directory: `dist`. (The `cp` step and `vercel.json`'s rewrite
   rule together are what make the public debt-share link work — see
   "Known scaffold-stage details" below.)
3. Add the two `EXPO_PUBLIC_SUPABASE_*` values from your `.env` (plus
   `EXPO_PUBLIC_VAPID_PUBLIC_KEY` once you've set up Web Push, per step 2.7
   above) as Environment Variables in the Vercel project settings.
4. Deploy. You'll get a free `*.vercel.app` URL immediately — good enough to
   test everything end to end, including the PWA install.
5. Once you've bought a domain: Vercel project → Settings → Domains → add
   it. Vercel shows the exact DNS records to add; put those at whichever
   registrar you bought the domain from. HTTPS is issued automatically once
   DNS resolves (minutes to a few hours). The live instance runs at
   `kasicka.eu`.

## Known scaffold-stage details worth knowing about

- **Reloading any page directly (not just `/d/<token>`) needs
  `vercel.json`'s `"cleanUrls": true`.** Because the Framework Preset is
  set to "Other" (see the 404-on-Visit fix below), Vercel doesn't
  auto-serve `foo.html` for a request to `/foo` unless `cleanUrls` is on
  — without it, client-side navigation inside the app always worked (the
  browser never makes a real request), but a hard reload on `/debts`,
  `/transactions`, etc. hit Vercel's static file server directly and got
  a real 404, since there's no file literally named `debts` (no
  extension) in the output. `cleanUrls: true` tells Vercel to try
  `<path>.html` for any extensionless request.
- **With `cleanUrls: true`, every rewrite `destination` must also drop
  its `.html` extension** — this is documented Vercel behavior, not
  optional: "If cleanUrls is set to true... do not include the file
  extension in the source or destination path." Missing this the first
  time briefly re-broke the `/d/<token>` share links right after
  `cleanUrls` was added (destination was still `/d/index.html`) — fixed
  by pointing the rewrite at `/d/index` instead. If a future rewrite is
  added to this file, its destination needs the same treatment.
- **The public debt-share link (`/d/[token]`) needs a build workaround
  to work on a static host.** Expo Router's static web export can't
  pre-render a truly dynamic route — it has no way to know share tokens
  that don't exist yet at build time — so it exports a single literal
  file, `dist/d/[token].html`, which no real visitor's URL matches on its
  own. The fix: the Vercel Build Command copies that file to
  `dist/d/index.html` (the file on disk still needs its real extension —
  only the *rewrite destination string* above needs to drop it), and
  `vercel.json`'s rewrite sends any `/d/<token>` request to it *without
  changing the browser's URL* — so the page's own client-side code still
  reads the real token from the address bar. If this route is ever
  restructured, both pieces (the `cp` step and the rewrite) need to move
  together.
- **`@supabase/supabase-js` is pinned to exactly `2.55.0`**, not the
  latest — every version from `2.56.0` through the current `2.112.4` has a
  real regression where `supabase.rpc(name, args)` silently fails to type
  the `args` parameter the moment the schema has both a table and a
  function defined (confirmed by bisection, not a guess). Don't bump this
  package without re-testing an `.rpc()` call against a real table first.
  See the comment in `types/database.ts` for the full note.
- **Theme colors are hex, not oklch.** The Design canvas mockups use
  `oklch()`, which only web CSS understands — React Native's native color
  parser (iOS/Android) doesn't. `lib/theme.ts` has each value pre-converted
  (via `scripts/oklch-to-hex.mjs`) with the source oklch kept in a comment.
- **`types/database.ts` is hand-written**, matching the SQL migrations.
  Once you want to stop hand-maintaining it, replace it with the real
  generated types (`npx supabase gen types typescript --project-id <id> >
  types/database.ts`) so it can never silently drift from the actual
  schema again — every migration through `0010` needs to be reflected by
  hand until then.
- **The ČNB exchange-rate feed is plain-text, not the OAuth API portal**
  — `fetch-exchange-rate` parses `cnb.cz`'s long-standing daily fixing
  file rather than registering for `developers.cnb.cz`'s newer, more
  ceremonious API. The one real gotcha hit while building this: ČNB's
  date header is space-separated with no leading zero on single-digit
  days (`"13 Aug 2026"`), not dot-separated (`"13.Aug.2026"`) as first
  assumed — if a currency lookup ever starts silently failing again,
  check `parseDailyTxt()`'s header regex in
  `supabase/functions/fetch-exchange-rate/index.ts` first. See that
  function's own README for the full setup and data-source notes.
- **A merged debt (Debts page "Merge", or the "merge with existing debt"
  offer when splitting a new expense) has no single originating
  transaction** — `debts.transaction_id` is nullable specifically for
  this (`0009_debts_merge_support.sql`), and `merged_from` on the new row
  stores a snapshot of what was folded in so "Unmerge" can recreate the
  originals (`0010_debts_unmerge_support.sql`). Both merging and
  unmerging always issue fresh public share links — an old link for a
  debt that got merged away stops working, by design.
- **Web Push (recurring-item due notifications) needs one-time manual
  setup** — a VAPID key pair, an Edge Function deploy, and a daily
  schedule. This can't be scripted from a Claude session since it needs
  your own Supabase CLI login and project credentials — full step-by-step
  in `supabase/functions/check-recurring-due/README.md`. Until that setup
  is done, the app works fine — the Settings screen's notifications
  toggle just stays hidden (it only shows once
  `EXPO_PUBLIC_VAPID_PUBLIC_KEY` is set).
- **Receipt photo capture is web-only for now** — it uses a plain HTML
  file input (`capture="environment"` opens the phone camera directly from
  the browser), which works great as a PWA but has no native-app
  equivalent wired up yet. Native (via `expo-image-picker`) is a follow-up
  once a real native build exists, matching the PWA-first decision.
  Viewing an already-attached receipt from the Transactions list is also
  still open (the capture/attach side is done; a signed-URL viewer isn't
  built yet).
- **Income tracking has no entry UI yet.** Overview's income/spent/net
  cards already assume `type = 'INCOME'` transactions exist and sum them
  correctly — what's missing is a way to actually log one from the app.
