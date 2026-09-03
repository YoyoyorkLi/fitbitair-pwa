"""Hand-rolled SVG. No chart library, no CDN, no build step.

Renders inline in one HTML file, works offline, stays crisp on a phone.
Interactivity is one delegated pointer handler (TIP_JS) reading data-tip
attributes: ~15 lines instead of 300 kB of JS.

Tooltips use "|" as a line separator and literal unicode instead of named HTML
entities, so every attribute stays valid XML.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import C

LEVEL = {"AWAKE": 0, "REM": 1, "LIGHT": 2, "DEEP": 3}
COL = {"AWAKE": C["awake"], "REM": C["rem"], "LIGHT": C["light"], "DEEP": C["deep"]}

TIP_JS = """
(function(){
 var tip=document.createElement('div');tip.id='tip';document.body.appendChild(tip);
 function show(e,t){tip.innerHTML=t.split('|').join('<br>');tip.style.opacity=1;
   var x=(e.touches?e.touches[0].clientX:e.clientX),y=(e.touches?e.touches[0].clientY:e.clientY);
   var w=tip.offsetWidth;x=Math.max(8,Math.min(x-w/2,window.innerWidth-w-8));
   tip.style.left=x+'px';tip.style.top=(y-tip.offsetHeight-14)+'px';}
 function hide(){tip.style.opacity=0;}
 document.addEventListener('pointerover',function(e){
   var el=e.target.closest('[data-tip]');if(el)show(e,el.getAttribute('data-tip'));});
 document.addEventListener('pointermove',function(e){
   var el=e.target.closest('[data-tip]');if(el)show(e,el.getAttribute('data-tip'));else hide();});
 document.addEventListener('pointerout',hide);
 document.addEventListener('touchstart',function(e){
   var el=e.target.closest('[data-tip]');if(el){show(e,el.getAttribute('data-tip'));
   e.preventDefault();}},{passive:false});
})();
"""


def esc(s):
    """Attribute-safe. Tooltips are user data in the sense that device names and
    stage enums come from an API we do not control."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _svg(w, h, body, extra=""):
    return (f'<svg class="chart" viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid meet" '
            f'xmlns="http://www.w3.org/2000/svg" {extra}>{body}</svg>')


def _hm(m):
    m = int(round(float(m)))
    return f"{m // 60}h {m % 60:02d}m"


def _empty(w, h, msg="no data"):
    return _svg(w, h, f'<text x="{w/2}" y="{h/2}" text-anchor="middle" '
                      f'fill="{C["muted"]}" font-size="11">{esc(msg)}</text>')


