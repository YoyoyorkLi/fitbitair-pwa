"""Assemble metrics + SVG into one self-contained, mobile-first HTML file."""
from __future__ import annotations

import html as _html

import numpy as np
import pandas as pd

from . import charts as ch
from . import config as cfg
from . import metrics as mx
from .config import C
from .ingest import db, load

CSS = """
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{background:%(bg)s}
body{background:%(bg)s;color:%(text)s;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
 padding:14px 12px 48px;max-width:840px;margin:0 auto;-webkit-font-smoothing:antialiased}
header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;gap:10px}
h1{font-size:19px;font-weight:700;letter-spacing:-.3px}
.sub{font-size:11.5px;color:%(muted)s;text-align:right}
.card{background:%(panel)s;border:1px solid %(grid)s;border-radius:16px;padding:14px;margin-bottom:12px}
.card h2{font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;
 color:%(muted)s;margin-bottom:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.kpi3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.kpi3 .card{margin-bottom:0;padding:12px 6px 10px;display:flex;flex-direction:column;
 justify-content:space-between}
.kpilab{text-align:center;margin-top:2px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
.stat{background:%(panel2)s;border-radius:11px;padding:9px 8px;text-align:center}
.stat .v{font-size:16px;font-weight:700;line-height:1.25}
.stat .k{font-size:9px;color:%(muted)s;text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
.chart{width:100%%;height:auto;display:block;overflow:visible;touch-action:pan-y}
.note{font-size:11px;color:%(muted)s;margin-top:9px;line-height:1.55}
.note code{background:%(panel2)s;padding:1px 4px;border-radius:3px;font-size:10.5px}
.pill{display:inline-block;font-size:10px;font-weight:700;padding:3px 10px;border-radius:99px;
 letter-spacing:.4px}
.tabs{display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:0 0 auto;background:%(panel)s;border:1px solid %(grid)s;color:%(muted)s;font-size:12px;
 font-weight:600;padding:8px 15px;border-radius:99px;cursor:pointer;white-space:nowrap}
.tab.on{background:%(accent)s;color:%(bg)s;border-color:%(accent)s}
section[hidden]{display:none}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:%(muted)s;margin-top:9px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;
 vertical-align:-1px}
#tip{position:fixed;z-index:99;pointer-events:none;opacity:0;transition:opacity .12s;
 background:#000;border:1px solid %(grid)s;color:%(text)s;font-size:11px;line-height:1.45;
 padding:7px 10px;border-radius:8px;white-space:nowrap;box-shadow:0 6px 20px #0009}
@media(max-width:430px){.grid2{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}
 .kpi3{gap:6px}.kpi3 .card{padding:10px 3px 8px;border-radius:13px}
 .kpilab .pill{font-size:9px;padding:2px 7px}}
""" % C

TAB_JS = """
document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){
  document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on')});
  document.querySelectorAll('section[data-p]').forEach(function(s){s.hidden=true});
  t.classList.add('on');
  document.querySelector('section[data-p="'+t.dataset.t+'"]').hidden=false;
  window.scrollTo({top:0,behavior:'smooth'});};});
"""


def _stat(v, k, color=None):
    return (f'<div class="stat"><div class="v" style="color:{color or C["text"]}">{v}</div>'
            f'<div class="k">{_html.escape(str(k))}</div></div>')


def _card(title, inner, note=None):
    n = f'<p class="note">{note}</p>' if note else ""
    return f'<div class="card"><h2>{title}</h2>{inner}{n}</div>'


def _hm(m):
    m = int(round(float(m)))
    return f"{m // 60}h {m % 60:02d}m"


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

    rows = []
    for day, g in hr_all.groupby("day"):
        base = rhr_map.get(day, fallback_rhr)
        s, load_, zmin = mx.day_strain(g, base, hrmax)
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

    sf = mx.sleep_series(nights, dict(zip(strain_df["date"], strain_df["strain"])))

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
    tgt = m["recovery"].apply(mx.optimal_strain)
    m["target_lo"] = [t[0] for t in tgt]
    m["target_hi"] = [t[1] for t in tgt]
    return {"m": m, "sf": sf, "nights": nights, "nights_all": nights_all,
            "hr": hr_all, "hrmax": hrmax, "rhr": rhr, "hrv": hrv, "rr": rr,
            "rhr_map": rhr_map, "hrv_map": hrv_map, "fallback_rhr": fallback_rhr}


