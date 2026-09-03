"""Google Health API v4 client + SQLite cache + synthetic generator.

The whole API is one resource shape:
    GET /v4/users/me/dataTypes/{type}/dataPoints?filter=<AIP-160 expr>
with four read methods composed on: list, reconcile, rollUp, dailyRollUp.

We use :list, which keeps per-point dataSource provenance. Switch to
:reconcile if you ever wear two devices writing the same metric -- Google then
merges the streams server-side.
"""
from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

from . import config as cfg
from .auth import access_token  # noqa: F401  (re-exported for convenience)

UTC = timezone.utc


# ----------------------------------------------------------------- storage
def db(path=None):
    con = sqlite3.connect(path or cfg.DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS raw(
        data_type TEXT, pit TEXT, payload TEXT,
        PRIMARY KEY (data_type, pit))""")
    return con


def _camel(s):
    a, *b = s.split("-")
    return a + "".join(w.title() for w in b)


def _pit(dt, p):
    """Stable per-point key so re-syncing an overlapping range is idempotent."""
    body = p.get(_camel(dt)) or {}
    key = (body.get("sampleTime", {}).get("physicalTime")
           or body.get("interval", {}).get("startTime")
           or body.get("date")
           or p.get("name")
           or json.dumps(body, sort_keys=True)[:120])
    # Daily types carry the civil date as {year, month, day}, and sqlite3 cannot
    # bind a dict -- every daily sync died on "unsupported type" after the point
    # itself had already been fetched. Render it as YYYY-MM-DD so the key stays
    # readable in the cache, and fall back to JSON for any other dict shape.
    if isinstance(key, dict):
        y, m, d = key.get("year"), key.get("month"), key.get("day")
        if None not in (y, m, d):
            key = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
        else:
            key = json.dumps(key, sort_keys=True)[:120]
    return str(key)


def save(data_type, points, con):
    rows = [(data_type, _pit(data_type, p), json.dumps(p)) for p in points]
    con.executemany("INSERT OR REPLACE INTO raw VALUES (?,?,?)", rows)
    con.commit()
    return len(rows)


def load(data_type, con):
    cur = con.execute("SELECT payload FROM raw WHERE data_type=? ORDER BY pit",
                      (data_type,))
    return [json.loads(r[0]) for r in cur]


# ----------------------------------------------------------------- fetch
def _explain(e, data_type):
    """Turn Google's terse errors into something actionable."""
    try:
        msg = json.loads(e.read()).get("error", {}).get("message", "")
    except Exception:
        msg = ""
    hint = ""
    if e.code == 403 and ("UberMint" in msg or "GaiaMint" in msg):
        hint = ("\n  -> Your Fitbit account is still a legacy Fitbit login rather than a"
                "\n     Google Account. Sign out of the Google Health app, then sign back"
                "\n     in using 'Continue with Google'.")
    elif e.code == 403:
        hint = ("\n  -> Check the Google Health API is Enabled in your Cloud project and"
                "\n     that you consented to all three scopes.")
    elif e.code == 401:
        hint = "\n  -> Token expired or revoked. Run: python -m pulse login"
    elif e.code == 429:
        hint = "\n  -> Rate limited (300 req/min per user). Wait a minute and retry."
    elif e.code == 400:
        hint = ("\n  -> Bad request. Usually a query window over the limit (14 days for"
                "\n     heart-rate, 90 for others) or a wrong filter field for the kind.")
    return f"{data_type}: HTTP {e.code} {msg}{hint}"


def fetch(data_type, start: datetime, end: datetime, token, method="list"):
    """One data type, one window, following pagination to the end."""
    kind, field = cfg.DATA_TYPES[data_type]
    if kind == "daily":
        # Daily types filter on a civil date, not an instant.
        expr = f'{field} >= "{start:%Y-%m-%d}" AND {field} < "{end:%Y-%m-%d}"'
    else:
        expr = (f'{field} >= "{start.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}" AND '
                f'{field} < "{end.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}"')

    base = f"{cfg.API_ROOT}/users/me/dataTypes/{data_type}/dataPoints"
    if method != "list":
        base += f":{method}"

    out, page, guard = [], None, 0
    while True:
        guard += 1
        if guard > 500:                      # pagination loop insurance
            raise RuntimeError(f"{data_type}: too many pages; aborting")
        q = {"filter": expr, "pageSize": "10000"}
        if page:
            q["pageToken"] = page
        req = urllib.request.Request(base + "?" + urllib.parse.urlencode(q),
                                     headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(_explain(e, data_type)) from None
        except urllib.error.URLError as e:
            raise RuntimeError(f"{data_type}: network error: {e.reason}") from None
        out += body.get("dataPoints", [])
        page = body.get("nextPageToken")
        if not page:
            break
    return out


def last_cached_day(con):
    """Newest day present in the cache, or None. Drives catch-up sync."""
    row = con.execute("SELECT MAX(pit) FROM raw WHERE data_type=?",
                      ("daily-resting-heart-rate",)).fetchone()
    if not row or not row[0]:
        row = con.execute("SELECT MAX(pit) FROM raw WHERE data_type=?",
                          ("heart-rate",)).fetchone()
    if not row or not row[0]:
        return None
    try:
        return datetime.strptime(str(row[0])[:10], "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        return None


def sync(days=None, con=None, verbose=False, progress=None):
    """Pull every configured data type into the local cache.

    days=None means catch up: from the newest cached day to today, with a 2-day
    overlap so a partially-synced night is corrected. Empty cache falls back to
    30 days. A laptop shut for a week heals itself on the next run.
    """
    con = con if con is not None else db()
    token = access_token()
    end = (datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
           + timedelta(days=1))

    if days is None:
        last = last_cached_day(con)
        days = 30 if last is None else max(2, (end - last).days + 1)
        days = min(days, 365)
    days = max(1, int(days))

    # Fetch one extra day at the start. The API windows on UTC instants but we
    # aggregate in local civil time, so a window beginning at UTC midnight
    # leaves the earliest *local* day short by the UTC offset (5 h in Chicago).
    # Without this, the oldest day on every chart shows an artificially low
    # strain. One extra request per type is a cheap fix.
    span = days + 1

    counts = {}
    for dt in cfg.DATA_TYPES:
        # Chunk to respect Google's per-request window cap rather than trusting
        # the caller: 14 days for heart-rate, 90 for the rest.
        step = max(1, min(cfg.MAX_WINDOW_DAYS.get(dt, cfg.DEFAULT_WINDOW_DAYS), span))
        pts = []
        for off in range(0, span, step):
            w0 = end - timedelta(days=span - off)
            w1 = min(w0 + timedelta(days=step), end)
            if progress:
                progress(dt, off // step + 1, (span + step - 1) // step)
            pts += fetch(dt, w0, w1, token)
        counts[dt] = save(dt, pts, con)
        if verbose:
            print(f"  {dt:32s} {counts[dt]:>8,}")
    return counts


def probe(days=2):
    """Pre-flight: hit every data type with a tiny window and report what the
    account actually returns, including real field names.

    There is no endpoint listing which data types a user has, so probing is the
    only way to find out. Run before committing to a large sync.
    """
    token = access_token()
    end = (datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
           + timedelta(days=1))
    start = end - timedelta(days=max(1, int(days)))
    out = []
    for dt in cfg.DATA_TYPES:
        row = {"type": dt, "n": 0, "fields": "", "sample": None, "error": ""}
        try:
            pts = fetch(dt, start, end, token)
            row["n"] = len(pts)
            if pts:
                body = pts[0].get(_camel(dt), {})
                row["fields"] = ", ".join(sorted(body.keys()))
                row["sample"] = body
        except RuntimeError as e:
            row["error"] = str(e).split("\n")[0]
        except Exception as e:                      # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
        out.append(row)
    return out


# ----------------------------------------------------------------- synthetic
def synthesize(days=30, seed=7, con=None):
    """Emit data in the exact v4 wire shape so nothing downstream can tell the
    difference. Lets you build and style the dashboard before touching OAuth."""
    rng = np.random.default_rng(seed)
    con = con if con is not None else db(cfg.DEMO_DB_PATH)
    con.execute("DELETE FROM raw")
    con.commit()
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    hr_pts, sleep_pts, rhr, hrv, rr, spo2, steps = [], [], [], [], [], [], []

    fitness = 0.45
    for d in range(days, 0, -1):
        day = today - timedelta(days=d - 1)
        hard = bool(rng.random() < 0.45) or d == 1
        very = (hard and rng.random() < 0.35) or d == 1
        fitness = 0.90 * fitness + 0.10 * (1.0 if very else 0.55 if hard else 0.15)

        base_rhr = 54 + 2.5 * np.sin(d / 9) + 14 * fitness + rng.normal(0, 1.1)
        base_hrv = 62 - 42 * (fitness - 0.45) + 6 * np.sin(d / 7) + rng.normal(0, 4.5)
        rhr.append(_daily("dailyRestingHeartRate", day,
                          {"beatsPerMinute": round(float(base_rhr), 1)}))
        hrv.append(_daily("dailyHeartRateVariability", day,
                          {"rmssdMilliseconds": round(float(max(18, base_hrv)), 1)}))
        rr.append(_daily("dailyRespiratoryRate", day,
                         {"breathsPerMinute": round(float(14.4 + rng.normal(0, .55)), 1)}))
        spo2.append(_daily("dailyOxygenSaturation", day,
                           {"percentage": round(float(96.4 + rng.normal(0, .7)), 1)}))

        # intraday HR: 5s for the last 3 days, 60s further back, so the demo DB
        # stays small. The real API returns ~5s every day.
        step_s = 5 if d <= 3 else 60
        n = 86400 // step_s
        t = np.arange(n)
        circ = 8 * np.sin(2 * np.pi * (t / n) - 1.9)
        hr = base_rhr + 10 + circ + rng.normal(0, 2.4, n)
        hr[:int(n * 0.28)] = base_rhr + rng.normal(0, 1.7, int(n * 0.28)) - 3   # asleep
        if hard:
            st = int(n * rng.uniform(0.42, 0.72))
            dur = max(12, int((60 if very else 42) * 60 / step_s))
            ramp = np.concatenate([np.linspace(0, 1, dur // 6),
                                   np.ones(dur - 2 * (dur // 6)),
                                   np.linspace(1, 0, dur // 6)])
            peak = (0.90 if very else 0.76) * (208 - 0.7 * cfg.AGE)
            seg = hr[st:st + len(ramp)]
            hr[st:st + len(seg)] += ramp[:len(seg)] * (peak - seg)
            if very:
                for k in range(6):
                    a = st + (600 // step_s) + k * (dur // 7)
                    hr[a:a + (300 // step_s)] += 16
        hr = np.clip(hr, 40, 200)
        src = {"platform": "FITBIT", "device": {"displayName": "Air"},
               "recordingMethod": "AUTOMATICALLY_RECORDED"}
        for i in range(n):
            hr_pts.append({"dataSource": src, "heartRate": {
                "sampleTime": {"physicalTime":
                               (day + timedelta(seconds=int(i * step_s))
                                ).strftime("%Y-%m-%dT%H:%M:%SZ")},
                "beatsPerMinute": int(round(hr[i]))}})

        # The wire format is "count", as a STRING, on per-minute intervals --
        # verified against a live account 2026-09-03. This emits one daily
        # bucket rather than 1,440 tiny ones, but matches the field name and
        # type so anything that parses real data also parses the demo.
        steps.append({"steps": {"interval": {
            "startTime": day.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endTime": (day + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")},
            "count": str(int(rng.normal(11000 if hard else 6500, 1800)))}})

        sleep_pts.append(_night(day, rng))

    for name, pts in [("heart-rate", hr_pts), ("sleep", sleep_pts), ("steps", steps),
                      ("daily-resting-heart-rate", rhr),
                      ("daily-heart-rate-variability", hrv),
                      ("daily-respiratory-rate", rr),
                      ("daily-oxygen-saturation", spo2)]:
        save(name, pts, con)
    return con


def _daily(key, day, body):
    return {key: {"date": day.strftime("%Y-%m-%d"), **body}}


def _night(day, rng):
    """One sleep session with realistic ~90min ultradian cycle structure."""
    bed = day - timedelta(hours=float(rng.normal(1.2, 0.9)))
    total = int(rng.normal(495, 62))
    if rng.random() < 0.18:
        total -= int(rng.uniform(50, 110))
    stages = [("AWAKE", 0, int(max(3, rng.lognormal(2.5, 0.55))))]
    elapsed = stages[0][2]
    cyc = 0
    while elapsed < total and cyc < 7:
        deep_w = max(0.05, 0.34 - 0.07 * cyc)
        rem_w = min(0.42, 0.10 + 0.09 * cyc)
        for name, mins in (("LIGHT", int(rng.normal(30, 7))),
                           ("DEEP", int(rng.normal(90 * deep_w, 6))),
                           ("LIGHT", int(rng.normal(18, 5))),
                           ("REM", int(rng.normal(90 * rem_w, 6)))):
            mins = max(2, mins)
            stages.append((name, elapsed, mins))
            elapsed += mins
        if rng.random() < 0.80:
            w = int(max(1, rng.lognormal(1.35, 0.95)))
            stages.append(("AWAKE", elapsed, w))
            elapsed += w
        for _ in range(int(rng.poisson(2.2))):
            stages.append(("AWAKE", elapsed, 1))
            elapsed += 1
        cyc += 1

    out, summ = [], {}
    for name, off, mins in stages:
        s = bed + timedelta(minutes=off)
        out.append({"type": name,
                    "startTime": s.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "endTime": (s + timedelta(minutes=mins)).strftime("%Y-%m-%dT%H:%M:%SZ")})
        r = summ.setdefault(name, {"type": name, "count": 0, "minutes": 0})
        r["count"] += 1
        r["minutes"] += mins
    awake = summ.get("AWAKE", {"minutes": 0})["minutes"]
    return {"dataSource": {"platform": "FITBIT", "device": {"displayName": "Air"},
                           "recordingMethod": "DERIVED"},
            "sleep": {"type": "STAGES",
                      "interval": {"startTime": bed.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                   "endTime": (bed + timedelta(minutes=elapsed)
                                               ).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                   "startUtcOffset": "0s", "endUtcOffset": "0s"},
                      "stages": out,
                      "summary": {"minutesInSleepPeriod": elapsed,
                                  "minutesAsleep": elapsed - awake,
                                  "minutesAwake": awake,
                                  "minutesAfterWakeUp": 0,
                                  "minutesToFallAsleep": stages[0][2],
                                  "stagesSummary": list(summ.values())},
                      "metadata": {"processed": True, "stagesStatus": "AVAILABLE"}}}
