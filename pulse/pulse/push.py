"""Push computed nights into Supabase.

    python -m pulse push [days]

The bridge between the two halves. Everything upstream of this file already
worked: `sync` pulls the Google Health API into SQLite, `metrics` turns it into
strain/recovery/sleep. This reads that output and upserts one row per night so
the PWA has something to read.

Runs from GitHub Actions hourly, and from a laptop for backfills. Idempotent:
the primary key is the night, so re-pushing an overlapping range overwrites
rather than duplicates.

Credentials come from the environment. Locally that means web/.env.local, which
is gitignored; in Actions they are repository secrets. The service_role key
bypasses RLS, which is why this never runs anywhere near a browser.
"""
from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as cfg
from . import ingest
from . import metrics as mx
from . import render

# Google's own curve is ~2 s (measured: 36,000 samples/day). Storing that raw
# is 146 KB per night and 52 MB/year for detail no chart can resolve; at one
# minute it is 4.9 KB and pixel-identical at any sane chart width.
CURVE_BUCKET_SEC = 60

# hr_curve is one CIVIL DAY, 00:00 to 24:00 local.
#
# It used to be anchored on the sleep session (sleep_start - 6h to sleep_end
# + 2h), which meant roughly 09:00-17:30 of every day was simply never stored:
# the dashboard could not draw an afternoon because no afternoon existed in the
# database. Anchoring on midnight instead makes the Day tab agree with the
# other things on it -- steps, strain and zone_min were always civil-day totals
# for the row's own date, and the heart-rate curve was the one panel keeping
# different hours from its neighbours.
#
# A drinking session straddles this boundary (9pm-1am lands on two days), which
# is deliberate and handled in the browser: the PWA now picks drink markers by
# timestamp-within-the-drawn-window rather than by night key, and the day
# stepper walks across the split.
CURVE_DAY_H = 24


# ------------------------------------------------------------------- config
def _load_local_env():
    """.env.local for laptop runs. Actions injects the same names directly.

    pulse/ is a subdirectory of the fitbitair-pwa repo -- the PWA half
    (Vercel deploys from the repo root) and this half share one .env.local,
    one level up from cfg.ROOT. Checked in order: that current layout first,
    then two older ones (pulse as a sibling repo, and before that a nested
    web/ dir) for anyone who hasn't re-synced past this move.
    """
    for p in (cfg.ROOT.parent / ".env.local",
              cfg.ROOT.parent / "fitbitair-pwa" / ".env.local",
              cfg.ROOT / "web" / ".env.local"):
        try:
            text = p.read_text()
            break
        except OSError:
            continue
    else:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _creds():
    _load_local_env()
    url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    # The dashboard shows a REST URL; PostgREST paths are appended below, so
    # trim it back to the origin or every request doubles the /rest/v1.
    if url.endswith("/rest/v1"):
        url = url[: -len("/rest/v1")]
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise SystemExit(
            "Missing Supabase credentials.\n"
            "  Local : fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in web/.env.local\n"
            "  CI    : add them as repository secrets\n"
            "See web/.env.example.")
    return url, key


# --------------------------------------------------------------------- http
def _request(url, key, path, payload=None, method="POST", prefer=None):
    body = None
    if payload is not None:
        body = json.dumps(payload, allow_nan=False).encode()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(url + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"supabase {e.code} on {method} {path}: {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"cannot reach supabase: {e.reason}") from None


# ------------------------------------------------------------------ shaping
def _clean(v):
    """NaN/NaT/numpy scalars -> JSON-safe.

    json.dumps writes a bare NaN, which is valid Python and invalid JSON;
    PostgREST rejects the whole batch with a parse error that names no column.
    """
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (pd.Timestamp, datetime)):
        if pd.isna(v):
            return None
        # Naive timestamps are local civil time throughout this codebase.
        t = v.tz_localize(mx._tz()) if v.tzinfo is None and mx._tz() else v
        return t.isoformat()
    if isinstance(v, (np.ndarray, list, tuple)):
        return [_clean(x) for x in v]
    return v