# ---------------------------------------------------------------- hypnogram
def hypnogram(night, w=680, h=210):
    """THE headline fix: one continuous ribbon instead of four stacked bars.

    Vertical position encodes depth, colour reinforces it, and connectors
    between segments make the descent through each cycle a visible path.
    """
    if not night or not night.get("stages"):
        return _empty(w, h, "no sleep stages")
    pad_l, pad_r, pad_t, pad_b = 44, 10, 16, 26
    iw, ih = w - pad_l - pad_r, h - pad_t - pad_b
    t0, t1 = night["start"], night["end"]
    span = max((t1 - t0).total_seconds(), 1)
    row = ih / 4
    bar = row * 0.60

    def x(t):
        return pad_l + (t - t0).total_seconds() / span * iw

    def y(lvl):
        return pad_t + lvl * row + (row - bar) / 2

    p = []
    for name, lvl in LEVEL.items():
        yy = pad_t + lvl * row + row / 2
        p.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{w - pad_r}" y2="{yy:.1f}" '
                 f'stroke="{C["grid"]}" stroke-width="1" stroke-dasharray="2 4"/>')
        p.append(f'<text x="{pad_l - 6}" y="{yy + 3.5:.1f}" text-anchor="end" '
                 f'font-size="9" fill="{C["muted"]}">{name.title()}</text>')

    segs = night["stages"]
    for a, b in zip(segs, segs[1:]):          # connectors, drawn under blocks
        xa = x(b["start"])
        ya, yb = y(LEVEL[a["type"]]) + bar / 2, y(LEVEL[b["type"]]) + bar / 2
        p.append(f'<line x1="{xa:.1f}" y1="{ya:.1f}" x2="{xa:.1f}" y2="{yb:.1f}" '
                 f'stroke="{COL[b["type"]]}" stroke-width="2" opacity=".45"/>')

    for s in segs:
        x0, x1_ = x(s["start"]), x(s["end"])
        wd = max(x1_ - x0, 1.2)
        tip = esc(f'{s["type"].title()} \u00b7 {_hm(s["mins"])}|'
                  f'{s["start"]:%H:%M} \u2013 {s["end"]:%H:%M}')
        p.append(f'<rect x="{x0:.1f}" y="{y(LEVEL[s["type"]]):.1f}" width="{wd:.1f}" '
                 f'height="{bar:.1f}" rx="{min(2.5, wd / 2):.1f}" '
                 f'fill="{COL[s["type"]]}" data-tip="{tip}"/>')

    n = 0                                      # cycle markers at each REM exit
    for a, b in zip(segs, segs[1:]):
        if a["type"] == "REM" and b["type"] != "REM":
            n += 1
            xc = x(a["end"])
            p.append(f'<line x1="{xc:.1f}" y1="{pad_t - 4}" x2="{xc:.1f}" '
                     f'y2="{pad_t + ih}" stroke="{C["muted"]}" stroke-width=".8" '
                     f'opacity=".5"/>')
            p.append(f'<text x="{xc:.1f}" y="{pad_t - 6}" text-anchor="middle" '
                     f'font-size="8" fill="{C["muted"]}">C{n}</text>')

    # next whole hour without a pandas frequency alias ("H" -> "h" renamed in 2.2)
    tick = (t0 + pd.Timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    while tick < t1:
        p.append(f'<text x="{x(tick):.1f}" y="{h - 8}" text-anchor="middle" '
                 f'font-size="9" fill="{C["muted"]}">{tick:%H}</text>')
        tick += pd.Timedelta(hours=1)
    return _svg(w, h, "".join(p))


# ---------------------------------------------------------------- intraday HR
def hr_intraday(df, bounds, w=680, h=200):
    """Full-resolution HR with zone shading. Downsamples to the pixel grid with
    a min/max envelope so spikes survive rather than being averaged away."""
    pad_l, pad_r, pad_t, pad_b = 30, 8, 12, 22
    iw, ih = w - pad_l - pad_r, h - pad_t - pad_b
    if df is None or df.empty:
        return _empty(w, h, "no heart-rate samples")
    lo = max(35.0, float(df["bpm"].min()) - 8)
    hi = float(df["bpm"].max()) + 8
    if hi - lo < 10:
        hi = lo + 10
    t0 = df["ts"].iloc[0].normalize()

    def y(v):
        return pad_t + ih - (v - lo) / (hi - lo) * ih

    p = []
    # Bands match the five strain buckets: Z1 is everything below the 60% HRR
    # boundary, then 60-70, 70-80, 80-90, 90%+.
    cuts = [lo] + [b for b in bounds[1:] if lo < b < hi] + [hi]
    for i in range(len(cuts) - 1):
        y0, y1 = y(cuts[i + 1]), y(cuts[i])
        p.append(f'<rect x="{pad_l}" y="{y0:.1f}" width="{iw}" '
                 f'height="{max(y1-y0,0):.1f}" fill="{C["zone"][min(i,4)]}" opacity=".14"/>')

    nb = max(int(iw / 2), 1)
    idx = ((df["ts"] - t0).dt.total_seconds() / 86400 * nb).astype(int).clip(0, nb - 1)
    g = df.assign(b=idx).groupby("b")["bpm"].agg(["min", "max", "mean"])
    up = [f"{pad_l + (b + .5) / nb * iw:.1f},{y(r['max']):.1f}" for b, r in g.iterrows()]
    dn = [f"{pad_l + (b + .5) / nb * iw:.1f},{y(r['min']):.1f}"
          for b, r in reversed(list(g.iterrows()))]
    p.append(f'<polygon points="{" ".join(up + dn)}" fill="{C["strain"]}" opacity=".35"/>')
    line = " ".join(f"{pad_l + (b + .5) / nb * iw:.1f},{y(r['mean']):.1f}"
                    for b, r in g.iterrows())
    p.append(f'<polyline points="{line}" fill="none" stroke="{C["strain"]}" '
             f'stroke-width="1.3"/>')

    for b, r in g.iterrows():
        hh = pd.Timestamp(t0) + pd.Timedelta(seconds=(b + .5) / nb * 86400)
        p.append(f'<rect x="{pad_l + b / nb * iw:.1f}" y="{pad_t}" '
                 f'width="{iw/nb:.2f}" height="{ih}" fill="transparent" '
                 f'data-tip="{hh:%H:%M} \u00b7 {int(r["min"])}\u2013{int(r["max"])} bpm"/>')

    labels = [b for b in bounds if lo < b < hi] or [int(lo) + 5, int(hi) - 5]
    for v in labels:
        p.append(f'<text x="{pad_l - 4}" y="{y(v) + 3:.1f}" text-anchor="end" '
                 f'font-size="8.5" fill="{C["muted"]}">{v}</text>')
    for hh in range(0, 25, 4):
        xx = pad_l + hh / 24 * iw
        p.append(f'<text x="{xx:.1f}" y="{h - 6}" text-anchor="middle" font-size="9" '
                 f'fill="{C["muted"]}">{hh:02d}</text>')
    return _svg(w, h, "".join(p))


# ---------------------------------------------------------------- gauges
def _arc(cx, cy, r, a0, a1):
    x0, y0 = cx + r * np.cos(a0), cy + r * np.sin(a0)
    x1, y1 = cx + r * np.cos(a1), cy + r * np.sin(a1)
    large = 1 if (a1 - a0) > np.pi else 0
    return f"M {x0:.2f} {y0:.2f} A {r} {r} 0 {large} 1 {x1:.2f} {y1:.2f}"


# KPI geometry. The viewBox is deliberately tight (180x150) because these three
# cards sit in a 3-up row: on a 375px phone each card is ~107px wide, so a wide
# viewBox would shrink the labels below legibility. Verified 8px+ at that width.
KPI_W, KPI_H = 180, 150


LABEL_Y = 128          # shared baseline so the three KPI labels line up
SUB_Y = 144


def strain_gauge(strain, lo, hi, smax=21, w=KPI_W, h=KPI_H):
    cx, cy, r = w / 2, 100, 58
    a0, a1 = np.pi, 2 * np.pi
    smax = max(smax, 1)

    def f(v):
        return a0 + (a1 - a0) * float(np.clip(v / smax, 0, 1))

    p = [f'<path d="{_arc(cx, cy, r, a0, a1)}" stroke="{C["panel2"]}" stroke-width="11" '
         f'fill="none" stroke-linecap="round"/>',
         f'<path d="{_arc(cx, cy, r, f(lo), max(f(hi), f(lo) + .01))}" '
         f'stroke="{C["good"]}" stroke-width="11" fill="none" opacity=".32" '
         f'data-tip="Target strain {lo}\u2013{hi} for today\u0027s recovery"/>',
         f'<path d="{_arc(cx, cy, r, a0, max(f(strain), a0 + .01))}" '
         f'stroke="{C["strain"]}" stroke-width="11" fill="none" stroke-linecap="round"/>',
         f'<text x="{cx}" y="{cy - 10}" text-anchor="middle" font-size="36" '
         f'font-weight="700" fill="{C["text"]}">{strain}</text>',
         f'<text x="{cx}" y="{LABEL_Y}" text-anchor="middle" font-size="12" '
         f'fill="{C["muted"]}" letter-spacing="1.1">DAY STRAIN</text>',
         f'<text x="{cx}" y="{SUB_Y}" text-anchor="middle" font-size="11.5" '
         f'fill="{C["good"]}">target {lo}\u2013{hi}</text>']
    return _svg(w, h, "".join(p))


def _ring(value, label, col, sub, w=KPI_W, h=KPI_H, tip=None):
    """Shared ring for the 0-100 KPIs, so recovery and sleep read as siblings.

    The label sits *below* the ring rather than inside it: at a third of a phone
    screen the interior chord is only ~50px wide and a word like RECOVERY
    collides with the stroke. No tspan is used either, because some renderers
    silently drop it.
    """
    cx, cy, r = w / 2, 62, 46
    v = int(np.clip(value, 0, 100))
    a0 = -np.pi / 2
    a1 = a0 + 2 * np.pi * max(v, 0.5) / 100
    t = f' data-tip="{esc(tip)}"' if tip else ""
    p = [f'<circle cx="{cx}" cy="{cy}" r="{r}" stroke="{C["panel2"]}" '
         f'stroke-width="11" fill="none"/>',
         f'<path d="{_arc(cx, cy, r, a0, a1)}" stroke="{col}" stroke-width="11" '
         f'fill="none" stroke-linecap="round"{t}/>',
         f'<text x="{cx}" y="{cy + 13}" text-anchor="middle" font-size="36" '
         f'font-weight="700" fill="{col}">{v}</text>',
         f'<text x="{cx}" y="{LABEL_Y}" text-anchor="middle" font-size="12" '
         f'fill="{C["muted"]}" letter-spacing="1.1">{esc(label)}</text>',
         f'<text x="{cx}" y="{SUB_Y}" text-anchor="middle" font-size="11.5" '
         f'fill="{col}">{esc(sub)}</text>']
    return _svg(w, h, "".join(p))


def recovery_ring(rec, w=KPI_W, h=KPI_H, tip=None, sub=None):
    rec = int(np.clip(rec, 0, 100))
    col = C["good"] if rec >= 67 else (C["awake"] if rec >= 34 else C["warn"])
    word = "well recovered" if rec >= 67 else ("moderate" if rec >= 34 else "low")
    return _ring(rec, "RECOVERY", col, sub or word, w, h, tip)


def sleep_ring(score, w=KPI_W, h=KPI_H, tip=None, sub=None):
    score = int(np.clip(score, 0, 100))
    col = C["good"] if score >= 80 else (C["awake"] if score >= 60 else C["warn"])
    return _ring(score, "SLEEP SCORE", col, sub or "", w, h, tip)


# ---------------------------------------------------------------- histories
def strain_history(m, w=680, h=180):
    pad_l, pad_r, pad_t, pad_b = 26, 8, 12, 22
    iw, ih = w - pad_l - pad_r, h - pad_t - pad_b
    d = m.tail(21).reset_index(drop=True)
    if d.empty:
        return _empty(w, h)
    n = len(d)
    bw = iw / n * 0.62
    smax = 21
    p = []
    for i, r in d.iterrows():
        xc = pad_l + (i + .5) / n * iw
        yl = pad_t + ih * (1 - min(r["target_hi"] / smax, 1))
        yh = pad_t + ih * (1 - min(r["target_lo"] / smax, 1))
        p.append(f'<rect x="{xc - bw/2 - 2:.1f}" y="{yl:.1f}" width="{bw + 4:.1f}" '
                 f'height="{max(yh - yl, 1):.1f}" fill="{C["good"]}" opacity=".16"/>')
    for i, r in d.iterrows():
        xc = pad_l + (i + .5) / n * iw
        hh = ih * float(np.clip(r["strain"] / smax, 0, 1))
        col = C["warn"] if r["strain"] > r["target_hi"] else C["strain"]
        p.append(f'<rect x="{xc - bw/2:.1f}" y="{pad_t + ih - hh:.1f}" width="{bw:.1f}" '
                 f'height="{hh:.1f}" rx="2" fill="{col}" '
                 f'data-tip="{r["date"]:%a %d %b}|strain {r["strain"]:.1f} \u00b7 '
                 f'target {r["target_lo"]}\u2013{r["target_hi"]}|'
                 f'recovery {int(r["recovery"])}%"/>')
        if i % 4 == 0:
            p.append(f'<text x="{xc:.1f}" y="{h - 6}" text-anchor="middle" '
                     f'font-size="8.5" fill="{C["muted"]}">{r["date"]:%d}</text>')
    for v in (7, 14, 21):
        yy = pad_t + ih * (1 - v / smax)
        p.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{w-pad_r}" y2="{yy:.1f}" '
                 f'stroke="{C["grid"]}" stroke-width="1"/>')
        p.append(f'<text x="{pad_l-4}" y="{yy+3:.1f}" text-anchor="end" '
                 f'font-size="8.5" fill="{C["muted"]}">{v}</text>')
    return _svg(w, h, "".join(p))


