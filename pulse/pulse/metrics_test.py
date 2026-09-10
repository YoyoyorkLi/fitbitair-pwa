"""Formula tests for metrics.py -- run with `python -m pulse test`.

These pin the *behaviour* the rebuild was for, not exact digits:

  - a short night cannot score high however clean it was (length multiplier)
  - a drinking night, which the old score rated ~76, now lands well below it
    (REM down + body not settled + short)
  - strain ignores sleep -- a hungover morning in bed is not training load
  - sleep debt rolls: it reaches zero when you sleep at need, and is capped

Constants live in config.py and METRICS.md; if you retune them, update the
loose bounds here to match the new intent, not the other way round.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd

from . import config as cfg
from . import metrics as mx

_T0 = pd.Timestamp("2026-09-05 23:30:00")


def _night(asleep, *, rem, deep, awake_segs=(), start=_T0, latency=8.0,
           light=None):
    """Build one normalize_sleep()-shaped night.

    awake_segs: list of wake-block lengths in minutes, placed after sleep onset.
    """
    light = asleep - rem - deep if light is None else light
    stages, t = [], start
    order = [("LIGHT", 20), ("DEEP", deep), ("LIGHT", max(light - 20, 1)),
             ("REM", rem)]
    for typ, mins in order:
        if mins <= 0:
            continue
        stages.append({"type": typ, "start": t, "end": t + pd.Timedelta(minutes=mins),
                       "mins": float(mins)})
        t = t + pd.Timedelta(minutes=mins)
    for w in awake_segs:
        stages.append({"type": "AWAKE", "start": t,
                       "end": t + pd.Timedelta(minutes=w), "mins": float(w)})
        t = t + pd.Timedelta(minutes=w)
    awake = float(sum(awake_segs))
    in_bed = asleep + awake + 8
    return {
        "start": start, "end": start + pd.Timedelta(minutes=in_bed),
        "stages": stages, "asleep": float(asleep), "in_bed": float(in_bed),
        "awake": awake, "latency": latency,
        "stage_min": {"REM": float(rem), "DEEP": float(deep),
                      "LIGHT": float(light), "AWAKE": awake},
    }


def _hr_day(day="2026-09-05", awake_bpm=70, sleep_bpm=70, sleep=("00:00", "07:00")):
    """A civil day of 1-min heart-rate samples: flat `awake_bpm`, except the
    sleep window at `sleep_bpm`."""
    lo = pd.Timestamp(day)
    rows = []
    s0 = pd.Timestamp(f"{day} {sleep[0]}")
    s1 = pd.Timestamp(f"{day} {sleep[1]}")
    for m in range(0, 24 * 60):
        t = lo + pd.Timedelta(minutes=m)
        rows.append((t, sleep_bpm if s0 <= t < s1 else awake_bpm))
    return pd.DataFrame(rows, columns=["ts", "bpm"]), (s0, s1)


# --------------------------------------------------------------------------- #
CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def short_night_cannot_score_high():
    """A flawless 5h night against a 7h need is capped near 0.71 of quality."""
    hrv_map = {pd.Timestamp("2026-09-05"): 70.0}
    rhr_map = {pd.Timestamp("2026-09-05"): 52.0}
    clean_full = _night(470, rem=105, deep=95, awake_segs=[1, 1])
    clean_short = _night(300, rem=68, deep=60, awake_segs=[1, 1])
    full = mx.sleep_score(clean_full, cfg.SLEEP_NEED_MIN)
    short = mx.sleep_score(clean_short, cfg.SLEEP_NEED_MIN)
    assert full[0] >= 85, f"clean full night should score high, got {full[0]}"
    assert short[0] <= 72, f"5h night must be capped, got {short[0]}"
    assert short[3] == round(300 / cfg.SLEEP_NEED_MIN, 3), short[3]
    # a 7h night is NOT docked for length
    seven = mx.sleep_score(_night(cfg.SLEEP_NEED_MIN, rem=98, deep=88, awake_segs=[1]),
                           cfg.SLEEP_NEED_MIN)
    assert seven[3] == 1.0, f"7h == need, multiplier should be 1.0, got {seven[3]}"


@case
def debt_lowers_a_flat_seven_hour_night():
    """A clean 7h night scores ~90 when caught up, but noticeably lower when
    you go in carrying sleep debt -- the score's target rises toward 8h."""
    base = pd.Timestamp("2026-08-20 23:15:00")
    clean7 = lambda s: _night(cfg.SLEEP_NEED_MIN, rem=98, deep=88, awake_segs=[1], start=s)

    caught_up = [clean7(base + pd.Timedelta(days=i)) for i in range(12)]
    sf_ok = mx.sleep_series(caught_up, {}, None, None, None)
    assert sf_ok["debt"].iloc[-1] < 30, sf_ok["debt"].iloc[-1]
    assert sf_ok["score"].iloc[-1] >= 85, sf_ok["score"].iloc[-1]
    assert sf_ok["score_target"].iloc[-1] <= cfg.SLEEP_NEED_MIN + 15

    # a rough week: 5.5h nightly, then the SAME clean 7h night on top
    rough = [_night(330, rem=70, deep=70, awake_segs=[1], start=base + pd.Timedelta(days=i))
             for i in range(11)]
    rough.append(clean7(base + pd.Timedelta(days=11)))
    sf_tired = mx.sleep_series(rough, {}, None, None, None)
    assert sf_tired["debt"].iloc[-2] > 120, sf_tired["debt"].iloc[-2]
    assert sf_tired["score_target"].iloc[-1] > cfg.SLEEP_NEED_MIN + 40
    assert sf_tired["score"].iloc[-1] <= sf_ok["score"].iloc[-1] - 8, \
        (sf_tired["score"].iloc[-1], sf_ok["score"].iloc[-1])
    # ...and sleeping 8h+ that same tired night claws most of it back
    rough8 = rough[:-1] + [_night(500, rem=115, deep=95, awake_segs=[1],
                                  start=base + pd.Timedelta(days=11))]
    sf_long = mx.sleep_series(rough8, {}, None, None, None)
    assert sf_long["score"].iloc[-1] >= sf_tired["score"].iloc[-1] + 6


