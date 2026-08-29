# Kasička

A personal finance app — expense tracking, budgeting, and a "who owes me"
debts ledger with shareable payment-request links. Rebuilt from an earlier
Google Apps Script prototype ("Budgetor"). Full planning docs (requirements,
data model, architecture, screens, roadmap) live in the Claude project this
was built alongside, not in this repo.

Current status: **Phase 0 scaffold** — routing, theme, Supabase schema, and
types exist; no real backend is connected yet and most screens are
structural placeholders. See `build-roadmap-v1.md` (in the Claude project)
for what's next.

## Stack

- [Expo Router](https://docs.expo.dev/router/introduction/) (React Native +
  web, one codebase) — SDK 57
- [Supabase](https://supabase.com) — Postgres, Auth (Google sign-in),
  Storage, scheduled Edge Functions
- Distribution: **PWA-first** — the web build is installed via "Add to Home
  Screen," no App Store / Play Store submission planned for now
- No GCP anywhere in this stack (see architecture doc for why)

## Project layout

```
app/                    Expo Router routes (file-based)
  (mobile)/              the fast expense-capture screen (phones, narrow web)
  (app)/                 the desktop "admin" shell — Home/Overview/Debts/
                          Transactions/More, top nav
  d/[token].tsx           public, no-login debt share page
components/              shared UI (ExpenseEntryForm, ThemeToggle, ...)
lib/                     theme tokens, theme context, Supabase client
types/database.ts        hand-written types matching the schema below
supabase/migrations/     the actual SQL — source of truth for the schema
scripts/                 one-off helper scripts (see oklch-to-hex.mjs)
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
three steps are for you to do directly, then hand back to Claude:

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
2. In the project's SQL Editor, run the two files in `supabase/migrations/`
   **in order** (`0001_initial_schema.sql`, then
   `0002_public_debt_share.sql`) — paste each in and run it.
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

### 3. Vercel (web hosting + the domain)

Not needed to develop locally, only to get a real public URL (which the
debt share links require to work for someone without the app). When you're
ready:

1. Sign up / log in at [vercel.com](https://vercel.com), preferably with
   your GitHub account so it can connect directly to the repo from step 1.
2. Import the `kasicka` repo as a new Vercel project. Build command:
   `npx expo export --platform web`, output directory: `dist`.
3. Add the two `EXPO_PUBLIC_SUPABASE_*` values from your `.env` as
   Environment Variables in the Vercel project settings (same names).
4. Deploy. You'll get a free `*.vercel.app` URL immediately — good enough to
   test everything end to end, including the PWA install.
5. Once you've bought `kasicka.eu` or `kasicka.net`: Vercel project →
   Settings → Domains → add it. Vercel shows the exact DNS records to add;
   put those at whichever registrar you bought the domain from. HTTPS is
   issued automatically once DNS resolves (minutes to a few hours).

## Known scaffold-stage details worth knowing about

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
  Once the Supabase project exists, replace it with the real generated
  types (`npx supabase gen types typescript --project-id <id> > types/database.ts`)
  so it can never silently drift from the actual schema again.
