"""Derived metrics: strain, recovery, sleep score, consistency.

Everything is transparent and tunable. Where a vendor formula is proprietary
(Bevel strain, Google sleep score) we reimplement from the published
description rather than guessing constants, so numbers track theirs
directionally but will not match digit for digit.

Parsing is deliberately defensive: the v4 schema is pre-GA and still moving,
so a renamed field should degrade to "still works" rather than "KeyError,
nothing renders".
"""
from __future__ import annotations

import math
import warnings

import numpy as np
import pandas as pd

from . import config as cfg

STAGES = ["DEEP", "LIGHT", "REM", "AWAKE"]
VALID_STAGES = set(STAGES)


# ------------------------------------------------------------ timezone
_TZ_CACHE = {}


def _detect_zone_name():
    """Best-effort IANA zone name for this machine.

    Deliberately avoids datetime.now().astimezone().tzinfo: that returns a
    FIXED-offset zone captured at call time, so running in July would apply
    CDT (-5) to January data that was really CST (-6). We need a real zone with
    DST rules, which means an IANA name.
    """
    import os
    name = os.environ.get("TZ")
    if name and "/" in name:
        return name
    # macOS and Linux both symlink /etc/localtime into the tz database
    try:
        p = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in p:
            cand = p.split("zoneinfo/", 1)[1]
            if "/" in cand or cand in ("UTC", "GMT"):
                return cand
    except OSError:
        pass
    # macOS also exposes it here
    try:
        with open("/etc/timezone") as fh:
            cand = fh.read().strip()
            if cand:
                return cand
    except OSError:
        pass
    return None


def _tz():
    """Local zone. The API stores UTC instants; aggregation must happen in
    civil time or evening activity lands on the wrong calendar day."""
    key = cfg.TIMEZONE
    if key in _TZ_CACHE:
        return _TZ_CACHE[key]

    tz = None
    name = key or _detect_zone_name()
    if name:
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(name)
        except Exception:
            warnings.warn(
                f"Unknown timezone {name!r}; falling back to UTC. "
                f"Set a valid IANA name, e.g. PULSE_TZ=America/Chicago")
            tz = None
    else:
        warnings.warn(
            "Could not determine your timezone; using UTC. Evening activity "
            "may be filed on the wrong day. Run `python -m pulse setup` or set "
            "PULSE_TZ=America/Chicago")
    _TZ_CACHE[key] = tz
    return tz


def to_local(x):
    """UTC (tz-aware or Z-suffixed) -> naive local wall-clock."""
    tz = _tz()
    if isinstance(x, pd.Series):
        s = pd.to_datetime(x, utc=True, errors="coerce")
        return s.dt.tz_convert(tz).dt.tz_localize(None) if tz else s.dt.tz_localize(None)
    t = pd.Timestamp(x)
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    return t.tz_convert(tz).tz_localize(None) if tz else t.tz_localize(None)


