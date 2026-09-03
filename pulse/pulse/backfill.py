"""Historical backfill, done gently.

    python -m pulse backfill [days]

`pulse sync 40` fetches the whole window as one request per data type, buffers
every point in memory, then runs one long, uninterruptible Python loop over
all of it -- for 40 days of ~2-second heart-rate that's on the order of a
million and a half points processed back to back, which is exactly what
pegged a CPU core for minutes straight the one time this got run that way.

This does the same fetch, but one civil day at a time, oldest first, with a
short pause after each. Same total network traffic, same end state in the
cache -- the difference is entirely in the shape of the work: short bursts
with real gaps, instead of one sustained burn. Safe to Ctrl+C at any point;
every day is fetched, saved and committed before the next one starts, so
nothing in flight is lost, and a second run skips whatever the first one
already finished.
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone

from . import config as cfg
from . import ingest
from . import metrics as mx

UTC = timezone.utc
PAUSE_SECONDS = 1.5  # between days -- the actual "give the CPU a break" part


def _local_midnight(day_offset: int, tz):
    """Start of the civil day `day_offset` days before today, in `tz`.

    Anchored to LOCAL midnight rather than UTC midnight so every day gets the
    same civil-day correction sync() otherwise applies once, as a single pad,
    across its whole window. Per-day fetching needs it applied per day.
    """
    now_local = datetime.now(tz) if tz else datetime.now(UTC)
    start_of_today = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_of_today - timedelta(days=day_offset)


def _already_cached(con, day_str: str) -> bool:
    """Cheap, approximate 'did we already do this day' check.

    daily-resting-heart-rate is one row per day -- checking for it is an
    indexed point lookup, not a scan. If Google genuinely has no resting-HR
    for a day (a real gap), that day gets re-fetched on every run; harmless,
    and printed clearly rather than silently repeated.
    """
    row = con.execute(
        "SELECT 1 FROM raw WHERE data_type = 'daily-resting-heart-rate' AND pit = ? LIMIT 1",
        (day_str,),
    ).fetchone()
    return row is not None


def backfill(days: int, con=None, pause: float = PAUSE_SECONDS, out=sys.stdout):
    """Fetch `days` of history, oldest first, one civil day per iteration."""
    own = con is None
    con = con if con is not None else ingest.db()
    tz = mx._tz()
    token = ingest.access_token()

    print(f"backfilling {days} days, one at a time -- Ctrl+C is safe anywhere\n", file=out)

    done = skipped = 0
    try:
        for day_offset in range(days, 0, -1):           # oldest -> newest
            start = _local_midnight(day_offset, tz)
            end = start + timedelta(days=1)
            day_str = start.strftime("%Y-%m-%d")

            if _already_cached(con, day_str):
                skipped += 1
                print(f"  {day_str}  already have it", file=out)
                continue

            counts = []
            for dt in cfg.DATA_TYPES:
                pts = ingest.fetch(dt, start, end, token)
                n = ingest.save(dt, pts, con)
                counts.append(f"{dt}={n}")
            done += 1
            print(f"  {day_str}  " + "  ".join(counts), file=out)

            if day_offset > 1:            # no point pausing after the last one
                time.sleep(pause)
    except KeyboardInterrupt:
        print(f"\nstopped -- {done} day(s) fetched, {skipped} already cached, "
              f"{day_offset - 1} remaining. Re-run to pick up where this left off.",
              file=out)
        raise
    finally:
        if own:
            con.close()

    print(f"\ndone -- {done} day(s) fetched, {skipped} already cached.", file=out)
    return done, skipped
