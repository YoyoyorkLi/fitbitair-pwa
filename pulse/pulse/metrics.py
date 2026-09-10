"""Derived metrics: strain, recovery, sleep score, sleep need/debt, consistency.

Everything is transparent and tunable. The full write-up of every formula,
its constants and the research behind them is in pulse/METRICS.md -- keep the
two in sync when you change a number here.

The short version:

  strain      Banister TRIMP-exp over the day's WAKING heart rate, log-
              compressed to 0-21. Sleep is excluded -- an elevated overnight
              resting HR is recovery cost, not training load.
  recovery    55% HRV + 25% inverted resting HR + 20% sleep performance, each
              a z-score vs your own trailing 30-day baseline.
  sleep score quality (how well you slept + how settled your body got, 0-100)
              x how much of your personal `need` you actually slept.
  need        a flat personal baseline (cfg.SLEEP_NEED_MIN), not the
              population 8h, plus a small bump after a hard day.
  sleep debt  rolling shortfall vs need over the last 14 nights, recent
              nights weighted heaviest, capped -- it can reach zero.

None of this reproduces a vendor's undisclosed formula; the numbers track
theirs directionally and will disagree by design.

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
                                        "bpm", "beats", "avg", "mean",
                                        "celsius", "temp", "delta")):
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


def _duration_min(s):
    """Duration string ("1200s") -> minutes. Missing/malformed -> 0.0, not
    None -- these feed a sum (total zone time), where a hole should count as
    zero rather than poison the total."""
    if not isinstance(s, str) or not s.endswith("s"):
        return 0.0
    v = _f(s[:-1])
    return v / 60 if v is not None else 0.0


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
        # Fitbit's own light/moderate/vigorous/peak classification, not a
        # Karvonen recomputation of ours -- this is the same split the Fitbit
        # app's "you spent N minutes in the moderate zone" sentence reads from,
        # so using it directly means we never disagree with what's on the
        # user's phone.
        hrz = ms.get("heartRateZoneDurations") or {}
        zones = {
            "light": _duration_min(hrz.get("lightTime")),
            "moderate": _duration_min(hrz.get("moderateTime")),
            "vigorous": _duration_min(hrz.get("vigorousTime")),
            "peak": _duration_min(hrz.get("peakTime")),
        }
        dist_mm = _f(ms.get("distanceMillimeters"))
        out.append({
            "start": start, "end": end, "active_min": active_min,
            "type": e.get("exerciseType") or "WORKOUT",
            "calories": _f(ms.get("caloriesKcal")),
            "avg_hr": _f(ms.get("averageHeartRateBeatsPerMinute")),
            "steps": _f(ms.get("steps")),
            "distance_m": dist_mm / 1000 if dist_mm is not None else None,
            "pace_s_per_m": _f(ms.get("averagePaceSecondsPerMeter")),
            "azm": _f(ms.get("activeZoneMinutes")),
            "zones": zones,
        })
    return sorted(out, key=lambda w: w["start"])


def main_sleeps(nights):
    """One session per calendar day: the longest. Drops naps, which would
    otherwise render as 'last night' and wreck every sleep metric -- but a
    nap's minutes are still credited toward sleep debt and recovery via
    nap_minutes() below."""
    best = {}
    for n in nights:
        if n["asleep"] < cfg.MIN_MAIN_SLEEP_MIN:
            continue
        d = n["end"].normalize()
        if d not in best or n["asleep"] > best[d]["asleep"]:
            best[d] = n
    return [best[k] for k in sorted(best)]


def nap_minutes(nights_all, mains):
    """Total nap minutes per civil day -- every session main_sleeps() rejected
    (too short, or the shorter of two on a day), keyed by the day it STARTED
    on since a nap is a daytime event.

    Naps do not get a sleep *score* -- that is one main night's architecture,
    which a nap can't retroactively change -- but they genuinely lower sleep
    pressure, so their minutes count toward `need` / debt / recovery. Sessions
    under 10 min are dropped as noise (a "21 min, 8 asleep" wake-up blip).
    """
    main_keys = {(m["start"], m["end"]) for m in mains}
    out = {}
    for n in nights_all:
        if (n["start"], n["end"]) in main_keys or n["asleep"] < 10:
            continue
        d = n["start"].normalize()
        out[d] = out.get(d, 0.0) + float(n["asleep"])
    return out


# ------------------------------------------------------------ heart / zones
def hr_max():
    return float(cfg.HR_MAX or (208 - 0.7 * cfg.AGE))   # Tanaka; better than 220-age


def zone_bounds(rhr, hrmax):
    """Karvonen heart-rate-reserve boundaries: personal, not population."""
    rhr = float(np.clip(rhr, 30, hrmax - 30))
    res = hrmax - rhr
    return [int(round(rhr + res * f)) for f in (0.50, 0.60, 0.70, 0.80, 0.90)]


def day_strain(hr_df, rhr, hrmax, asleep=None):
    """Banister TRIMP-exp over the day's WAKING samples, then log-compressed.

        trimp = sum_i  dt_i * x_i * k * exp(b * x_i)       (i awake only)
        x_i   = (bpm_i - rhr) / (hrmax - rhr)        heart-rate reserve fraction

    Strain answers "what did I do to my body today" -- exertion, load you can
    weigh against recovery. Sleep is excluded (`asleep`, a bool mask aligned to
    hr_df): an elevated resting heart rate overnight -- from alcohol, illness,
    a hot room -- is your body spending energy to RECOVER, not training load,
    and counting it as strain makes strain and recovery move together and stop
    meaning anything. That cost lands on the recovery side instead, where the
    overnight HRV/RHR it depresses already live.

    Sample gaps are capped at 300 s so an off-wrist hour cannot invent load.
    `zmin` (time-in-zone) still spans the whole day, sleep included -- it is a
    description of where your heart rate sat, not a load figure.
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

    # Awake-only minutes drive strain; the full dt still drives time-in-zone.
    awake_dt = dt
    if asleep is not None:
        awake_dt = np.where(np.asarray(asleep, dtype=bool), 0.0, dt)

    denom = max(hrmax - rhr, 1.0)
    hrr = np.clip((bpm - rhr) / denom, 0, 1.4)
    k, b = (0.64, 1.92) if str(cfg.SEX).upper().startswith("M") else (0.86, 1.67)
    trimp = float(np.sum(awake_dt * hrr * k * np.exp(b * hrr)))

    # The log curve itself is unchanged from when passive time was included --
    # it was never the problem. Dropping sleep from `trimp` is what makes a
    # hungover rest morning stop reading as a workout: a genuinely sedentary
    # waking day now lands ~5, a day on your feet ~8, a moderate session ~13,
    # a hard one ~17.
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
TIMING_HISTORY = 14   # nights of rolling bed/wake-time baseline for "Sleep timing"


