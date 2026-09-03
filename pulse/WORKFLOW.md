# Pulse — Workflow

Everything you do, in order, with the expected output at each step.

Nothing here costs money. No published app, no hosting, no billing account.

---

## Where the API credentials go — the short answer

**One command, once:**

```bash
python -m pulse setup
```

It finds the `client_secret_*.json` you downloaded from Google Cloud (checks the
current folder and `~/Downloads`), or prompts you to paste the two values. It
writes a `.env` file in the project root with `chmod 600`.

Every command reads `.env` automatically. **There is nothing to `export`, and
nothing to re-enter when you open a new terminal.** `.env` is in `.gitignore`,
so it can never be committed.

```
.env
├── GH_CLIENT_ID      = ...apps.googleusercontent.com
├── GH_CLIENT_SECRET  = GOCSPX-...
└── PULSE_TZ          = America/Chicago
```

Real environment variables still override the file, so a launchd job or a
one-off `GH_CLIENT_ID=... python -m pulse ...` works as you would expect.

---

## The mental model

```
Fitbit Air  ──Bluetooth──▶  Google Health app  ──▶  Google's servers
   (records                    (on your phone)          (stores history)
    every 2 s)                                                │
                                                     once a day, ~14 requests
                                                              ▼
                                              ┌───────────────────────────┐
                                              │  Your Mac                 │
                                              │  pulse.db   (raw JSON)    │
                                              │  dashboard.html  (~80 kB) │
                                              └─────────────┬─────────────┘
                                                            │
                                              QR / iCloud / AirDrop
                                                            ▼
                                                       Your phone
```

Your Mac is **not** a server polling Google. It downloads stored history once a
day in about ten seconds. The 5-second resolution lives in the *stored data*,
not in how often you ask for it.

---

## Step 1 — Run it with no Google account at all

Do this first. It proves the software works before credentials can confuse
anything.

```bash
cd ~/Downloads
unzip pulse-source.zip
cd pulse

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python -m pulse demo
open dashboard.html
```

**Expected output**

```
generating 30 synthetic days in the v4 wire format ...
ok  /Users/you/Downloads/pulse/dashboard.html
    30 days, 90,420 heart-rate samples

next:  python -m pulse phone
```

**What you should see:** a dark dashboard. Top of the first tab is a row of
three headline KPIs — **Day strain**, **Recovery**, **Sleep score** — then a
supporting stat row, the full-resolution heart-rate chart, time-in-zone, and a
21-day strain-vs-target chart. Two more tabs: Sleep and Trends. Tap or hover any
chart element for a tooltip.

The data is synthetic but shaped byte-for-byte like the real API returns, so
every line of parsing, maths and rendering is exercised.

> If this step works, the code is fine. Anything that breaks later is a
> credentials or account problem, which is far easier to debug.

**Then check the phone path:**

```bash
python -m pulse phone
```

A QR code prints in the terminal. Point your iPhone camera at it. Same wifi
required. `Ctrl-C` to stop.

---

## Step 2 — Google Cloud console

You have already created the OAuth client. Three things left to confirm.

### 2a. API enabled

**APIs & Services → Library** → search **Google Health API**. It should say
**Manage**. If it says **Enable**, click it.

Skipping this gives you a successful login followed by a baffling 403 on every
data call.

### 2b. Publish the app — tried, and it doesn't work on a free domain

**This whole section turned out wrong.** Publishing is *not* a free status
flag for this app, and after actually going through it, staying in Testing is
the real, permanent answer here — not a workaround, the destination. Left the
full story below because the reasoning is worth having next time this comes
up, rather than relearning it.

**What "just publish" assumed, and where that breaks.** For an app requesting
ordinary scopes, **Google Auth Platform → Audience → Publish app** genuinely
is a free status flip. But `googlehealth.*` scopes are classified *sensitive*
(real health data), and for sensitive scopes, publishing routes you through
an actual **brand verification review**, not a toggle. That review flagged
four things, in order:

1. App name **"Fitbit Air"** — that's Google's own product name; naming your
   app after it reads as brand impersonation.
