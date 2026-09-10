"""Central config. Edit the USER block; leave the rest unless you know why."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"


def _load_env(path=ENV_FILE):
    """Read a .env file into os.environ without adding a dependency.

    Real environment variables always win, so a launchd job or an explicit
    `export` can still override the file. Values may be quoted; blank lines and
    # comments are ignored.
    """
    try:
        text = path.read_text()
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        if k.startswith("export "):
            k = k[7:].strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_env()
DB_PATH = ROOT / "pulse.db"
DEMO_DB_PATH = ROOT / "pulse-demo.db"   # demo never touches your real cache
TOKEN_FILE = ROOT / ".token.json"

# ---- USER --------------------------------------------------------------
AGE = int(os.getenv("PULSE_AGE", "23"))
SEX = os.getenv("PULSE_SEX", "M")        # "M"/"F" -> TRIMP weighting constant
HR_MAX = None                            # None -> Tanaka estimate from age
BASELINE_DAYS = 30                       # rolling window for HRV/RHR/stage norms
STRAIN_SCALE = 21                        # 21 = WHOOP axis; 100 = Bevel percent

# ---- sleep need / goal / debt ----------------------------------------------
# NEED is your biological baseline -- what keeps you non-impaired, and the
# number the sleep score divides by. Set it to what you actually run well on,
# not the population 8h: chronic short sleep makes you *feel* adapted while
# staying measurably impaired, but for a personal tool "I feel good on 7" is a
# reasonable call, and anchoring NEED an hour too high makes every score look
# worse than the night was and pins sleep debt at its ceiling forever.
#
# GOAL is aspirational -- a target line on the charts and a "nights hit" count.
# It never touches the score or the debt.
SLEEP_NEED_MIN = 420                     # 7h -- personal baseline (was 8h)
SLEEP_GOAL_MIN = 480                     # 8h -- display-only stretch target
SLEEP_NEED_HARDDAY_MAX = 30             # up to +30 min the night after a hard day

# Sleep debt: a rolling shortfall over the last N nights vs NEED, recent nights
# weighted heaviest, capped. Matches how sleep debt actually behaves (RISE,
# CSR literature): it accrues over ~2 weeks and fades over ~2 weeks, and it can
# reach zero -- so it means something -- when you are consistently at NEED.
# The old leaky-bucket accumulator never emptied and pinned near its 10h cap.
SLEEP_DEBT_WINDOW = 14                   # nights in the rolling window
SLEEP_DEBT_CAP_MIN = 300                 # 5h -- RISE's "manageable" ceiling
SLEEP_DEBT_SURPLUS_CREDIT = 0.5          # a night over NEED pays down at half rate

# The sleep SCORE's duration term is judged against NEED plus a slice of the
# debt you carried INTO the night (the debt vs the score are otherwise
# separate -- this is the one place debt touches the score). So a flat 7h
# night scores a clean 90 only when you are caught up; carry a few hours of
# debt and the same 7h is measured against ~8-8.5h and lands in the 70s.
# Bounded, so it cannot run away the way the old debt-in-NEED formula did:
# the new debt is capped at 300, and this adds at most +90.
SLEEP_DEBT_TARGET_FRAC = 0.35
SLEEP_DEBT_TARGET_CAP  = 90              # minutes; +1.5h over NEED at most

# ---- recovery load -> strain ceiling --------------------------------------
# An elevated / high overnight Recovery Load (recovery_load()) hard-caps the
# strain ceiling here, because `recovery` itself only reads HRV/RHR/sleep --
# an early illness visible in skin temp + breathing but not yet in HRV would
# otherwise leave the ceiling high. Keyed by load_state 1 (elevated) / 2 (high).
STRAIN_CEILING_LOAD_CAP = {1: 11.0, 2: 8.0}

# The API returns every point as a UTC instant. Without a zone, a Chicago
# evening (UTC-5) lands on the following UTC day and every evening workout is
# filed under tomorrow. None = auto-detect from the OS.
TIMEZONE = os.getenv("PULSE_TZ") or None

# Sleep sessions shorter than this are naps, not the main sleep.
MIN_MAIN_SLEEP_MIN = 180

# ---- Google Health API -------------------------------------------------
API_ROOT = "https://health.googleapis.com/v4"
CLIENT_ID = os.getenv("GH_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("GH_CLIENT_SECRET", "")

# Desktop-app clients accept any loopback port with no console config. If you
# made a "Web application" client, this must match an Authorized redirect URI
# character for character.
REDIRECT_URI = os.getenv("PULSE_REDIRECT_URI", "http://localhost:8765/callback")

SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
]

# Google caps a single query window: 14 days for heart-rate and other
# high-volume types, 90 days for the rest. Stay well under both. 45 keeps the
# catch-up history window (CATCHUP_HIST_DAYS + 1) to a single request per type.
MAX_WINDOW_DAYS = {"heart-rate": 1}      # 1/day also keeps pages under the 10k cap
DEFAULT_WINDOW_DAYS = 45

# Catch-up sync (ingest.sync() with no day count -- the hourly CI path). The
# runner keeps no cache between runs, so every run is a fresh pull. heart-rate
# is ~17k points/day and a finished day never changes, so pull only a few days
# of it; but pull a full baseline window of the cheap daily/sleep types so
# push can still compute a 30-day trailing median. build_rows() is driven by
# the heart-rate days, so this also scopes what gets written to Supabase.
#
# HR at 3 covers today + the two prior nights -- enough for a night whose sleep
# session syncs to Google hours after you wake. Each day is one request, so
# this is the main lever on wall time.
CATCHUP_HR_DAYS = 3
CATCHUP_HIST_DAYS = 35

# Concurrent Google requests. The catch-up set is ~15 requests, a `push 60`
# repair ~150; 12 workers clears either in a couple of rounds and stays under
# the 300 req/min per-user ceiling (fetch() also backs off on a 429).
SYNC_WORKERS = 12

# Endpoint names are kebab-case; filter parameters are snake_case. The record
# kind determines the filter field path -- getting this wrong is a 400.
#   Sample   -> {type}.sample_time.physical_time
#   Interval -> {type}.interval.start_time
#   Session  -> {type}.interval.end_time      (note: END, not start)
#   Daily    -> {type}.date
#
# exercise is the one session type that breaks its own row above: every other
# filter field on it (interval.start_time, interval.end_time, civil_end_time)
# 400s as INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER. Only civil_start_time --
# a plain date, not a timestamp -- works. Found by trying all four against a
# live account on 2026-09-05, not from documentation. ingest.fetch() special-
# cases any field containing "civil_" to format the query as a date.
DATA_TYPES = {
    "heart-rate":                   ("sample",   "heart_rate.sample_time.physical_time"),
    "sleep":                        ("session",  "sleep.interval.end_time"),
    "steps":                        ("interval", "steps.interval.start_time"),
    "exercise":                     ("session",  "exercise.interval.civil_start_time"),
    "daily-resting-heart-rate":     ("daily",    "daily_resting_heart_rate.date"),
    "daily-heart-rate-variability": ("daily",    "daily_heart_rate_variability.date"),
    "daily-respiratory-rate":       ("daily",    "daily_respiratory_rate.date"),
    "daily-oxygen-saturation":      ("daily",    "daily_oxygen_saturation.date"),
    # Overnight skin-temperature variation from baseline (what the Fitbit app's
    # "Skin Temperature" screen shows) -- a Daily type, `list`-queryable, same
    # class as the four above. It is the temperature signal illness-detection
    # research leans on (Oura TemPredict). Whether YOUR account returns it, and
    # the real response field name, are a `pulse doctor` away -- the wire name
    # below is a documented guess and _num()'s "temp"/"celsius" fallback (see
    # metrics.py) covers it until doctor confirms.
    "daily-sleep-temperature-derivations": ("daily", "daily_sleep_temperature_derivations.date"),
}

# Documented field names per Daily type. Treated as a *hint*: the parser falls
# back to whatever single numeric field is present, because v4 is pre-GA.
# Verified against a live Fitbit Air account on 2026-09-03 with `pulse doctor`.
# Two of the four documented names do not exist on the wire; the fallback in
# _num() happened to land on the right field by matching "rate"/"percent", but
# only because of dict ordering. Naming them explicitly removes the luck.
#
#   Only the ONE value field per type is named here -- normalize_daily() reads a
#   single number. Types that carry more (the HRV payload also ships
#   deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds and
#   nonRemHeartRateBeatsPerMinute; oxygen-saturation ships lowerBoundPercentage
#   and standardDeviationPercentage) are pulled straight off the raw points in
#   push.build_rows(), the same way skin temperature is.
DAILY_FIELDS = {
    "daily-resting-heart-rate":     ("dailyRestingHeartRate", "beatsPerMinute"),
    "daily-heart-rate-variability": ("dailyHeartRateVariability",
                                     "averageHeartRateVariabilityMilliseconds"),
    "daily-respiratory-rate":       ("dailyRespiratoryRate", "breathsPerMinute"),
    "daily-oxygen-saturation":      ("dailyOxygenSaturation", "averagePercentage"),
}

# ---- Palette -----------------------------------------------------------
C = {
    "bg": "#0B0E14", "panel": "#141924", "panel2": "#1C2230", "grid": "#252C3B",
    "text": "#E6EAF2", "muted": "#7E8AA3",
    "deep": "#3B4EE0", "light": "#5B8DEF", "rem": "#9B5BEF", "awake": "#F2A93B",
    "strain": "#2FD4C6", "good": "#3FD68A", "warn": "#F2545B", "accent": "#5B8DEF",
    "zone": ["#3A4358", "#4C7BD6", "#3FD68A", "#F2A93B", "#F2545B"],
}
