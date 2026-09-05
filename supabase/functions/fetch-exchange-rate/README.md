# fetch-exchange-rate

Fetches Czech National Bank (ČNB) daily fixing rates and caches them in the
`exchange_rates` table — backs Settings → Currencies and Record Expense's
currency picker. Unlike `check-recurring-due`, this one isn't a scheduled
job — the app calls it directly (`supabase.functions.invoke`) whenever it
needs a rate that isn't cached yet, or when you press "Download & save" on
a date range in Settings. See the comment at the top of `index.ts` for the
two request shapes and why this has to run server-side (CORS).

## Deploy

Same drill as `check-recurring-due`, but simpler — no secrets of its own to
set, since it only needs the service-role key that's already auto-injected
into every deployed function:

```
supabase login
supabase link --project-ref <your-project-ref>   # if not already linked
supabase functions deploy fetch-exchange-rate
```

Test it once deployed — newer Supabase CLI versions dropped `functions
invoke` (it now only does `list / delete / download / deploy / new /
serve`), so test with a plain HTTP call instead. You need two values from
your `.env` file: `EXPO_PUBLIC_SUPABASE_URL` (e.g.
`https://abcdefgh.supabase.co`) and `EXPO_PUBLIC_SUPABASE_ANON_KEY` — the
anon key is fine here, never the service-role key.

PowerShell:

```powershell
$url = "https://<your-project-ref>.supabase.co/functions/v1/fetch-exchange-rate"
$anonKey = "<your EXPO_PUBLIC_SUPABASE_ANON_KEY>"

Invoke-RestMethod -Uri $url -Method Post `
  -Headers @{ Authorization = "Bearer $anonKey" } `
  -ContentType "application/json" `
  -Body '{"mode":"lookup","currency":"EUR","date":"2026-09-03"}'
```

curl (also works in PowerShell if you prefer it, or in WSL/Git Bash):

```
curl -i -X POST "https://<your-project-ref>.supabase.co/functions/v1/fetch-exchange-rate" ^
  -H "Authorization: Bearer <your EXPO_PUBLIC_SUPABASE_ANON_KEY>" ^
  -H "Content-Type: application/json" ^
  -d "{\"mode\":\"lookup\",\"currency\":\"EUR\",\"date\":\"2026-09-03\"}"
```

You should get back something like
`{"currency":"EUR","resolvedDate":"2026-09-03","amountUnit":1,"rate":24.62}`
(or the previous working day's date, if the 3rd was a weekend/holiday). A
401 means the Authorization header is missing/wrong; a 500 with a message
about `fetch` or the ČNB host likely means the plain-text endpoint changed
shape — see `parseDailyTxt()` in `index.ts`.

## A note on the data source

This uses ČNB's long-standing public plain-text fixing file
(`.../daily.txt?date=DD.MM.YYYY`, documented at
https://www.cnb.cz/en/faq/Format-of-the-foreign-exchange-market-rates/),
not the newer `developers.cnb.cz` API portal — that one now fronts an
OAuth 2.0 registration flow, which felt like a lot of ceremony for what's
otherwise a two-line HTTP GET with no auth at all. If ČNB ever retires the
plain-text endpoint, the fix is entirely inside `parseDailyTxt()` /
`fetchCnbDailyFile()` in `index.ts` — nothing else in the app needs to
change, since everything else only ever talks to the `exchange_rates` table
and this function.

**Confirmed working live** (Settings → Currencies and Record Expense's
currency picker both convert real amounts correctly). The one real bug hit
along the way: `parseDailyTxt()`'s date-header regex originally expected a
dot-separated header (`"13.Aug.2026"`), but ČNB's actual daily file uses a
space-separated header with no leading zero on single-digit days
(`"13 Aug 2026"`) — every request was returning 200 with a real rate
inside, which made this look like a network/CORS problem for a while
before the response body was actually inspected. If a currency lookup
ever starts silently failing again, check that regex (and the pipe-column
order it feeds into) at the top of `index.ts` first, before assuming the
endpoint or auth changed.

## Notes

- Weekends/bank holidays: ČNB doesn't publish a fixing on non-working days.
  A `lookup` call walks backward up to 10 days to find the last one that
  was published — "use the last previous working day," the accounting rule
  you asked for — and caches under whichever date actually answered it.
  Reads elsewhere (`lib/exchange-rates.ts`) do the same fallback against
  the cache, so a cached weekend gap never needs a live call twice.
- A `range` backfill just skips days ČNB has nothing for — no walking back,
  since the point of a range download is "whatever ČNB actually published
  in this window," and the day-level fallback above already covers reads.
- Every currency in a fetched day's file gets cached, not just ones you're
  currently tracking — so tracking a new currency later doesn't require
  re-running a backfill over dates you already downloaded.
