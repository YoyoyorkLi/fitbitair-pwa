# fitbitair-pwa

The Vercel half of Pulse — a personal recovery dashboard with an NFC-tap
drink overlay, pulling from the Google Health API by way of a Fitbit Air.

This repo is deployable as-is: point Vercel at its root, no configuration
needed. No build step, no framework. Vercel's zero-config layout does the
separation for us:

```
api/       serverless functions   — the backend. Node, service_role key.
lib/       server-side helpers    — imported by api/, never shipped to a browser.
public/    static files           — the PWA. Anon key, RLS-fenced, reads only.
```

The rule that keeps it honest: **nothing in `public/` ever writes a drink.**
Taps go through `api/tap.js` with the tag token; the PWA reads through
PostgREST with the anon key. The two halves share no code and no credentials.

## The other half

The Google Health sync, the derived metrics (strain, recovery, sleep score),
the Supabase schema, and the hourly push all live in **[`pulse/`](pulse/)** —
a Python project nested in this same repo, but a separate deploy target from
everything above it. Vercel builds this repo's root (`api/`, `public/`) and
never looks inside `pulse/`; GitHub Actions ([`.github/workflows/sync.yml`](.github/workflows/sync.yml))
runs *only* what's inside `pulse/`, on its own hourly schedule, and never
touches `api/` or `public/`. The PWA only ever reads what `pulse/push.py`
writes, through the `night_summary` view — it never talks to Google, and
never runs Python. `pulse/sql/schema.sql` and `pulse/pulse/push.py`,
referenced below, live under that directory.

## Scheduled sync

`.github/workflows/sync.yml` runs `pulse sync && pulse push` hourly. It needs
six repo secrets (**Settings → Secrets and variables → Actions**):

| Secret | Where it comes from |
|---|---|
| `GH_CLIENT_ID`, `GH_CLIENT_SECRET` | `pulse/.env` |
| `GH_REFRESH_TOKEN` | `pulse/.token.json`'s `refresh_token` field |
| `PULSE_TZ` | `America/Chicago` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` |

`push()` recomputes and upserts *every* night in the local cache on each run,
not just new ones — so once this workflow exists, its first run (wait for the
next `:07`, or click **Run workflow** in the Actions tab to go now) pushes the
entire backfilled history to Supabase in one pass. No separate manual step.

## Deploy

1. Push this repo to GitHub (already done, if you're reading this from there).
2. Vercel → **Add New → Project** → import it. Framework preset: Other.
   Root Directory and build/output stay at their defaults — this repo's root
   is already the deploy root.
3. Add the environment variables from [`.env.example`](.env.example) — all of
   them, for **Production, Preview and Development**. Miss the last two and
   previews fail while production works, which is a confusing afternoon.
4. Deploy.

Icons are not in the repo yet. Copy `icons/` out of the `pwa-test` repo into
`public/icons/` — 192, 512, maskable-512, apple-touch-icon. The manifest
already references them.

## Local

```bash
cp .env.example .env.local     # then fill in the keys
npm install
npx vercel dev
```

## Tests

```bash
npm test
```

`night.test.js` is the one that matters. Its expected values came out of
Postgres 16 running `drink_night()` from [`pulse/sql/schema.sql`](pulse/sql/schema.sql)
— not out of the JavaScript. Three implementations of the 4am rule exist (SQL
there, `lib/night.js` and `public/app.js` here) and they have to agree, or
drinks land on the wrong night and the dose-response join corrupts silently.

`json-fixtures.test.js` exists because of a bug that shipped once: Python's
`json.dump()` writes bare `NaN` by default, which is legal in Python's own
dialect and illegal JSON — `fetch(...).then(r => r.json())` throws on it.
Every static `.json` fixture under `public/` is checked against strict
`JSON.parse` so that can't happen silently again.

## The endpoint

```
POST /api/tap
  x-tag-token: <TAG_TOKEN>
  {"kind": "beer"}
  → 200  "Drink 3 · 11:42 PM"

GET  /api/tap?t=<TAG_TOKEN>&kind=beer
  → 200  an HTML confirmation page
```

`kind` is one of `beer wine cocktail shot double other`, defaulting to `beer` —
one sticker can't ask a question. Standard-drink values live server-side in
`api/tap.js` so the Shortcut menu stays dumb and the science is defined once.

Repeat taps of the same kind, on the same night, within 15 seconds are
ignored, so a double-tap or a Safari back-navigation doesn't double-log.
Longer than that — or the same kind falling on either side of the 4am night
boundary — and it's a real second drink.

## The iOS Shortcut

Shortcuts → Automation → New → **NFC** → Scan Tag → pick the sticker.

1. **Choose from Menu** — `Same as last`, `Beer`, `Wine`, `Cocktail`, `Shot`, `Double`
2. **Get Contents of URL** in each branch
   - URL `https://<your-app>.vercel.app/api/tap`
   - Method **POST**, Headers `x-tag-token: <TAG_TOKEN>`
   - Request Body JSON: `kind` = the branch's drink
3. **Show Notification** with the *Contents of URL* as the body
4. Turn **Run Immediately** on, **Notify When Run** off

Use *Get Contents of URL*, not *Open URLs*. Opening a URL launches Safari and
gives up everything this design buys — and on iOS the Safari session lives in a
different storage partition from the installed PWA anyway.

Write the plain `GET` URL onto the tag as well. That's the fallback for a reset
phone or a friend's hand: two taps and a browser, but it needs no setup and
always works.
