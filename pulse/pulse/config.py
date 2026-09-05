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
OUT_HTML = ROOT / "dashboard.html"
TOKEN_FILE = ROOT / ".token.json"

# ---- USER --------------------------------------------------------------
AGE = int(os.getenv("PULSE_AGE", "23"))
SEX = os.getenv("PULSE_SEX", "M")        # "M"/"F" -> TRIMP weighting constant
HR_MAX = None                            # None -> Tanaka estimate from age
SLEEP_NEED_BASE_MIN = 480                # 8h baseline need
BASELINE_DAYS = 30                       # rolling window for HRV/RHR/stage norms
STRAIN_SCALE = 21                        # 21 = WHOOP axis; 100 = Bevel percent

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
# high-volume types, 90 days for the rest. Stay well under both.
MAX_WINDOW_DAYS = {"heart-rate": 1}      # 1/day also keeps pages under the 10k cap
DEFAULT_WINDOW_DAYS = 30

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
}

# Documented field names per Daily type. Treated as a *hint*: the parser falls
# back to whatever single numeric field is present, because v4 is pre-GA.
# Verified against a live Fitbit Air account on 2026-09-03 with `pulse doctor`.
# Two of the four documented names do not exist on the wire; the fallback in
# _num() happened to land on the right field by matching "rate"/"percent", but
# only because of dict ordering. Naming them explicitly removes the luck.
#
#   HRV also ships deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds
#   (true RMSSD, scoped to deep sleep) alongside the average, plus `entropy`.
#   The deep-sleep RMSSD is plausibly the better alcohol marker -- measured in a
#   controlled state -- and is worth capturing as a second series later.
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