def _curve(hr, day):
    """One-minute mean bpm across one civil day, as [["HH:MM", bpm], ...].

    Timestamps are naive local civil time throughout this codebase (see
    _clean), so normalising `day` and adding 24 hours is the whole boundary --
    no zone conversion here, and none wanted: the day this belongs to was
    already decided upstream.

    Today comes back partial, ending at the last sample the watch has synced,
    which is the honest answer for a day still in progress.
    """
    if hr is None or hr.empty or pd.isna(day):
        return None
    lo = pd.Timestamp(day).normalize()
    hi = lo + pd.Timedelta(hours=CURVE_DAY_H)
    w = hr[(hr["ts"] >= lo) & (hr["ts"] < hi)]
    if w.empty:
        return None
    g = (w.set_index("ts")["bpm"]
           .resample(f"{CURVE_BUCKET_SEC}s").mean().dropna())
    return [[t.strftime("%H:%M"), int(round(b))] for t, b in g.items()]


def _nadir(hr, start, end):
    """Lowest heart rate during sleep, and when it arrived.

    Not in metrics.py because nothing rendered it before. Time-to-nadir is the
    steadier alcohol signal: on a sober night the floor lands ~90 min after
    onset, and alcohol pushes it by hours without letting it go as low.

    Smoothed over 5 minutes first -- the raw 2 s stream has single-sample dips
    that would otherwise win every night and carry no information.
    """
    if hr is None or hr.empty or pd.isna(start) or pd.isna(end):
        return None, None
    w = hr[(hr["ts"] >= start) & (hr["ts"] <= end)]
    if w.empty:
        return None, None
    s = w.set_index("ts")["bpm"].resample("60s").mean().dropna()
    if s.empty:
        return None, None
    s = s.rolling(5, center=True, min_periods=2).mean()
    i = s.idxmin()
    return int(round(float(s.loc[i]))), i


def _stages(night):
    """Hypnogram segments as minute offsets from the session start.

    Offsets rather than timestamps: the chart only ever draws them relative to
    the night, and integers keep the payload a fifth of the size.
    """
    if not night or not night.get("stages"):
        return None
    t0 = pd.Timestamp(night["start"])
    return [{"t": s["type"],
             "a": int(round((pd.Timestamp(s["start"]) - t0).total_seconds() / 60)),
             "b": int(round((pd.Timestamp(s["end"]) - t0).total_seconds() / 60))}
            for s in night["stages"]]


def _daily_steps(con):
    """Steps arrive as per-minute intervals with a string `count`."""
    out = {}
    for p in ingest.load("steps", con):
        b = p.get("steps") or {}
        iv = b.get("interval") or {}
        if "startTime" not in iv:
            continue
        n = mx._f(b.get("count"))
        if n is None:
            continue
        d = mx.to_local(iv["startTime"]).date()
        out[d] = out.get(d, 0) + n
    return out


def _baseline(series, upto, days=None):
    """Trailing median over the baseline window, excluding the night itself.

    Median rather than mean: one 2am flight or one fever should not move the
    line every drinking night is measured against.
    """
    days = days or cfg.BASELINE_DAYS
    lo = upto - pd.Timedelta(days=days)
    hist = [v for d, v in series.items()
            if lo <= pd.Timestamp(d) < upto and v is not None and not pd.isna(v)]
    return float(np.median(hist)) if len(hist) >= 3 else None