def _tod_since_6pm(dt):
    """Minutes since the most recent 6pm.

    A plain clock-time average of bed/wake times wraps at midnight -- an
    11pm and a 1am bedtime would average to noon. Anchoring the day at 6pm
    (well before anyone's bedtime and after anyone's wake time) puts a
    normal night on one continuous, averageable axis instead.
    """
    anchor = dt.replace(hour=18, minute=0, second=0, microsecond=0)
    if dt < anchor:
        anchor -= pd.Timedelta(days=1)
    return (dt - anchor).total_seconds() / 60


def _isnum(v):
    """A real, finite number -- not None, not NaN. Used everywhere a daily API
    metric might be missing for a night."""
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def _sleep_settled(hrv, hrv_hist, rhr, rhr_hist):
    """"How settled did your body get overnight" -- 0..1, or None until a
    baseline exists. This is where alcohol, illness and stress land on the
    sleep score: the daily overnight HRV falls and the overnight resting HR
    rises, both dose-dependently, and both against YOUR OWN 30-day normal.

    HRV weighs more than RHR (nominally 21 vs 14 of the 35 "settled" points),
    and the z divisor is 3 rather than recovery()'s 4 so a heavy night's
    ~1.5-sigma HRV drop drives this most of the way to zero on its own. When
    only one of the two signals has a baseline yet, it carries the whole
    score rather than being averaged against a flat 0.5 neutral.
    """
    have_hrv = _isnum(hrv) and sum(_isnum(h) for h in hrv_hist) >= 5
    have_rhr = _isnum(rhr) and sum(_isnum(h) for h in rhr_hist) >= 5
    if not have_hrv and not have_rhr:
        return None, {}
    hrv_c = float(np.clip(0.5 + _z(hrv, hrv_hist) / 3.0, 0, 1))
    rhr_c = float(np.clip(0.5 - _z(rhr, rhr_hist) / 3.0, 0, 1))
    w_hrv, w_rhr = 21 * have_hrv, 14 * have_rhr
    parts = {}
    if have_hrv:
        parts["HRV overnight"] = (21, round(21 * hrv_c, 1))
    if have_rhr:
        parts["Resting HR overnight"] = (14, round(14 * rhr_c, 1))
    return (w_hrv * hrv_c + w_rhr * rhr_c) / (w_hrv + w_rhr), parts