def sleep_columns(sf, w=680, h=210):
    """Every night on one shared 18:00->12:00 clock axis, so bedtime drift is
    immediately visible. Darker segment inside each bar is deep sleep."""
    pad_l, pad_r, pad_t, pad_b = 34, 8, 14, 22
    iw, ih = w - pad_l - pad_r, h - pad_t - pad_b
    d = sf.tail(14).reset_index(drop=True)
    if d.empty:
        return _empty(w, h)
    n = len(d)
    rowh = ih / n

    def clock(ts):
        return (ts.hour + ts.minute / 60 - 18) % 24

    p = []
    for hh in range(0, 19, 3):
        xx = pad_l + hh / 18 * iw
        p.append(f'<line x1="{xx:.1f}" y1="{pad_t}" x2="{xx:.1f}" y2="{pad_t+ih}" '
                 f'stroke="{C["grid"]}" stroke-width="1"/>')
        p.append(f'<text x="{xx:.1f}" y="{h-6}" text-anchor="middle" font-size="8.5" '
                 f'fill="{C["muted"]}">{(18+hh)%24:02d}</text>')
    for v in (float(np.median([clock(t) for t in d["start"]])),
              float(np.median([clock(t) for t in d["end"]]))):
        xx = pad_l + np.clip(v, 0, 18) / 18 * iw
        p.append(f'<line x1="{xx:.1f}" y1="{pad_t-4}" x2="{xx:.1f}" y2="{pad_t+ih}" '
                 f'stroke="{C["accent"]}" stroke-width="1" stroke-dasharray="3 3" '
                 f'opacity=".8"/>')

    for i, r in d.iterrows():
        yy = pad_t + i * rowh + rowh * 0.18
        bh = rowh * 0.64
        a, b = clock(r["start"]), clock(r["end"])
        if b < a:
            b += 24
        x0 = pad_l + min(a, 18) / 18 * iw
        x1 = pad_l + min(b, 18) / 18 * iw
        p.append(f'<rect x="{x0:.1f}" y="{yy:.1f}" width="{max(x1-x0,2):.1f}" '
                 f'height="{bh:.1f}" rx="3" fill="{C["light"]}" opacity=".85" '
                 f'data-tip="{r["date"]:%a %d %b}|{r["start"]:%H:%M} \u2192 '
                 f'{r["end"]:%H:%M}|{_hm(r["asleep"])} asleep \u00b7 '
                 f'score {int(r["score"])}"/>')
        frac = float(np.clip(r["deep"] / max(r["asleep"], 1), 0, 1))
        p.append(f'<rect x="{x0:.1f}" y="{yy:.1f}" '
                 f'width="{max((x1-x0)*frac,1):.1f}" height="{bh:.1f}" rx="3" '
                 f'fill="{C["deep"]}" opacity=".9"/>')
        if i % 2 == 0:
            p.append(f'<text x="{pad_l-6}" y="{yy+bh*0.75:.1f}" text-anchor="end" '
                     f'font-size="8" fill="{C["muted"]}">{r["date"]:%a}</text>')
    return _svg(w, h, "".join(p))