# ------------------------------------------------------------ normalizing
def _f(v):
    """Coerce an API scalar to float, or None.

    Protobuf-JSON serialises int64 as a *string*, so the live API returns
    "beatsPerMinute": "72" and "minutes": "250" while float fields like
    averageHeartRateVariabilityMilliseconds arrive as real numbers. Type-checking
    for (int, float) therefore silently discarded every integer metric: resting
    heart rate parsed to NaN and the whole daily frame came back empty.
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _civil_date(d):
    """Daily types carry a civil date as {year, month, day}, not a string.

    pandas turns that dict into NaT, and the dropna() in normalize_daily then
    removed every row -- so HRV, resting HR, respiratory rate and SpO2 all came
    back empty while `doctor` happily reported the points as OK.
    """
    if isinstance(d, dict):
        y, m, day = _f(d.get("year")), _f(d.get("month")), _f(d.get("day"))
        if None in (y, m, day):
            return None
        return f"{int(y):04d}-{int(m):02d}-{int(day):02d}"
    return d


def _num(body, *preferred):
    """Pull the metric out of a Daily payload without hardcoding its name.

    Tries documented names first, then falls back to the single numeric field
    that is not a date/count. Keeps the dashboard alive across schema drift.
    """
    for k in preferred:
        v = _f(body.get(k))
        if v is not None:
            return v
    skip = {"date", "count"}
    nums = [(k, _f(v)) for k, v in body.items() if k not in skip]
    nums = [(k, v) for k, v in nums if v is not None]
    if len(nums) == 1:
        return float(nums[0][1])
    for k, v in nums:                       # deterministic tie-break
        if any(w in k.lower() for w in ("value", "rate", "rmssd", "percent",
                                        "bpm", "beats", "avg", "mean")):
            return float(v)
    return float(nums[0][1]) if nums else float("nan")


def normalize_hr(points):
    rows = []
    for p in points:
        b = p.get("heartRate")
        if not b:
            continue
        t = (b.get("sampleTime") or {}).get("physicalTime")
        v = b.get("beatsPerMinute", b.get("bpm"))
        if t is not None and v is not None:
            rows.append((t, v))
    df = pd.DataFrame(rows, columns=["ts", "bpm"])
    if df.empty:
        return df
    df["ts"] = to_local(df["ts"])
    df["bpm"] = pd.to_numeric(df["bpm"], errors="coerce")
    df = df.dropna()
    # physiological sanity: drop impossible readings rather than let one
    # spurious 250 bpm inflate a whole day's strain
    df = df[(df["bpm"] >= 25) & (df["bpm"] <= 240)]
    return df.sort_values("ts").drop_duplicates("ts").reset_index(drop=True)


def normalize_daily(points, key, field):
    rows = []
    for p in points:
        b = p.get(key)
        if not b or "date" not in b:
            continue
        d = _civil_date(b["date"])
        if d is None:
            continue
        rows.append((d, _num(b, field)))
    df = pd.DataFrame(rows, columns=["date", field])
    if df.empty:
        return df
    # Daily types already carry a civil date, so no timezone conversion.
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return (df.dropna().sort_values("date")
              .drop_duplicates("date", keep="last").reset_index(drop=True))


def normalize_sleep(points):
    """Robust against CLASSIC sessions, missing summaries, and bad stages."""
    out = []
    for p in points:
        s = p.get("sleep")
        if not s:
            continue
        iv = s.get("interval") or {}
        if "startTime" not in iv or "endTime" not in iv:
            continue

        stages = []
        for st in (s.get("stages") or []):
            if not {"type", "startTime", "endTime"} <= set(st):
                continue
            if st["type"] not in VALID_STAGES:
                continue                     # unknown enum -> ignore, don't crash
            a, b = to_local(st["startTime"]), to_local(st["endTime"])
            mins = (b - a).total_seconds() / 60
            if mins <= 0:
                continue
            stages.append({"type": st["type"], "start": a, "end": b, "mins": mins})
        if not stages:
            continue        # CLASSIC sleep has no hypnogram; nothing to draw
        stages.sort(key=lambda x: x["start"])

        summ = s.get("summary") or {}
        start, end = to_local(iv["startTime"]), to_local(iv["endTime"])
        if end <= start:
            continue

        in_bed = summ.get("minutesInSleepPeriod")
        if not isinstance(in_bed, (int, float)) or in_bed <= 0:
            in_bed = (end - start).total_seconds() / 60
        awake = summ.get("minutesAwake")
        if not isinstance(awake, (int, float)):
            awake = sum(x["mins"] for x in stages if x["type"] == "AWAKE")
        asleep = summ.get("minutesAsleep")
        if not isinstance(asleep, (int, float)) or asleep <= 0:
            asleep = max(in_bed - awake, 0.0)

        ss = summ.get("stagesSummary")
        if ss:
            # "minutes" arrives as a string ("250"), so coerce or every stage
            # total downstream becomes string concatenation or a TypeError.
            stage_min = {}
            for r in ss:
                if not (isinstance(r, dict) and "type" in r and "minutes" in r):
                    continue
                v = _f(r["minutes"])
                if v is not None:
                    stage_min[r["type"]] = v
        else:
            stage_min = {}
            for x in stages:
                stage_min[x["type"]] = stage_min.get(x["type"], 0) + x["mins"]

        out.append({"start": start, "end": end, "stages": stages,
                    "asleep": float(asleep), "in_bed": float(in_bed),
                    "awake": float(awake),
                    "latency": float(summ.get("minutesToFallAsleep") or 0),
                    "stage_min": stage_min})
    return sorted(out, key=lambda n: n["end"])


# A session longer than this is real (a live account had one: forgot to stop
# tracking, ~17h, WORKOUT), but it is not useful to display next to a day's
# actual workouts -- it would swamp everything around it and read as broken
# rather than as "I forgot to tap stop". Dropped from the list, not clamped:
# strain itself is computed from the continuous heart-rate stream regardless,
# so nothing about the day's actual numbers depends on this record surviving.
MAX_SESSION_MIN = 360


def normalize_exercise(points):
    """Workout sessions -- passively detected by the band, not logged by hand."""
    out = []
    for p in points:
        e = p.get("exercise")
        if not e:
            continue
        iv = e.get("interval") or {}
        if "startTime" not in iv or "endTime" not in iv:
            continue
        start, end = to_local(iv["startTime"]), to_local(iv["endTime"])
        span_min = (end - start).total_seconds() / 60
        if span_min <= 0 or span_min > MAX_SESSION_MIN:
            continue

        # activeDuration ("true active time excluding pauses") is a Duration
        # string ("1231.200s"), separate from the interval above -- but on a
        # genuine session it should never exceed it by much.
        dur = e.get("activeDuration") or ""
        active_min = _f(dur[:-1]) / 60 if dur.endswith("s") else None
        if active_min is None or active_min <= 0 or active_min > span_min * 1.2:
            active_min = span_min

        ms = e.get("metricsSummary") or {}
        out.append({
            "start": start, "end": end, "active_min": active_min,
            "type": e.get("exerciseType") or "WORKOUT",
            "calories": _f(ms.get("caloriesKcal")),
            "avg_hr": _f(ms.get("averageHeartRateBeatsPerMinute")),
            "steps": _f(ms.get("steps")),
        })
    return sorted(out, key=lambda w: w["start"])


def main_sleeps(nights):
    """One session per calendar day: the longest. Drops naps, which would
    otherwise render as 'last night' and wreck every sleep metric."""
    best = {}
    for n in nights:
        if n["asleep"] < cfg.MIN_MAIN_SLEEP_MIN:
            continue
        d = n["end"].normalize()
        if d not in best or n["asleep"] > best[d]["asleep"]:
            best[d] = n
    return [best[k] for k in sorted(best)]


# ------------------------------------------------------------ heart / zones
def hr_max():
    return float(cfg.HR_MAX or (208 - 0.7 * cfg.AGE))   # Tanaka; better than 220-age


def zone_bounds(rhr, hrmax):
    """Karvonen heart-rate-reserve boundaries: personal, not population."""
    rhr = float(np.clip(rhr, 30, hrmax - 30))
    res = hrmax - rhr
    return [int(round(rhr + res * f)) for f in (0.50, 0.60, 0.70, 0.80, 0.90)]


def day_strain(hr_df, rhr, hrmax):
    """Banister TRIMP-exp integrated over the day, then log-compressed.

        trimp = sum_i  dt_i * x_i * k * exp(b * x_i)
        x_i   = (bpm_i - rhr) / (hrmax - rhr)        heart-rate reserve fraction

    Integrating every sample (not just logged workouts) gives passive strain
    for free, which is only possible because the API returns 5-second data.
    Sample gaps are capped at 300 s so an off-wrist hour cannot invent load.
    """
    if hr_df is None or hr_df.empty:
        return 0.0, 0.0, [0.0] * 5
    bpm = hr_df["bpm"].to_numpy(float)
    ts = hr_df["ts"].to_numpy()
    # Each sample covers the interval until the next one (left Riemann sum).
    # The final sample covers nothing measurable, so it is credited 0 -- this
    # attributes exactly the observed span rather than inflating it by one
    # interval. A lone sample therefore contributes no load, which is correct:
    # an instant has no duration.
    if len(bpm) < 2:
        return 0.0, 0.0, [0.0] * 5
    d = np.diff(ts).astype("timedelta64[s]").astype(float)
    dt = np.append(d, 0.0)
    dt = np.clip(dt, 0, 300) / 60.0                     # minutes, gaps capped

    denom = max(hrmax - rhr, 1.0)
    hrr = np.clip((bpm - rhr) / denom, 0, 1.4)
    k, b = (0.64, 1.92) if str(cfg.SEX).upper().startswith("M") else (0.86, 1.67)
    trimp = float(np.sum(dt * hrr * k * np.exp(b * hrr)))

    # Calibrated on whole-day TRIMP with passive time included, as Bevel does:
    # sedentary ~80 -> 8, moderate ~240 -> 14.5, very hard ~400 -> 18.
    a, c = 7.886, 45.5
    strain = min(a * math.log1p(max(trimp, 0) / c), 21.0)
    if cfg.STRAIN_SCALE != 21:
        strain = strain / 21 * cfg.STRAIN_SCALE

    # Five buckets that tile the whole day, so the numbers sum to 24h:
    #   Z1 everything below 60% HRR (rest and light activity)
    #   Z2 60-70, Z3 70-80, Z4 80-90, Z5 90%+
    # Using the 50% boundary as the floor instead would silently discard every
    # sedentary minute, and a rest day would show 0m across all five zones.
    b = zone_bounds(rhr, hrmax)
    edges = [0.0] + [float(x) for x in b[1:]] + [1e9]
    zmin = [float(dt[(bpm >= edges[i]) & (bpm < edges[i + 1])].sum()) for i in range(5)]
    return round(float(strain), 2), round(trimp, 1), zmin


# ------------------------------------------------------------ sleep score
def sleep_score(night, need_min):
    """Reimplementation of Google's April-2026 six-metric Sleep Score.

    Duration carries the majority of the weight; the other five describe how
    the night actually went. Returns (score, per-metric breakdown).
    """
    st = night["stages"]
    asleep = max(float(night["asleep"]), 1.0)
    need_min = max(float(need_min), 1.0)
    t0 = night["start"]

    tss = None                       # time to sound sleep
    for s in st:
        if s["type"] in ("DEEP", "REM") or (s["type"] == "LIGHT" and s["mins"] >= 10):
            tss = (s["start"] - t0).total_seconds() / 60
            break
    tss = float(tss if tss is not None else night["latency"])

    wakes = [s for s in st if s["type"] == "AWAKE" and s["start"] > t0]
    restless = sum(s["mins"] for s in wakes if s["mins"] < 5)
    interruptions = sum(s["mins"] for s in wakes if s["mins"] >= 5)
    full_wakes = sum(1 for s in wakes if s["mins"] >= 5)
    sound = max(0.0, asleep - restless)

    def band(x, best, worst):
        return float(np.clip((worst - x) / (worst - best), 0, 1))

    parts = {
        "Duration":        (50, min(1.0, asleep / need_min) ** 1.9),
        "Time to sound":   (10, band(tss, 12, 45)),
        "Sound sleep":     (15, float(np.clip(sound / asleep, 0, 1)) ** 3.0),
        "Restlessness":    (10, band(restless, 4, 42)),
        "Interruptions":   (10, band(interruptions, 3, 45)),
        "Full awakenings": (5, band(full_wakes, 0, 4)),
    }
    breakdown = {k: (w, round(w * v, 1)) for k, (w, v) in parts.items()}
    total = int(round(sum(v for _, v in breakdown.values())))
    return int(np.clip(total, 0, 100)), breakdown


def sleep_series(nights, strain_map, decay=0.88):
    """Per-night frame with need, debt and performance. Debt carries forward.

    Core need deliberately excludes debt: feeding debt into need makes the two
    reinforce each other and the number pins to its ceiling within a fortnight.
    """
    rows, debt = [], 0.0
    for n in nights:
        d = n["end"].normalize()
        prev = strain_map.get(d - pd.Timedelta(days=1), 0.0)
        core = cfg.SLEEP_NEED_BASE_MIN + min(60.0, 6.0 * max(0.0, prev - 10))
        need = core + min(90.0, 0.40 * debt)       # tonight's displayed target
        score, parts = sleep_score(n, core)
        perf = min(1.0, n["asleep"] / max(need, 1.0))
        # 12%/night natural repayment: debt is not a ledger carried forever
        debt = float(np.clip(decay * debt + (core - n["asleep"]), 0, 600))
        rows.append({"date": d, "start": n["start"], "end": n["end"],
                     "asleep": n["asleep"], "in_bed": n["in_bed"],
                     "efficiency": n["asleep"] / max(n["in_bed"], 1.0),
                     "need": need, "debt": debt, "perf": perf,
                     "score": score, "parts": parts,
                     **{k.lower(): n["stage_min"].get(k, 0) for k in STAGES}})
    return pd.DataFrame(rows)


# ------------------------------------------------------------ recovery
def _z(x, hist):
    """NaN-safe z-score. Returns 0 (neutral) until a baseline exists."""
    hist = [h for h in hist
            if h is not None and not (isinstance(h, float) and math.isnan(h))]
    if x is None or (isinstance(x, float) and math.isnan(x)) or len(hist) < 5:
        return 0.0
    sd = float(np.std(hist))
    return 0.0 if sd < 1e-6 else float(np.clip((x - np.mean(hist)) / sd, -3, 3))


def recovery(hrv, hrv_hist, rhr, rhr_hist, sleep_perf):
    """0-100. HRV dominates, RHR inverts, sleep performance modulates."""
    hrv_c = float(np.clip(0.5 + _z(hrv, hrv_hist) / 4, 0, 1))
    rhr_c = float(np.clip(0.5 - _z(rhr, rhr_hist) / 4, 0, 1))
    sp = sleep_perf
    if sp is None or (isinstance(sp, float) and math.isnan(sp)):
        sp = 0.75
    slp_c = float(np.clip(sp, 0, 1))
    return int(round(100 * (0.55 * hrv_c + 0.25 * rhr_c + 0.20 * slp_c)))


def optimal_strain(rec):
    """Bevel's Target Strain idea: today's ceiling scales with recovery."""
    mid = 8.0 + 0.10 * float(rec)
    return round(mid - 1.5, 1), round(mid + 1.5, 1)


def consistency(nights, n=14):
    """Circular SD of bedtime -> 0-100.

    Circular statistics are required because bedtimes wrap midnight: the
    arithmetic mean of 23:50 and 00:10 is 11:00, which is wrong by 12 hours.
    """
    if len(nights) < 3:
        return 0
    ang = [2 * np.pi * ((x["start"].hour * 60 + x["start"].minute) / 1440)
           for x in nights[-n:]]
    r = float(np.hypot(np.mean(np.cos(ang)), np.mean(np.sin(ang))))
    sd_min = np.sqrt(-2 * np.log(max(r, 1e-9))) * 1440 / (2 * np.pi)
    return int(round(100 * float(np.clip(1 - sd_min / 120, 0, 1))))
