"""The numeric pipeline: raw cache -> per-night strain / sleep / recovery.

Formerly also rendered a standalone dashboard.html; that front end is gone
(the PWA in public/ is the only one now). compute() stays because push.py
turns its output into the Supabase rows the PWA reads.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as cfg
from . import metrics as mx
from .ingest import db, load


def compute(con=None):
    """Everything numeric. Importable on its own for a notebook."""
    own = con is None
    con = con if con is not None else db()
    try:
        nights_all = mx.normalize_sleep(load("sleep", con))
        nights = mx.main_sleeps(nights_all)
        dailies = {}
        for dt, (key, field) in cfg.DAILY_FIELDS.items():
            dailies[dt] = mx.normalize_daily(load(dt, con), key, field)
        hr_all = mx.normalize_hr(load("heart-rate", con))
    finally:
        if own:
            con.close()

    hrv = dailies["daily-heart-rate-variability"]
    rhr = dailies["daily-resting-heart-rate"]
    rr = dailies["daily-respiratory-rate"]

    if hr_all.empty:
        raise SystemExit(
            "No heart-rate data cached.\n"
            "  Run:  python -m pulse doctor    (see what your account returns)\n"
            "  then: python -m pulse sync 7")
    if not nights:
        raise SystemExit(
            "No usable sleep sessions cached.\n"
            "  Sleep needs stage data (type STAGES). If your Air has only synced\n"
            "  CLASSIC sleep, wear it overnight and sync again.\n"
            "  Check with:  python -m pulse doctor")

    hr_all = hr_all.copy()
    hr_all["day"] = hr_all["ts"].dt.normalize()
    hrmax = mx.hr_max()
    # Take the value column from cfg.DAILY_FIELDS rather than repeating the wire
    # name here: normalize_daily() names it from the same source, so a field
    # rename in config stays a one-line change instead of a KeyError at render.
    _rhr_f = cfg.DAILY_FIELDS["daily-resting-heart-rate"][1]
    _hrv_f = cfg.DAILY_FIELDS["daily-heart-rate-variability"][1]
    rhr_map = dict(zip(rhr["date"], rhr[_rhr_f])) if not rhr.empty else {}
    hrv_map = dict(zip(hrv["date"], hrv[_hrv_f])) if not hrv.empty else {}

    # Fall back to the observed sleeping minimum when the API has not produced a
    # daily RHR yet, so zones and strain still work on day one.
    fallback_rhr = float(np.percentile(hr_all["bpm"], 5))

    # Sleep windows (main sleeps AND naps) excluded from strain: overnight
    # heart rate is recovery cost, not training load. Naps count here too --
    # a nap is still not exertion.
    sleep_iv = [(np.datetime64(pd.Timestamp(n["start"])),
                 np.datetime64(pd.Timestamp(n["end"]))) for n in nights_all]

    rows = []
    for day, g in hr_all.groupby("day"):
        base = rhr_map.get(day, fallback_rhr)
        ts = g["ts"].to_numpy()
        asleep = np.zeros(len(g), dtype=bool)
        for s0, e0 in sleep_iv:
            asleep |= (ts >= s0) & (ts < e0)
        s, load_, zmin = mx.day_strain(g, base, hrmax, asleep)
        rows.append({"date": day, "strain": s, "load": load_, "rhr_used": base,
                     "n": len(g), **{f"z{i+1}": zmin[i] for i in range(5)}})
    strain_df = pd.DataFrame(rows).sort_values("date").reset_index(drop=True)

    # Drop a truncated leading day. The sync window starts at a UTC instant but
    # days are bucketed in local time, so the oldest local day is usually a
    # few hours long and would plot as a fake rest day. Never drop the newest
    # day: that one is genuinely today, and is labelled "in progress".
    if len(strain_df) >= 3:
        med = strain_df["n"].median()
        while len(strain_df) >= 3 and strain_df.iloc[0]["n"] < 0.4 * med:
            cut = strain_df.iloc[0]["date"]
            strain_df = strain_df.iloc[1:].reset_index(drop=True)
            hr_all = hr_all[hr_all["day"] > cut]
    strain_df = strain_df.drop(columns=["n"])

    naps = mx.nap_minutes(nights_all, nights)
    sf = mx.sleep_series(nights, dict(zip(strain_df["date"], strain_df["strain"])),
                         hrv_map, rhr_map, naps)

    recs = []
    for i, r in sf.iterrows():
        hist = sf.iloc[max(0, i - cfg.BASELINE_DAYS):i]["date"]
        recs.append(mx.recovery(
            hrv_map.get(r["date"], np.nan),
            [hrv_map.get(x) for x in hist if hrv_map.get(x) is not None],
            rhr_map.get(r["date"], np.nan),
            [rhr_map.get(x) for x in hist if rhr_map.get(x) is not None],
            r["perf"]))
    sf["recovery"] = recs

    m = strain_df.merge(sf.drop(columns=["parts"]), on="date", how="left")
    m["recovery"] = m["recovery"].fillna(50)
    m["target"] = m["recovery"].apply(mx.strain_ceiling)
    return {"m": m, "sf": sf, "nights": nights, "nights_all": nights_all,
            "hr": hr_all, "hrmax": hrmax, "rhr": rhr, "hrv": hrv, "rr": rr,
            "rhr_map": rhr_map, "hrv_map": hrv_map, "fallback_rhr": fallback_rhr}