def debt_area(sf, w=680, h=140):
    pad_l, pad_r, pad_t, pad_b = 34, 8, 12, 20
    iw, ih = w - pad_l - pad_r, h - pad_t - pad_b
    d = sf.tail(30).reset_index(drop=True)
    if len(d) < 2:
        return _empty(w, h, "need at least two nights")
    n = len(d)
    mx = max(float(d["debt"].max()), 120.0)
    pts = [(pad_l + i / (n - 1) * iw, pad_t + ih - r["debt"] / mx * ih)
           for i, r in d.iterrows()]
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    p = [f'<polygon points="{pad_l},{pad_t+ih} {poly} {pad_l+iw},{pad_t+ih}" '
         f'fill="{C["warn"]}" opacity=".18"/>',
         f'<polyline points="{poly}" fill="none" stroke="{C["warn"]}" stroke-width="1.8"/>']
    for i, r in d.iterrows():
        x, y = pts[i]
        p.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="transparent" '
                 f'data-tip="{r["date"]:%a %d %b}|debt {_hm(r["debt"])}|'
                 f'slept {_hm(r["asleep"])} of {_hm(r["need"])}"/>')
    for v in (0, mx / 2, mx):
        yy = pad_t + ih - v / mx * ih
        p.append(f'<text x="{pad_l-4}" y="{yy+3:.1f}" text-anchor="end" '
                 f'font-size="8.5" fill="{C["muted"]}">{int(v/60)}h</text>')
    return _svg(w, h, "".join(p))