def sleep_score(night, target_min, timing_dev=None,
                rem_base=None, deep_base=None,
                settled=None, settled_parts=None):
    """Sleep score = quality (0-100) x how much of `target_min` you slept.

    quality blends "how well you slept" -- efficiency, REM, deep, wake-ups,
    latency, timing, graded against YOUR OWN recent normal where a baseline
    exists and textbook ranges before that -- at 65% with "how settled your
    body got" (overnight HRV / resting HR vs baseline, passed in as `settled`)
    at 35%.

    `target_min` is the duration divisor. sleep_series passes NEED plus a
    capped slice of standing debt, so the length multiplier does two things:
    a short night can't score high however clean it was (5h vs a 7h target ->
    x0.71), and a flat 7h night only scores a clean 90 when you're caught up
    -- carry debt and the target rises toward 8-8.5h.

    Returns (score, parts, quality, dur_factor). `parts` is {label: (weight,
    got)} for the breakdown chart; weights are out of 100.
    """
    st = night["stages"]
    asleep = max(float(night["asleep"]), 1.0)
    in_bed = max(float(night["in_bed"]), asleep)
    need_min = max(float(target_min), 1.0)
    t0 = night["start"]
    sm = night["stage_min"]

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
    efficiency = asleep / in_bed

    def band(x, best, worst):
        return float(np.clip((worst - x) / (worst - best), 0, 1))

    def in_range(x, low, tlo, thi, high):
        if x < low or x > high:
            return 0.0
        if x < tlo:
            return (x - low) / (tlo - low)
        if x > thi:
            return (high - x) / (high - thi)
        return 1.0

    def vs_base(x, base, floor=0.5):
        """Credit for reaching your own recent normal, 0 by `floor` x that,
        capped at 1.0 -- more than usual earns full credit, never a bonus, so
        alcohol's first-half deep-sleep spike can't inflate the score."""
        if not base or base <= 0:
            return None
        return float(np.clip((x / base - floor) / (1.0 - floor), 0, 1))

    rem_v = vs_base(sm.get("REM", 0), rem_base)
    if rem_v is None:                                    # no personal baseline yet
        rem_v = in_range(100 * sm.get("REM", 0) / asleep, 5, 18, 28, 45)
    deep_v = vs_base(sm.get("DEEP", 0), deep_base)
    if deep_v is None:
        deep_v = in_range(100 * sm.get("DEEP", 0) / asleep, 3, 13, 23, 35)

    # "How well you slept" -- weights out of 100, summing to 65.
    well = {
        "Efficiency":      (10, band(efficiency, 0.95, 0.75)),
        "REM sleep":       (13, rem_v),
        "Deep sleep":      (10, deep_v),
        "Time to sleep":   (8, band(tss, 10, 30)),
        "Restlessness":    (6, band(restless, 2, 25)),
        "Interruptions":   (6, band(interruptions, 0, 30)),
        "Full awakenings": (5, band(full_wakes, 0, 3)),
        "Sleep timing":    (7, 1.0 if timing_dev is None else band(timing_dev, 20, 90)),
    }
    well_frac = (sum(w * v for w, v in well.values())
                 / sum(w for w, _ in well.values()))

    parts = {k: (w, round(w * v, 1)) for k, (w, v) in well.items()}
    if settled_parts:
        parts.update(settled_parts)

    if settled is None:                                 # first ~5 nights, no baseline
        quality = 100.0 * well_frac
    else:
        quality = 100.0 * (0.65 * well_frac + 0.35 * float(settled))

    dur_factor = min(1.0, asleep / need_min)
    score = int(np.clip(round(quality * dur_factor), 0, 100))
    return score, parts, round(quality, 1), round(dur_factor, 3)