2. App name doesn't match the name on the home page — direct consequence of #1.
3. The logo doesn't identify a distinct brand — a logo was uploaded that had
   no reason to be there for a single-user tool; removed.
4. **"The website of your home page URL is not registered to you."** This is
   the one that stuck.

Issues 1–3 are a five-minute fix (rename the app, e.g. to `Pulse`; remove the
logo) and resolved cleanly.

**Issue 4 did not resolve, and here's why it structurally can't.** The home
page was `https://<project>.vercel.app` — a subdomain of `vercel.app`, which
is registered on the [Public Suffix List](https://publicsuffix.org/): the
registry browsers and platforms use to mark shared, multi-tenant hosting
domains (same category as `github.io`, `netlify.app`) where no single
subdomain is treated as owning the parent. Proof was pursued two different
ways:

- **Google Cloud's own "Authorized domains" field on the Branding page**
  rejects the bare `vercel.app` outright: *"Invalid domain: must be a top
  private domain."* Adding the specific subdomain (`your-project.vercel.app`)
  IS accepted there with no error.
- **Google Search Console** was verified via the HTML-tag / URL-prefix method
  (proves you control the *content* at that exact URL) — genuinely succeeded,
  confirmed "Ownership verified."

Resubmitted for re-verification anyway, since Search Console passing was real
new evidence. **Same "not registered to you" error came back regardless.**
Two independent proofs of content ownership, both accepted by their own
respective systems, and the branding reviewer still refused the domain. That
combination is conclusive: this isn't a technical gap to route around, it's
Google's OAuth brand policy deliberately excluding shared-hosting domains as
a matter of policy, specifically because *anyone* can spin up a
`*.vercel.app` subdomain — allowing one to count as a "home page" would let
any app claim an established web presence it doesn't actually have. No amount
of resubmission changes that. **Stop trying if you land here again; it will
not pass without an independently-owned domain.**

**Other routes considered and ruled out**, for the record:
- **Google Workspace "Internal" app type** (skips verification entirely) —
  real mechanism, only available if the account is on a paid Workspace
  organization. A personal `@gmail.com` can't use it, and Workspace costs
  more per month than a domain costs per year regardless.
- **A different free/shared subdomain service** — same Public Suffix problem
  in a different costume; solves nothing.
- **Automating the human consent step itself** (headless browser, stored
  Google password) — not attempted, on purpose. Storing a password in a
  script is exactly the failure mode OAuth exists to prevent, and Google
  actively detects and blocks automated login — the likely outcome is the
  account getting flagged, not a working pipeline.
- **Dropping to non-sensitive scopes** to dodge the review — would lose most
  of what the app actually does (steps, sleep, HRV). Removes the reason the
  project exists to dodge a 30-second weekly task.

**The two paths that do work, if this ever needs revisiting:**
- **A real, independently-registered domain** (~$10–13/yr at cost, e.g.
  Cloudflare Registrar or Porkbun — avoid teaser-priced TLDs that jump in
  price after year one) pointed at the deployment. Removes the 7-day cycle
  permanently once verified.
- **GitHub Student Developer Pack**, if eligible — includes a free Namecheap
  domain for a year, same effect at zero cost for that year.

**What's actually running instead — see 2d below.**

Either way, Branding needs a home page and privacy policy URL before
`Publish app` is even clickable — the fields are still worth having filled in
correctly regardless of which path you take:

| Branding field | Value |
|---|---|
| Application home page | `https://fitbitair-pwa.vercel.app` |
| Application privacy policy link | `https://fitbitair-pwa.vercel.app/privacy.html` |

(`public/privacy.html` in this repo's root, not `pulse/` — exists for exactly this.)

### 2d. Living with Testing mode — `refresh_login.sh`

Testing-mode consent, **including the refresh token**, expires 7 days after
the last full login — not 7 days of inactivity, 7 days flat, no matter how
often the access token silently refreshes in between. That's the entire
remaining cost of not pursuing 2b further:

```bash
./refresh_login.sh
```

Opens the browser, you click through Google's consent screen once (the
"hasn't verified this app" warning is expected — Advanced → Continue), and it
either updates the `GH_REFRESH_TOKEN` GitHub secret directly (if `gh` is
installed and authed) or prints the new token ready to paste in by hand at
**Settings → Secrets and variables → Actions** on the repo.

Run it roughly once a week, comfortably before the 7-day mark. If it's ever
forgotten and the sync starts failing, the PWA's own sync-staleness banner is
the safety net that surfaces it.

### 2c. Test user + scopes

Same page → **Test users** → add the Google account paired with your Air.

**Data access** should list exactly three, all flagged *Restricted*:

```
.../auth/googlehealth.activity_and_fitness.readonly
.../auth/googlehealth.health_metrics_and_measurements.readonly
.../auth/googlehealth.sleep.readonly
```

---

## Step 3 — Plug in the credentials

```bash
python -m pulse setup
```

**If you downloaded the JSON**, it finds it automatically:

```
found credentials in /Users/you/Downloads/client_secret_1234-abc.json

wrote /Users/you/Downloads/pulse/.env  (chmod 600)
  Every command reads this automatically. Nothing to export.

next:  python -m pulse login
```

**If not**, it prompts:

```
Paste the two values from Google Cloud Console
  (APIs & Services -> Credentials -> your OAuth 2.0 Client ID)

  Client ID     : 1234-abc.apps.googleusercontent.com
  Client secret : GOCSPX-xxxxxxxx
  Timezone [America/Chicago] :
```

You can also point it straight at a file:

```bash
python -m pulse setup ~/Downloads/client_secret_1234-abc.json
```

Verify:

```bash
python -m pulse status
# credentials : set
# timezone    : America/Chicago
```

If it warns that your client is a **Web application** type, either recreate it
as **Desktop app** (simpler — no redirect URIs to register), or add both
`http://localhost:8765/callback` and `http://127.0.0.1:8765/callback` to its
Authorized redirect URIs.

---

## Step 4 — Connect

```bash
python -m pulse login
```

**What happens**

1. Browser opens.
2. **"Google hasn't verified this app"** → click **Advanced** → **Continue**.
   This is the entire consequence of not publishing an app. Once only.
3. Approve the three scopes.
4. The tab shows a dark **Connected** page. Close it.
5. Terminal confirms.

Pulse runs a web server on `127.0.0.1:8765` for about three seconds to catch
the authorisation code. Nothing is exposed to your network; the redirect never
leaves your machine.

Port busy? Add `PULSE_REDIRECT_URI=http://localhost:8799/callback` to `.env` —
Desktop clients accept any loopback port with no console configuration.

---

## Step 5 — Doctor  ← run this before any real sync

There is no endpoint that tells you which data types an account has, so probing
is the only way to find out.

```bash
python -m pulse doctor
```

**Expected output**

```
timezone in use : America/Chicago
credentials     : set

probing each data type with a short window ...

  OK    heart-rate                      17,280 pts
        fields: beatsPerMinute, sampleTime
  OK    sleep                                1 pts
        fields: interval, metadata, stages, summary, type
  EMPTY daily-heart-rate-variability         no points in this window
  ...

  5/7 data types returning data
```

**How to read it**

| Result | Meaning |
|---|---|
| `OK` | Data is flowing. The `fields:` line shows the **real** field names. |
| `EMPTY` | Not an error. Your Air has not recorded that metric in the window — normal for HRV or SpO2 if you have not worn it overnight yet. |
| `FAIL` | Real problem. The message says which. See troubleshooting. |

You need **at minimum** `heart-rate` and `sleep`. The four daily metrics are
enrichment; the dashboard degrades gracefully without them (recovery falls back
to a neutral baseline, and resting HR is estimated from your sleeping minimum).

**If a field name differs from what Pulse expects, it still works.** The parser
falls back to the single numeric field in the payload. The v4 schema is pre-GA
and still moving, so this is deliberate.

---

## Step 6 — Pull real data

Start small.

```bash
python -m pulse sync 7
```

Seven days, not thirty: if scopes or the account are wrong you find out in
thirty seconds instead of five minutes.

**Expected output**

```
pulling 7 days from the Google Health API ...
  heart-rate                        138,240 points
  sleep                                   8 points
  steps                                 912 points
  daily-resting-heart-rate                8 points
  daily-heart-rate-variability            8 points
  daily-respiratory-rate                  8 points
  daily-oxygen-saturation                 8 points
ok  dashboard.html  (7 days)
```

Heart rate dominates because 5-second sampling is roughly 17,000 points a day.
Counts are one higher than the days you asked for: Pulse fetches an extra day so
the oldest *local* day is complete rather than truncated at the UTC boundary.

Then backfill:

```bash
python -m pulse sync 30
```

Check state any time:

```bash
python -m pulse status
```

---

## Step 7 — Onto the phone

### Option A — QR over wifi (daily use)

```bash
python -m pulse phone
```

Point your camera at the code. The server serves **only** `dashboard.html`.
`pulse.db`, `.env` and `.token.json` all return 404, and there is no directory
listing or path traversal.

### Option B — iCloud Drive (offline, Mac can be asleep)

```bash
cp dashboard.html ~/Library/Mobile\ Documents/com~apple~CloudDocs/
```

Open the **Files** app, tap it. Renders fully offline; everything is inline in
that one file. Open in Safari → **Share → Add to Home Screen** for a full-screen
icon with no browser chrome.

### Option C — AirDrop

It is one ~80 kB file. Genuinely fine for occasional use.

---

## Step 8 — Automate

**What's actually running: GitHub Actions**, not this section. See
[`../.github/workflows/sync.yml`](../.github/workflows/sync.yml) — hourly,
`pulse sync && pulse push`, six repo secrets (documented in the repo root
[`README.md`](../README.md)). Keeping it alive is exactly [2d above](#2d-living-with-testing-mode--refresh_loginsh):
`refresh_login.sh` weekly, nothing else.

The `launchd` approach below is the alternative for running this **entirely
on a Mac**, with no GitHub Actions and no repo secrets involved at all — never
switched to, since Actions covers it without needing this machine to stay on.
Left here in case that trade-off (own machine, own uptime, no cloud secrets)
is ever preferred over the current setup.

`cron` on modern macOS needs Full Disk Access, so `launchd` is more reliable.
Because credentials live in `.env`, the plist does not need to carry them.

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/local.pulse.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.pulse</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PWD/.venv/bin/python</string>
    <string>-m</string><string>pulse</string><string>sync</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$PWD/sync.log</string>
  <key>StandardErrorPath</key><string>$PWD/sync.log</string>
</dict></plist>
EOF

launchctl load ~/Library/LaunchAgents/local.pulse.plist
```

`sync` with **no number** is catch-up mode: it fetches from the newest cached
day forward with a 2-day overlap, so a partially-synced night gets corrected.
Shut for a week? It fetches eight days on the next run. Asleep at 07:00? It runs
on wake. There is no state to repair.

Check it ran: `tail sync.log`.

---

## Command reference

| Command | Network? | Writes | Purpose |
|---|---|---|---|
| `demo [days]` | no | `pulse-demo.db`, `dashboard.html` | Synthetic data. Never touches your real cache. |
| `setup [json]` | no | `.env` | Store client ID/secret and timezone. |
| `login` | yes | `.token.json` | One-time browser sign-in. |
| `doctor [days]` | yes | nothing | Probe types, show real field names. |
| `sync [days]` | yes | `pulse.db`, `dashboard.html` | Pull. No number = catch up. |
| `build` | no | `dashboard.html` | Re-render from cache. |
| `phone [port]` | LAN | nothing | Serve one file, print QR. |
| `status` | no | nothing | Credentials, connection, cache. |

Bare `python -m pulse` prints help and touches nothing.

---

## What each number means

### The three headline KPIs

| KPI | Range | How it is computed |
|---|---|---|
| **Day strain** | 0–21 | Banister TRIMP-exp integrated over every heart-rate sample, then log-compressed. Passive time is included, so a sedentary day still scores. The green arc is your recovery-scaled target. |
| **Recovery** | 0–100 | 55% HRV + 25% inverted resting HR + 20% sleep performance, each a z-score against your own trailing 30-day baseline. |
| **Sleep score** | 0–100 | Google's April-2026 six metrics rebuilt from the stage array: duration 50, sound sleep 15, time-to-sound 10, restlessness 10, interruptions 10, full awakenings 5. |

### Everything else

| Metric | How |
|---|---|
| **Zones** | Karvonen heart-rate *reserve* from today's resting HR and Tanaka HRmax (208 − 0.7 × age), not the 220 − age shortcut. Five buckets that tile the whole day, so they sum to your recording time. |
| **Target strain** | `8 + 0.10 × recovery`, ±1.5. Recovery 90 → 15.5–18.5. |
| **Sleep debt** | `0.88 × yesterday + (need − asleep)`, capped at 10 h. Need = 8 h + a surcharge for yesterday's strain above 10. |
| **Consistency** | Circular standard deviation of bedtime over 14 nights, mapped to 0–100. Circular maths is required because bedtimes wrap midnight. |
| **ACWR** | 7-day TRIMP ÷ 28-day TRIMP. 0.8–1.3 is the conventional safe window. |

---

## Expectations worth setting

**Today's strain will look low.** You are looking at the day before it is over.
The card shows a "day in progress" note. Strain accumulates.

**Data is minutes to tens of minutes old.** The watch syncs to your phone about
every 15 minutes in the background, or immediately when you open the Google
Health app. That Bluetooth hop, not this dashboard, sets freshness. The header
shows *"last reading 14:32 · 6 min ago"* and turns amber past 45 minutes.

**Naps are excluded.** Sessions under 3 hours are filtered so a 25-minute nap
cannot be rendered as "last night".

**Recovery needs history.** Z-scores need at least five prior days. Before that
it sits near neutral by design, not by accident.

**Sleep score needs stage data.** If your Air has only synced `CLASSIC` sleep
(no hypnogram), that night is skipped. Wear it overnight and sync again.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403` with `UberMint` / `GaiaMint` | Legacy Fitbit account consented instead of a Google Account | Sign out of the Google Health app, sign back in via **"Continue with Google"** |
| `403` otherwise | API not enabled, or scopes not consented | Enable **Google Health API**, re-run `login` |
| `invalid_grant` after ~a week | App still in **Testing** | Publish to **In production** (2b), then `login` |
| `access_denied` on the consent screen | Account not a test user | Add it under **Audience → Test users** |
| `redirect_uri_mismatch` | Web client without loopback URIs | Recreate as **Desktop app**, or register both `localhost` and `127.0.0.1` |
| `Cannot listen on port 8765` | Port in use | Add `PULSE_REDIRECT_URI=http://localhost:8799/callback` to `.env` |
| `No refresh token returned` | Google withholds on repeat consent | Revoke at **myaccount.google.com/permissions**, log in again |
| `Missing credentials` | `.env` not written | `python -m pulse setup` |
| `No heart-rate data cached` | Sync has not run or returned nothing | `python -m pulse doctor` |
| `No usable sleep sessions` | Only CLASSIC sleep synced (no stages) | Wear it overnight and sync again |
| `400` mentioning query range | Window too large | Already chunked (1 day HR, 30 others). Report it if you see this. |
| `429` | Rate limited | Wait a minute. Limit is 300 req/min; a sync uses ~14. |
| Evening workouts on the wrong day | Timezone unset | `PULSE_TZ` in `.env`, or re-run `setup` |
| Phone cannot reach the URL | Different network or firewall | Same wifi; allow incoming connections for Python if macOS prompts |

---

## Privacy

Google's servers → your Mac → a file. No third party, no analytics, no
telemetry, no server component. `pulse.db` and `dashboard.html` never leave your
machine unless you copy them.

`.env` and `.token.json` hold your credentials and refresh token, both written
`0600` and both in `.gitignore`. Revoke access any time at
**myaccount.google.com/permissions**.

`python -m pulse phone` serves exactly one file. Verified against path
traversal, URL-encoded traversal, dot-segment paths and directory listing:
everything except `dashboard.html` returns 404.