def stage_bars(tonight, baseline, w=330, h=150):
    p, keys = [], ["DEEP", "REM", "LIGHT", "AWAKE"]
    pad_l, rowh = 46, h / len(keys)
    mx = max(max(list(tonight.values()) + [1]), max(list(baseline.values()) + [1]), 1)
    for i, k in enumerate(keys):
        yy = i * rowh + rowh * 0.2
        bh = rowh * 0.34
        vw = (w - pad_l - 44) * tonight.get(k, 0) / mx
        bw_ = (w - pad_l - 44) * baseline.get(k, 0) / mx
        delta = tonight.get(k, 0) - baseline.get(k, 0)
        p.append(f'<text x="{pad_l-6}" y="{yy+bh*0.9:.1f}" text-anchor="end" '
                 f'font-size="9.5" fill="{C["muted"]}">{k.title()}</text>')
        p.append(f'<rect x="{pad_l}" y="{yy:.1f}" width="{max(vw,1):.1f}" '
                 f'height="{bh:.1f}" rx="2.5" fill="{COL[k]}" '
                 f'data-tip="{k.title()} tonight {_hm(tonight.get(k,0))}"/>')
        p.append(f'<rect x="{pad_l}" y="{yy+bh+2:.1f}" width="{max(bw_,1):.1f}" '
                 f'height="3" rx="1.5" fill="{COL[k]}" opacity=".38" '
                 f'data-tip="30-night baseline {_hm(baseline.get(k,0))}"/>')
        col = C["good"] if (delta >= 0) != (k == "AWAKE") else C["warn"]
        p.append(f'<text x="{w-6}" y="{yy+bh*0.9:.1f}" text-anchor="end" '
                 f'font-size="9.5" font-weight="600" fill="{col}">{delta:+.0f}m</text>')
    return _svg(w, h, "".join(p))