def build_rows(con=None):
    """Every night we can compute, shaped for the nights table."""
    own = con is None
    con = con if con is not None else ingest.db()
    try:
        D = render.compute(con)
        steps = _daily_steps(con)
        spo2_f = cfg.DAILY_FIELDS["daily-oxygen-saturation"][1]
        spo2_df = mx.normalize_daily(
            ingest.load("daily-oxygen-saturation", con),
            cfg.DAILY_FIELDS["daily-oxygen-saturation"][0], spo2_f)
        rr_f = cfg.DAILY_FIELDS["daily-respiratory-rate"][1]
    finally:
        if own:
            con.close()

    m, hr = D["m"], D["hr"]
    spo2 = dict(zip(spo2_df["date"], spo2_df[spo2_f])) if not spo2_df.empty else {}
    rr = dict(zip(D["rr"]["date"], D["rr"][rr_f])) if not D["rr"].empty else {}
    hrv_map, rhr_map = D["hrv_map"], D["rhr_map"]

    # The deep-sleep RMSSD rides in the same payload as the average but is not
    # in DAILY_FIELDS, so pull it straight off the raw points.
    deep_rmssd = {}
    con2 = ingest.db() if own else con
    try:
        for p in ingest.load("daily-heart-rate-variability", con2):
            b = p.get("dailyHeartRateVariability") or {}
            d = mx._civil_date(b.get("date"))
            v = mx._f(b.get("deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds"))
            if d and v is not None:
                deep_rmssd[pd.Timestamp(d)] = v
    finally:
        if own:
            con2.close()

    # main_sleeps() already picked one session per day; index it by the civil
    # date of its end so each row can carry its own hypnogram.
    by_night = {pd.Timestamp(n["end"]).normalize(): n for n in D["nights"]}

    rows = []
    for _, r in m.iterrows():
        night = pd.Timestamp(r["date"])
        night_obj = by_night.get(night)
        start, end = r.get("start"), r.get("end")
        nadir_bpm, nadir_at = _nadir(hr, start, end)
        rows.append({
            "night": night.strftime("%Y-%m-%d"),
            "hrv_rmssd": _clean(hrv_map.get(night)),
            "hrv_baseline": _clean(_baseline(hrv_map, night)),
            "hrv_deep_rmssd": _clean(deep_rmssd.get(night)),
            "rhr": _clean(rhr_map.get(night)),
            "rhr_baseline": _clean(_baseline(rhr_map, night)),
            "resp_rate": _clean(rr.get(night)),
            "spo2": _clean(spo2.get(night)),
            "steps": _clean(steps.get(night.date())),
            "sleep_start": _clean(start),
            "sleep_end": _clean(end),
            "total_sleep_min": _clean(r.get("asleep")),
            "rem_min": _clean(r.get("rem")),
            "deep_min": _clean(r.get("deep")),
            "light_min": _clean(r.get("light")),
            "waso_min": _clean(r.get("awake")),
            "sleep_debt_min": _clean(r.get("debt")),
            "in_bed_min": _clean(r.get("in_bed")),
            "sleep_need_min": _clean(r.get("need")),
            "sleep_score": _clean(r.get("score")),
            "recovery": _clean(r.get("recovery")),
            "strain": _clean(r.get("strain")),
            "hrmax": _clean(D["hrmax"]),
            "zone_min": [int(round(_clean(r.get(f"z{i}")) or 0)) for i in range(1, 6)],
            "stages": _stages(night_obj),
            "hr_nadir_bpm": _clean(nadir_bpm),
            "hr_nadir_at": _clean(nadir_at),
            "hr_curve": _curve(hr, night),
        })
    # int columns in Postgres reject 374.5
    for row in rows:
        for k in ("total_sleep_min", "rem_min", "deep_min", "light_min",
                  "waso_min", "steps", "hr_nadir_bpm", "sleep_debt_min",
                  "in_bed_min", "sleep_need_min"):
            if row[k] is not None:
                row[k] = int(round(row[k]))
    return rows


# --------------------------------------------------------------------- push
def push(rows=None, verbose=True):
    url, key = _creds()
    rows = build_rows() if rows is None else rows
    if not rows:
        raise SystemExit("nothing to push -- run `python -m pulse sync` first")

    ok, msg = True, f"{len(rows)} nights"
    try:
        # merge-duplicates makes this an upsert on the night primary key.
        _request(url, key, "/rest/v1/nights", rows, "POST",
                 prefer="resolution=merge-duplicates,return=minimal")
        if verbose:
            span = f"{rows[0]['night']} .. {rows[-1]['night']}"
            print(f"pushed {len(rows)} nights  ({span})")
            curve = sum(1 for r in rows if r["hr_curve"])
            print(f"  {curve} with an hr curve, "
                  f"{sum(1 for r in rows if r['hrv_rmssd'] is not None)} with HRV")
    except Exception as e:                                  # noqa: BLE001
        ok, msg = False, str(e)[:400]
        raise
    finally:
        # The dead man's check the PWA reads. Written even on failure, so a
        # broken sync surfaces as a stale-and-failed banner rather than silence.
        try:
            _request(url, key, "/rest/v1/sync_state?id=eq.1",
                     {"last_sync_at": datetime.now(timezone.utc).isoformat(),
                      "last_ok": ok, "message": msg},
                     "PATCH", prefer="return=minimal")
        except Exception as e:                              # noqa: BLE001
            print(f"warning: could not update sync_state: {e}")
    return len(rows)