@case
def drinking_night_scores_far_below_seventy_six():
    """The night that motivated the rebuild: ~5h, REM suppressed, body not
    settled. Old additive score ~76; new score should be well under 60."""
    rem_base, deep_base = 100.0, 75.0
    # HRV history flat ~68, then tonight 46 (-1.5 sd-ish); RHR history ~52, tonight 60
    hrv_hist = [68.0, 70.0, 66.0, 69.0, 67.0, 71.0, 68.0]
    rhr_hist = [52.0, 51.0, 53.0, 52.0, 52.0, 51.0, 53.0]
    settled, sparts = mx._sleep_settled(46.0, hrv_hist, 60.0, rhr_hist)
    assert settled is not None and settled < 0.35, settled
    night = _night(305, rem=58, deep=78, awake_segs=[6, 8, 5], latency=6.0)
    score, parts, quality, durf = mx.sleep_score(
        night, cfg.SLEEP_NEED_MIN, timing_dev=15.0,
        rem_base=rem_base, deep_base=deep_base,
        settled=settled, settled_parts=sparts)
    assert score < 60, f"drinking night should be well under 60, got {score}"
    assert score < 45 or quality < 55, (score, quality)
    # deep-sleep inflation must not pay: 78 vs base 75 -> full credit, never a bonus
    assert parts["Deep sleep"][1] <= parts["Deep sleep"][0] + 1e-6


@case
def strain_excludes_sleep():
    """Same elevated heart rate all day: counted awake it is real load; the
    overnight portion must not add to strain."""
    df, (s0, s1) = _hr_day(awake_bpm=78, sleep_bpm=72)   # a hungover-ish day
    ts = df["ts"].to_numpy()
    asleep = (ts >= np.datetime64(s0)) & (ts < np.datetime64(s1))
    strain_all, trimp_all, _ = mx.day_strain(df, 52.0, 190.0, asleep=None)
    strain_wake, trimp_wake, _ = mx.day_strain(df, 52.0, 190.0, asleep=asleep)
    assert strain_wake < strain_all, (strain_wake, strain_all)
    # the ~7h overnight window is roughly a fifth of the day's load, gone
    assert trimp_wake < 0.85 * trimp_all, (trimp_wake, trimp_all)
    # a genuinely sedentary waking day (HR ~60, near rest) stays low
    rdf, (rs0, rs1) = _hr_day(awake_bpm=60, sleep_bpm=54)
    rts = rdf["ts"].to_numpy()
    rasleep = (rts >= np.datetime64(rs0)) & (rts < np.datetime64(rs1))
    rest, _, _ = mx.day_strain(rdf, 52.0, 190.0, asleep=rasleep)
    assert rest < 7.0, f"sedentary day strain should be low, got {rest}"