def score_breakdown(parts, w=330, h=150):
    p, n = [], max(len(parts), 1)
    pad_l, rowh = 96, h / n
    for i, (k, (wt, got)) in enumerate(parts.items()):
        yy = i * rowh + rowh * 0.28
        bh = rowh * 0.40
        full = w - pad_l - 34
        p.append(f'<text x="{pad_l-6}" y="{yy+bh*0.85:.1f}" text-anchor="end" '
                 f'font-size="9" fill="{C["muted"]}">{esc(k)}</text>')
        p.append(f'<rect x="{pad_l}" y="{yy:.1f}" width="{full:.1f}" '
                 f'height="{bh:.1f}" rx="2.5" fill="{C["panel2"]}"/>')
        frac = got / wt if wt else 0
        col = C["good"] if frac > .8 else (C["awake"] if frac > .5 else C["warn"])
        p.append(f'<rect x="{pad_l}" y="{yy:.1f}" width="{max(full*frac,2):.1f}" '
                 f'height="{bh:.1f}" rx="2.5" fill="{col}" '
                 f'data-tip="{esc(k)}: {got} of {wt} points"/>')
        p.append(f'<text x="{w-4}" y="{yy+bh*0.85:.1f}" text-anchor="end" '
                 f'font-size="9" fill="{C["muted"]}">{got:g}/{wt}</text>')
    return _svg(w, h, "".join(p))


def sparkline(vals, col, w=300, h=64):
    v = [float(x) for x in vals if x == x and x is not None]
    if len(v) < 2:
        return _empty(w, h, "not enough history")
    lo, hi = min(v), max(v)
    rng = max(hi - lo, 1e-6)
    pts = [(6 + i / (len(v) - 1) * (w - 12), 8 + (1 - (x - lo) / rng) * (h - 16))
           for i, x in enumerate(v)]
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    return _svg(w, h,
                f'<polygon points="6,{h-8} {poly} {w-6},{h-8}" fill="{col}" opacity=".15"/>'
                f'<polyline points="{poly}" fill="none" stroke="{col}" stroke-width="1.8"/>'
                f'<circle cx="{pts[-1][0]:.1f}" cy="{pts[-1][1]:.1f}" r="3" fill="{col}"/>')