def _sleep_debt(need, asleep):
    """Rolling shortfall vs need over the last cfg.SLEEP_DEBT_WINDOW nights,
    recent nights weighted heaviest (linear taper), capped at the cfg cap.

    A shortfall from beyond the window is simply gone -- not "repaid" but aged
    out, matching that subjective sleepiness adapts to chronic restriction
    even as the deficit persists. A night OVER need pays down at
    SLEEP_DEBT_SURPLUS_CREDIT rate: catch-up sleep helps, but slowly.
    """
    deficit = np.asarray(need, float) - np.asarray(asleep, float)
    contrib = np.where(deficit > 0, deficit,
                       cfg.SLEEP_DEBT_SURPLUS_CREDIT * deficit)
    W = int(cfg.SLEEP_DEBT_WINDOW)
    out = np.zeros(len(deficit))
    for i in range(len(deficit)):
        seg = contrib[max(0, i - W + 1): i + 1][::-1]     # seg[0] = tonight
        w = (W - np.arange(len(seg))) / W                 # 1.0 .. 1/W
        out[i] = float(np.clip(np.sum(seg * w), 0.0, cfg.SLEEP_DEBT_CAP_MIN))
    return out


def sleep_series(nights, strain_map, hrv_map=None, rhr_map=None, nap_min=None):
    """Per-night frame: need, debt, sleep score and its parts.

    need         flat personal baseline (cfg.SLEEP_NEED_MIN) plus a small bump
                 the night after a hard day. What debt and recovery-perf are
                 reckoned against.
    debt         a rolling window (see _sleep_debt) over `asleep_total` (main
                 sleep + that day's naps).
    score_target need PLUS a capped slice of the debt you carried INTO the
                 night -- the divisor for the SCORE's duration term only, so a
                 flat 7h night lands a clean 90 only when you're caught up.
    score        quality x fraction-of-score_target-slept (see sleep_score),
                 MAIN sleep only -- a nap doesn't change last night's shape.
    perf         asleep_total / need, for recovery()'s sleep term -- naps count.

    nap_min: {civil_date -> minutes}, from nap_minutes(). Keyed to the wake
    date of the main sleep it lands on, so a 3pm nap credits the morning you
    woke short.
    """
    hrv_map = hrv_map or {}
    rhr_map = rhr_map or {}
    nap_min = nap_min or {}

    # Pre-pass: need + asleep_total per night, so the rolling sleep debt can be
    # computed before the scoring loop -- tonight's score is judged against the
    # debt you carried INTO the night, not the debt after tonight is counted.
    meta = []
    for n in nights:
        d = n["end"].normalize()
        prev = strain_map.get(d - pd.Timedelta(days=1), 0.0)
        need = cfg.SLEEP_NEED_MIN + min(
            float(cfg.SLEEP_NEED_HARDDAY_MAX), 3.0 * max(0.0, prev - 10))
        naps = float(nap_min.get(d, 0.0))
        meta.append((d, need, n["asleep"] + naps, naps))

    if not meta:
        return pd.DataFrame()
    debt_vec = _sleep_debt(np.array([m[1] for m in meta]),
                           np.array([m[2] for m in meta]))
    debt_in = np.concatenate([[0.0], debt_vec[:-1]])        # debt entering each night

    rows = []
    bed_hist, wake_hist = [], []
    hrv_hist, rhr_hist, rem_hist, deep_hist = [], [], [], []
    for i, n in enumerate(nights):
        d, need, asleep_total, naps = meta[i]

        bed_tod, wake_tod = _tod_since_6pm(n["start"]), _tod_since_6pm(n["end"])
        timing_dev = None
        if len(bed_hist) >= 3:
            timing_dev = (abs(bed_tod - float(np.mean(bed_hist))) +
                          abs(wake_tod - float(np.mean(wake_hist)))) / 2
        bed_hist = (bed_hist + [bed_tod])[-TIMING_HISTORY:]
        wake_hist = (wake_hist + [wake_tod])[-TIMING_HISTORY:]

        rem_base = float(np.median(rem_hist)) if len(rem_hist) >= 7 else None
        deep_base = float(np.median(deep_hist)) if len(deep_hist) >= 7 else None

        hrv, rhr = hrv_map.get(d), rhr_map.get(d)
        settled, settled_parts = _sleep_settled(hrv, hrv_hist, rhr, rhr_hist)

        # The score's duration divisor: your need, plus a capped fraction of the
        # debt you brought into the night. Caught up (debt ~0) -> == need, so 7h
        # scores clean. A few hours of debt -> ~8-8.5h, so the same 7h drops
        # into the 70s until you either sleep long or pay the debt down.
        score_target = need + min(float(cfg.SLEEP_DEBT_TARGET_CAP),
                                  cfg.SLEEP_DEBT_TARGET_FRAC * float(debt_in[i]))

        score, parts, quality, dur_factor = sleep_score(
            n, score_target, timing_dev, rem_base, deep_base,
            settled, settled_parts)
        perf = min(1.0, asleep_total / max(need, 1.0))

        rows.append({"date": d, "start": n["start"], "end": n["end"],
                     "asleep": n["asleep"], "in_bed": n["in_bed"],
                     "nap_min": naps, "asleep_total": asleep_total,
                     "efficiency": n["asleep"] / max(n["in_bed"], 1.0),
                     "need": need, "score_target": round(score_target),
                     "perf": perf, "debt": float(debt_vec[i]),
                     "score": score, "parts": parts,
                     "quality": quality, "dur_factor": dur_factor,
                     **{k.lower(): n["stage_min"].get(k, 0) for k in STAGES}})

        # Histories updated AFTER scoring, so tonight is graded against the
        # nights before it, never against itself.
        if _isnum(hrv):
            hrv_hist = (hrv_hist + [float(hrv)])[-cfg.BASELINE_DAYS:]
        if _isnum(rhr):
            rhr_hist = (rhr_hist + [float(rhr)])[-cfg.BASELINE_DAYS:]
        rem_hist = (rem_hist + [n["stage_min"].get("REM", 0)])[-cfg.BASELINE_DAYS:]
        deep_hist = (deep_hist + [n["stage_min"].get("DEEP", 0)])[-cfg.BASELINE_DAYS:]

    return pd.DataFrame(rows)