@case
def strain_zone_minutes_still_span_the_day():
    df, (s0, s1) = _hr_day(awake_bpm=95, sleep_bpm=60)
    ts = df["ts"].to_numpy()
    asleep = (ts >= np.datetime64(s0)) & (ts < np.datetime64(s1))
    _, _, zmin = mx.day_strain(df, 52.0, 190.0, asleep=asleep)
    assert 1400 <= sum(zmin) <= 1440, sum(zmin)   # time-in-zone is still 24h


@case
def sleep_debt_rolls_and_caps():
    need = np.full(30, float(cfg.SLEEP_NEED_MIN))
    # 5 short nights (-120 each), then sleep exactly at need
    asleep = need.copy()
    asleep[:5] = cfg.SLEEP_NEED_MIN - 120
    debt = mx._sleep_debt(need, asleep)
    assert debt[4] > 200, f"debt should build over the short stretch, got {debt[4]}"
    assert debt[-1] == 0.0, f"debt must reach zero once at need, got {debt[-1]}"
    assert (debt <= cfg.SLEEP_DEBT_CAP_MIN + 1e-9).all()
    # chronic 2h under -> pinned near the cap, never above it
    chronic = mx._sleep_debt(need, need - 120)
    assert chronic[-1] == cfg.SLEEP_DEBT_CAP_MIN, chronic[-1]


@case
def strain_ceiling_scales_with_recovery():
    assert mx.strain_ceiling(25) < mx.strain_ceiling(60) < mx.strain_ceiling(95)
    assert 7 <= mx.strain_ceiling(30) <= 10
    assert 13 <= mx.strain_ceiling(100) <= 17


@case
def naps_credit_debt_not_score():
    """A nap cuts sleep debt and lifts recovery's perf term, but does not
    touch the main night's sleep score."""
    base = pd.Timestamp("2026-08-20 23:15:00")
    nights_all, mains = [], []
    for i in range(16):
        start = base + pd.Timedelta(days=i)
        n = _night(395, rem=95, deep=75, awake_segs=[1], start=start)  # ~25 min short
        nights_all.append(n)
        mains.append(n)
        if i == 10:                                   # a 100-min nap the afternoon
            nap_start = n["end"].normalize() + pd.Timedelta(hours=14)   # of the wake day
            nights_all.append(_night(100, rem=8, deep=20, awake_segs=[], start=nap_start))

    naps = mx.nap_minutes(nights_all, mains)
    nap_day = mains[10]["end"].normalize()
    assert naps.get(nap_day) == 100.0, naps

    no_nap = mx.sleep_series(mains, {}, None, None, None)
    with_nap = mx.sleep_series(mains, {}, None, None, naps)
    # the nap night's score is unchanged (main sleep identical)...
    assert no_nap["score"].iloc[10] == with_nap["score"].iloc[10]
    # ...but debt on that night and the days after it is lower
    assert with_nap["debt"].iloc[10] < no_nap["debt"].iloc[10] - 30
    assert with_nap["debt"].iloc[13] < no_nap["debt"].iloc[13]
    # and perf (the recovery input) rose
    assert with_nap["perf"].iloc[10] > no_nap["perf"].iloc[10]


@case
def sleep_series_end_to_end():
    nights = []
    base = pd.Timestamp("2026-08-20 23:15:00")
    for i in range(20):
        start = base + pd.Timedelta(days=i)
        drinking = i in (7, 14)
        nights.append(_night(
            300 if drinking else 455,
            rem=55 if drinking else 100,
            deep=80 if drinking else 78,
            awake_segs=[6, 7] if drinking else [1],
            start=start))
    strain_map = {}
    hrv_map, rhr_map = {}, {}
    for i, n in enumerate(nights):
        d = n["end"].normalize()
        hrv_map[d] = 45.0 if i in (7, 14) else 68.0 + (i % 3)
        rhr_map[d] = 60.0 if i in (7, 14) else 52.0
    sf = mx.sleep_series(nights, strain_map, hrv_map, rhr_map)
    assert len(sf) == 20
    assert (sf["need"] == cfg.SLEEP_NEED_MIN).all(), "flat need with no hard days"
    assert sf["debt"].iloc[-1] >= 0
    drink_scores = sf["score"].iloc[[7, 14]].to_numpy()
    calm_scores = sf["score"].drop(index=[7, 14]).to_numpy()
    assert drink_scores.max() < calm_scores.mean() - 15, (drink_scores, calm_scores.mean())


def run():
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  ok    {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {e}")
        except Exception as e:                       # noqa: BLE001
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n  {len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(run())