def build(out_path=None, con=None):
    D = compute(con)
    m, sf, nights, hr_all = D["m"], D["sf"], D["nights"], D["hr"]
    last, night = m.iloc[-1], nights[-1]
    lday = last["date"]
    base_rhr = float(last["rhr_used"])
    bounds = mx.zone_bounds(base_rhr, D["hrmax"])
    hr_today = hr_all[hr_all["day"] == lday][["ts", "bpm"]]

    hist = nights[-31:-1] or nights
    baseline = {k: float(np.mean([n["stage_min"].get(k, 0) for n in hist]))
                for k in mx.STAGES}
    tonight = night["stage_min"]
    parts = sf.iloc[-1]["parts"]
    score = int(sf.iloc[-1]["score"])
    rec = int(last["recovery"])
    rec_col = C["good"] if rec >= 67 else (C["awake"] if rec >= 34 else C["warn"])
    band = ("Light", C["muted"]) if last["strain"] < 10 else \
           ("Moderate", C["good"]) if last["strain"] < 14 else \
           ("High", C["awake"]) if last["strain"] < 18 else ("All out", C["warn"])
    acwr = m["load"].tail(7).mean() / max(m["load"].tail(28).mean(), 1)

    # The newest day is almost always partial. Strain accumulates, so say so
    # rather than letting a low number look like a bug.
    span_h = ((hr_today["ts"].max() - hr_today["ts"].min()).total_seconds() / 3600
              if len(hr_today) > 1 else 0.0)
    partial = span_h < 20
    fresh = hr_all["ts"].max()
    age_min = max(0.0, (pd.Timestamp.now() - fresh).total_seconds() / 60)
    if age_min < 90:
        age_txt = f"{int(age_min)} min ago"
    elif age_min < 60 * 36:
        age_txt = f"{age_min / 60:.0f} h ago"
    else:
        age_txt = f"{age_min / 1440:.0f} days ago"
    stale = age_min > 45
    hrv_today = D["hrv_map"].get(lday)
    partial_note = ("Today is still in progress, so strain and time-in-zone are "
                    "running totals. " if partial else "")
    partial_banner = (
        f'<p class="note" style="margin-top:10px;color:{C["muted"]}">'
        f'Today is still in progress — strain and time-in-zone are running '
        f'totals and will keep climbing until midnight.</p>' if partial else "")

    # --- the three headline KPIs -------------------------------------------
    last_night = sf.iloc[-1]
    rec_word = ("Well recovered" if rec >= 67 else
                "Moderate" if rec >= 34 else "Low")
    score_col = (C["good"] if score >= 80 else
                 C["awake"] if score >= 60 else C["warn"])
    nights_of_hist = len(sf) - 1
    rec_tip = (f"Recovery {rec}%|55% HRV + 25% resting HR + 20% sleep|"
               f"vs your own {min(nights_of_hist, cfg.BASELINE_DAYS)}-day baseline")
    sleep_tip = (f"Sleep score {score}/100|"
                 f"{_hm(last_night['asleep'])} asleep of {_hm(last_night['need'])} needed|"
                 f"tap the Sleep tab for the full breakdown")

    today = f"""
<div class="kpi3">
  <div class="card kpi">{ch.strain_gauge(round(last['strain'], 1), last['target_lo'],
                                         last['target_hi'], cfg.STRAIN_SCALE)}</div>
  <div class="card kpi">{ch.recovery_ring(rec, tip=rec_tip)}</div>
  <div class="card kpi">{ch.sleep_ring(score, tip=sleep_tip,
                                       sub=_hm(last_night['asleep']))}</div>
</div>
<div class="card"><div class="stats">
  {_stat(f"{hrv_today:.0f}" if hrv_today else "&mdash;", "HRV ms", rec_col)}
  {_stat(f"{base_rhr:.0f}", "RHR bpm")}
  {_stat(f"{last_night['efficiency']*100:.0f}%", "Sleep eff")}
  {_stat(_hm(last_night['debt']), "Sleep debt",
         C['warn'] if last_night['debt'] > 180 else None)}
</div>{partial_banner}</div>
{_card("Heart rate — full resolution",
       ch.hr_intraday(hr_today, bounds),
       f"{len(hr_today):,} samples. Zone edges use heart-rate reserve (Karvonen) "
       f"from RHR {base_rhr:.0f} and HRmax {D['hrmax']:.0f}, not the 220−age "
       f"shortcut, so they move as your fitness moves.")}
{_card("Time in zone", '<div class="stats" style="grid-template-columns:repeat(5,1fr)">' +
       "".join(_stat(f"{int(last[f'z{i+1}'])}m", f"Z{i+1}", C["zone"][i] if i else None)
               for i in range(5)) + "</div>",
       f"Z1 under {bounds[1]} · Z2 {bounds[1]}–{bounds[2]} · "
       f"Z3 {bounds[2]}–{bounds[3]} · Z4 {bounds[3]}–{bounds[4]} · "
       f"Z5 {bounds[4]}+ bpm. The five buckets tile the whole day, so they sum "
       f"to the time your watch was recording.")}
{_card("Strain vs target — 21 days", ch.strain_history(m),
       "Green band is the recovery-scaled target range. Red bars overshot it; "
       "two or three in a row is the pattern that precedes a bad-recovery week.")}
"""

    sleep = f"""
<div class="card"><h2>Last night — hypnogram</h2>
  {ch.hypnogram(night)}
  <div class="legend">
    <span><i style="background:{C['awake']}"></i>Awake</span>
    <span><i style="background:{C['rem']}"></i>REM</span>
    <span><i style="background:{C['light']}"></i>Light</span>
    <span><i style="background:{C['deep']}"></i>Deep</span>
    <span>C1…Cn mark completed cycles</span></div>
  <div class="stats">
    {_stat(_hm(sf.iloc[-1]['asleep']), "Asleep")}
    {_stat(f"{sf.iloc[-1]['efficiency']*100:.0f}%", "Efficiency")}
    {_stat(_hm(sf.iloc[-1]['need']), "Needed")}
    {_stat(score, "Sleep score", C['good'] if score >= 80 else C['awake'])}</div>
  <p class="note">One continuous ribbon instead of four disconnected stacks. You can
  read how fast you dropped into deep sleep, whether REM lengthened toward morning
  the way it should, and exactly where the wake-ups landed. Tap any block for its
  times.</p></div>
<div class="grid2">
  {_card(f"Sleep score {score}/100", ch.score_breakdown(parts),
         "The six-metric breakdown Google shipped in April 2026, recomputed locally "
         "so you can see which metric is capping the score.")}
  {_card("Stages vs your 30-night baseline", ch.stage_bars(tonight, baseline),
         "Google dropped <code>thirtyDayAvgMinutes</code> from the v4 sleep schema, "
         "so this baseline is rebuilt from your own stored history.")}
</div>
{_card("Sleep consistency — last 14 nights", ch.sleep_columns(sf),
       f"Each night on a shared 18:00–12:00 clock axis; darker segment is deep "
       f"sleep. Consistency <b style='color:{C['accent']}'>{mx.consistency(nights)}/100</b> "
       f"from the circular standard deviation of bedtime. Dashed lines are median "
       f"bed and wake times.")}
{_card("Sleep debt — 30 days", ch.debt_area(sf),
       f"Current debt <b>{_hm(sf.iloc[-1]['debt'])}</b>. Need = 8h plus a surcharge "
       f"for yesterday's strain above 10, so a hard session raises tonight's bar.")}
"""

    tr = m.tail(30)
    hrv_spark = ch.sparkline([D['hrv_map'][d] for d in tr['date'] if d in D['hrv_map']],
                             C['good'])
    rhr_spark = ch.sparkline([D['rhr_map'][d] for d in tr['date'] if d in D['rhr_map']],
                             C['accent'])
    hrv_avg = D['hrv'].iloc[-30:, 1].mean() if not D['hrv'].empty else float("nan")
    rhr_avg = D['rhr'].iloc[-30:, 1].mean() if not D['rhr'].empty else float("nan")
    rr_avg = D['rr'].iloc[-7:, 1].mean() if not D['rr'].empty else float("nan")
    trends = f"""
<div class="grid2">
  {_card("HRV (rMSSD)", hrv_spark +
         '<div class="stats" style="grid-template-columns:1fr 1fr">' +
         _stat(f"{hrv_today:.0f} ms" if hrv_today else "&mdash;", "Today") +
         _stat(f"{hrv_avg:.0f} ms" if hrv_avg == hrv_avg else "&mdash;", "30d avg") +
         "</div>")}
  {_card("Resting heart rate", rhr_spark +
         '<div class="stats" style="grid-template-columns:1fr 1fr">' +
         _stat(f"{base_rhr:.0f} bpm", "Today") +
         _stat(f"{rhr_avg:.0f} bpm" if rhr_avg == rhr_avg else "&mdash;", "30d avg") +
         "</div>")}
</div>
{_card("Rolling averages", '<div class="stats">' +
       _stat(f"{m['strain'].tail(7).mean():.1f}", "7d strain", C["strain"]) +
       _stat(f"{m['recovery'].tail(7).mean():.0f}%", "7d recovery", rec_col) +
       _stat(_hm(sf['asleep'].tail(7).mean()), "7d sleep") +
       _stat(f"{rr_avg:.1f}" if rr_avg == rr_avg else "&mdash;", "7d resp rate") +
       "</div>",
       f"Acute:chronic workload ratio <b>{acwr:.2f}</b> (7-day TRIMP over 28-day "
       f"TRIMP). 0.8–1.3 is the conventional safe window; sustained readings "
       f"above 1.5 are the classic overreaching signature.")}
{_card("Sleep score — 30 nights", ch.sparkline(list(sf['score'].tail(30)), C['rem']) +
       '<div class="stats" style="grid-template-columns:repeat(3,1fr)">' +
       _stat(f"{sf['score'].tail(7).mean():.0f}", "7d avg") +
       _stat(f"{sf['score'].tail(30).mean():.0f}", "30d avg") +
       _stat(f"{sf['score'].tail(30).max():.0f}", "30d best") + "</div>")}
"""

    html = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="{C['bg']}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Pulse">
<title>Pulse</title>
<style>{CSS}</style></head><body>
<header><h1>Pulse</h1><span class="sub" style="color:{C['warn'] if stale else C['muted']}">
last reading {fresh:%H:%M} &middot; {age_txt}</span></header>
<div class="tabs">
  <div class="tab on" data-t="today">Today</div>
  <div class="tab" data-t="sleep">Sleep</div>
  <div class="tab" data-t="trends">Trends</div></div>
<section data-p="today">{today}</section>
<section data-p="sleep" hidden>{sleep}</section>
<section data-p="trends" hidden>{trends}</section>
<p class="note" style="text-align:center;margin-top:16px">
 Built locally from your Google Health API data. {partial_note}Your watch syncs to the
 phone roughly every 15 minutes in the background, or immediately when you open the
 Google Health app &mdash; that sync, not this page, sets how fresh the data is.</p>
<script>{ch.TIP_JS}{TAB_JS}</script></body></html>"""

    out = out_path or cfg.OUT_HTML
    out.write_text(html, encoding="utf-8")
    return out, D