# ------------------------------------------------------------ recovery
def _z(x, hist):
    """NaN-safe z-score. Returns 0 (neutral) until a baseline exists."""
    hist = [h for h in hist if _isnum(h)]
    if not _isnum(x) or len(hist) < 5:
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


def strain_ceiling(rec, load_state=0):
    """A single strain number to stay UNDER today, scaled to recovery -- not a
    band to fill. Undershooting on a low-recovery day is the correct call, not
    a miss, so there is no lower bound: on a hungover morning the honest
    message is "take it easy", not "you have 8 more points to earn".

        rec 100 -> ~15.0     rec 50 -> ~10.5     rec 25 -> ~8.3

    `load_state` (0/1/2 from recovery_load) hard-caps it: recovery uses only
    HRV/RHR/sleep, so an early illness that shows in skin temp + breathing but
    not yet in HRV would leave the ceiling high. An elevated/high Recovery Load
    forces it down regardless.
    """
    ceil = 6.0 + 0.09 * float(rec)
    cap = cfg.STRAIN_CEILING_LOAD_CAP.get(int(load_state))
    if cap is not None:
        ceil = min(ceil, cap)
    return round(ceil, 1)


# ------------------------------------------------------------ recovery load
def _mad_sigma(vals):
    """1.4826 x median-absolute-deviation -- a robust sigma that pairs with a
    median baseline. None with < 5 clean points or a degenerate spread."""
    v = [x for x in vals if _isnum(x)]
    if len(v) < 5:
        return None
    med = float(np.median(v))
    mad = float(np.median([abs(x - med) for x in v]))
    return 1.4826 * mad if mad > 1e-9 else None


# Recovery Load weights and per-marker "min move to count" floors. HRV weighs
# most (the specific autonomic-stress marker), breathing least (wrist RR is the
# least accurate of the four). See METRICS.md.
_RL_W = {"hrv": 0.35, "rhr": 0.25, "temp": 0.25, "rr": 0.15}
_RL_FLOOR = {"hrv": 3.0, "hrv_deep": 5.0, "rhr": 2.0, "temp": 0.15, "rr": 0.5}


def recovery_load(hrv, hrv_hist, rhr, rhr_hist, rr, rr_hist,
                  temp_delta=None, temp_sd=None,
                  hrv_deep=None, hrv_deep_hist=None):
    """One overnight number: is your body working harder than usual to recover?

    Each of the 4 autonomic markers vs YOUR OWN 30-night normal, counting only
    moves in the bad direction (HRV down, RHR/RR/skin-temp up), floored so a
    tiny wobble is nothing and clamped to 3 so one wild night can't pin it.
    Weighted mean over the markers that have data; then max() with the skin-temp
    deviation / 2, so a ~2-sigma temperature rise (fever) reaches the top band
    on its own -- no other marker gets that, a lone HRV or breathing wobble is
    just noise.

    HRV marker: the deep-sleep RMSSD (`hrv_deep`, measured in a controlled
    state -- probed as the sharper alcohol signal, ~-44% vs the average's -23%
    on drinking nights) is used when it has a baseline, with a wider floor since
    its sober-night spread runs ~1.5x the average's. Falls back to the all-night
    average (`hrv`) otherwise.

    Skin temp uses Google's own baseline+SD (`temp_delta` = nightly - baseline,
    `temp_sd` = relativeNightlyStddev30dCelsius); the other markers use a
    trailing median + MAD computed here from *_hist.

    Returns ~0..3, or None if no marker has enough history. Bands live in the
    reader: < 0.5 settled, < 1.0 elevated, else high.
    """
    d = {}

    def bad(val, hist, floor, invert=False):
        if not _isnum(val):
            return None
        sigma = _mad_sigma(hist)
        if sigma is None:
            return None
        base = float(np.median([h for h in hist if _isnum(h)]))
        if abs(val - base) < floor:
            return 0.0
        z = (base - val) / sigma if invert else (val - base) / sigma
        return float(np.clip(z, 0.0, 3.0))

    dh = bad(hrv_deep, hrv_deep_hist or [], _RL_FLOOR["hrv_deep"], invert=True)
    if dh is None:                          # no deep-RMSSD baseline yet
        dh = bad(hrv, hrv_hist, _RL_FLOOR["hrv"], invert=True)
    dr = bad(rhr, rhr_hist, _RL_FLOOR["rhr"])
    drr = bad(rr, rr_hist, _RL_FLOOR["rr"])
    if _isnum(temp_delta) and _isnum(temp_sd) and temp_sd > 1e-9:
        dt = 0.0 if abs(temp_delta) < _RL_FLOOR["temp"] \
            else float(np.clip(temp_delta / temp_sd, 0.0, 3.0))
    else:
        dt = None

    for k, v in (("hrv", dh), ("rhr", dr), ("temp", dt), ("rr", drr)):
        if v is not None:
            d[k] = v
    if not d:
        return None

    # Weights sum to 1, so a marker that is present-but-normal (v == 0)
    # contributes nothing -- the same as a missing one. That is deliberate: a
    # skin-temp reading the watch didn't get is not evidence of anything, so it
    # should not dilute a real HRV signal, nor should a normal one.
    weighted = sum(_RL_W[k] * v for k, v in d.items())
    # Fever override: skin temp is specific and reliable enough (Google's own
    # per-person baseline + SD) that a ~2-sigma rise alone means "high". No
    # other marker gets this -- a lone HRV drop or, especially, a lone wrist-RR
    # wobble is just noise, and on real data an unrestricted version of this
    # flagged perfectly ordinary nights off a +1 br/min breathing blip.
    return round(max(weighted, d.get("temp", 0.0) / 2.0), 3)


def load_state(body_load):
    """< 0.5 settled (0), < 1.0 elevated (1), else high (2). None -> None."""
    if not _isnum(body_load):
        return None
    return 0 if body_load < 0.5 else 1 if body_load < 1.0 else 2


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
