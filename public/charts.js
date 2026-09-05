// Pure SVG chart builders. Each takes plain arrays and returns an SVG string —
// no DOM, no fetch, no globals beyond the CSS custom properties.
//
// Ported from pulse/charts.py, which rendered these server-side into a static
// HTML file. Same shapes, same palette, same reasoning; the difference is that
// these run in the browser so they can be scrubbed.
//
// ---------------------------------------------------------------------------
// WIDTH IS NOW AN ARGUMENT, and it is the whole reason this file changed.
//
// Every chart used to be authored at a fixed 680-unit viewBox and stretched to
// whatever the card was. A phone's content column is ~270px, so that was a
// 0.4x shrink: `font-size:10.5` landed at ~4.3 real pixels. Illegible. The old
// `min-width:520px` + horizontal scroll existed to hold a legibility floor, not
// out of laziness — it traded "can't read the labels" for "have to drag".
//
// Passing the measured pixel width in and authoring the viewBox at 1 unit = 1
// CSS pixel removes the trade entirely: 10.5 means 10.5px on every device, the
// chart always fits its card, and nothing scrolls. The cost is that padding and
// tick counts have to be computed from W rather than hardcoded — which is what
// `narrow()`, `padL()` and `dateAxis()` below are for.
//
// Interaction contract: any element carrying data-tip is hoverable, and app.js
// installs one delegated listener for the whole page rather than a handler per
// mark. "|" splits a tip into lines. Charts that additionally emit
// `data-scrub` on the <svg> plus `rect[data-i]` hit bands get the drag
// scrubber (see bindScrub in app.js) — that is the touch story, since hover
// does not exist on a phone.
//
// For a scrub band specifically: put the VALUE first, whatever's being
// scrubbed to find (a number, a duration, a stage name) — writeReadout in
// app.js renders segment 0 as the big bold headline. Everything after the
// first "|" is context (date, time, drink count) and renders small, in one
// trailing line. Getting this backwards is easy to miss reading one chart in
// isolation -- it only becomes obvious once you're scrubbing and the biggest
// thing on screen is the date.

const CSS = getComputedStyle(document.documentElement);
export const col = (n) => CSS.getPropertyValue("--" + n).trim();
const SANS = CSS.getPropertyValue("--sans");
export const ZONE = ["#3A4358", "#4C7BD6", "#3FD68A", "#F2A93B", "#F2545B"];

export const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
export const ok = (v) => typeof v === "number" && !Number.isNaN(v);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------- clock
// 12-hour throughout, matching localClock() in lib/night.js -- the tap
// notification already said "Drink 3 · 11:42 PM", so the dashboard reading
// "23:42" was the odd one out, not the other way round.
//
// These format for DISPLAY only. Every clock value in flight stays "HH:MM"
// 24-hour, because that is what mins() parses and what app.js writes when it
// formats drink timestamps; converting at the source would mean parsing
// "AM"/"PM" back out again on the next hop.
const ampm = (h) => (h < 12 ? " AM" : " PM");
const h12 = (h) => (h % 12 === 0 ? 12 : h % 12);
const wrap = (t) => ((Math.round(t) % 1440) + 1440) % 1440;
/** minute-of-day (may run past midnight) -> "11:42 PM" */
export const clock12 = (t) => {
  const m = wrap(t), h = Math.floor(m / 60);
  return `${h12(h)}:${String(m % 60).padStart(2, "0")}${ampm(h)}`;
};
/** minute-of-day -> "11 PM" -- hour ticks have no room for the minutes */
const tick12 = (t) => { const h = Math.floor(wrap(t) / 60); return `${h12(h)}${ampm(h)}`; };
/** "23:42" -> "11:42 PM" */
const t12 = (s) => clock12(mins(s));

/** A phone in portrait. Drives gutter widths and tick density, nothing else. */
export const narrow = (W) => W < 420;
/** Left gutter. Y labels are the only thing in it, and they are shorter on a phone. */
const padL = (W) => (narrow(W) ? 32 : 46);
const padR = (W) => (narrow(W) ? 10 : 14);

function svg(w, h, body, label, scrub) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img"
    ${scrub ? `data-scrub="${scrub}"` : ""} aria-label="${esc(label)}">${body}</svg>`;
}
const txt = (x, y, s, { size = 10.5, fill = "muted", anchor = "end", weight = 400 } = {}) =>
  `<text x="${Number(x).toFixed(1)}" y="${Number(y).toFixed(1)}" text-anchor="${anchor}" fill="${col(fill)}"
    font-size="${size}" font-weight="${weight}" font-family="${SANS}">${s}</text>`;
const scales = (x0, x1, y0, y1, n, lo, hi) => ({
  x: (i) => x0 + (n < 2 ? 0 : (i / (n - 1)) * (x1 - x0)),
  y: (v) => y1 - ((v - lo) / ((hi - lo) || 1)) * (y1 - y0),
});
const grid = (x0, x1, ys) =>
  ys.map((y) => `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${col("grid")}" stroke-width="1"/>`).join("");
const axis = (x0, x1, y) =>
  `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${col("grid")}" stroke-width="1"/>`;

// A transparent full-height band per index, so the hit target is the column and
// not the 3px mark inside it. Charts are read with a thumb.
//
// data-i / data-x / data-y are the scrubber's contract with app.js: the index
// for ordering, the centre in user units so the crosshair can be placed without
// re-deriving the scale, and (where the chart has a single series) the y of the
// mark so the cursor dot can sit on it.
const hits = (n, s, y0, y1, tip, yAt) =>
  Array.from({ length: n }, (_, i) => {
    const w = n < 2 ? 40 : s.x(1) - s.x(0);
    const y = yAt ? yAt(i) : null;
    return `<rect data-i="${i}" data-x="${s.x(i).toFixed(1)}"${ok(y) ? ` data-y="${y.toFixed(1)}"` : ""}
      x="${(s.x(i) - w / 2).toFixed(1)}" y="${y0}" width="${w.toFixed(1)}" height="${(y1 - y0).toFixed(1)}"
      fill="transparent" data-tip="${esc(tip(i))}"/>`;
  }).join("");

// The crosshair the scrubber moves. Emitted hidden; app.js unhides it on the
// first pointer contact and leaves it wherever the finger lifted, so the value
// you stopped on stays on screen instead of vanishing with the touch.
const scrubLayer = (y0, y1) => `<g class="scrubg" hidden>
  <line class="cross" x1="0" y1="${y0}" x2="0" y2="${y1}" stroke="${col("text")}" stroke-width="1" opacity=".65"/>
  <circle class="cursor" cx="0" cy="0" r="4.5" fill="${col("text")}" stroke="${col("panel")}" stroke-width="2" opacity="0"/>
</g>`;

// -------------------------------------------------------------------- axes
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (iso) => { const p = String(iso).split("-"); return `${+p[1]}/${+p[2]}`; };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Explicit y/m/d args, not `new Date(iso)`: the latter parses as UTC midnight,
// which getDay() then reads back in the browser's LOCAL zone -- west of UTC
// that is still "yesterday" at any hour before the local offset catches up,
// so every date would read one weekday early. The constructor's y/m/d form
// builds local midnight directly; no zone conversion, no room for the bug.
const wd = (iso) => { const p = String(iso).split("-"); return WD[new Date(+p[0], +p[1] - 1, +p[2]).getDay()]; };
/** "Aug 29" — for readouts, where "2026-08-29" spent ten characters on nothing. */
export const dlabel = (iso) => {
  const p = String(iso).split("-");
  return MON[+p[1] - 1] ? `${MON[+p[1] - 1]} ${+p[2]}` : String(iso);
};

// Date ticks along the bottom. THE MISSING AXIS: bars, strain, debt, sleep
// columns and the sparklines all drew a bare baseline with no dates on it, so
// every one of them was a shape with no "when". Tick count scales with width —
// a phone gets 3-4 labels, a laptop 8-10 — because the alternative at 30 days
// is 30 overlapping ones.
//
// Strided BACKWARDS from the newest night on purpose. Counting forwards leaves
// the right edge unlabelled whenever n-1 is not a multiple of the stride, and
// the right edge is the one date a trend is actually read against; a ragged gap
// at the old end costs nothing by comparison.
// A window of 14 days or less never repeats a weekday across two labelled
// ticks at the usual stride, so "Mon Wed Fri" reads unambiguously; past that
// the same name would land on two different weeks with nothing distinguishing
// them, so it falls back to the calendar date.
function dateAxis(W, dates, i0, n, s, y) {
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 58))));
  const fmt = n <= 14 ? wd : md;
  let out = "";
  for (let i = n - 1; i >= 0; i -= step) {
    const d = dates[i0 + i];
    if (d) out += txt(s.x(i), y, fmt(d), { size: 9.5, anchor: "middle" });
  }
  return out;
}

// ------------------------------------------------------------------- dials
function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

export function gauge(v, max, c, label, tip) {
  const cx = 65, cy = 67, r = 47, a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
  const f = ok(v) ? Math.max(0, Math.min(1, v / max)) : 0;
  return svg(130, 104, `
    <path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${col("panel2")}" stroke-width="10" stroke-linecap="round"/>
    ${ok(v) ? `<path d="${arcPath(cx, cy, r, a0, a0 + (a1 - a0) * f)}" fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round"/>` : ""}
    <text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="${col(ok(v) ? "text" : "dim")}" font-size="34" font-weight="600"
      font-family="${SANS}" style="font-variant-numeric:tabular-nums">${ok(v) ? v : "—"}</text>
    <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="transparent" data-tip="${esc(tip)}"/>`,
    `${label} ${ok(v) ? v : "not available"} of ${max}`);
}

export function ring(v, c, label, tip) {
  const cx = 65, cy = 54, r = 43, circ = 2 * Math.PI * r;
  // A caller with no score yet (before tonight's sleep has synced) used to
  // pass a fallback 0, which drew a real-looking empty ring with a giant "0"
  // -- indistinguishable from an actual bad night. And a non-numeric v would
  // make f = NaN, reintroducing the same NaN-stroke-dasharray class of bug
  // fixed in strainHistory. Draw an honest "no data yet" state instead.
  if (!ok(v)) {
    return svg(130, 104, `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col("panel2")}" stroke-width="10"
        stroke-dasharray="3 5"/>
      <text x="${cx}" y="${cy + 11}" text-anchor="middle" fill="${col("dim")}" font-size="28" font-weight="600"
        font-family="${SANS}">—</text>
      <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="transparent" data-tip="${esc(tip)}"/>`,
      `${label}: not yet available`);
  }
  const f = Math.max(0, Math.min(1, v / 100));
  return svg(130, 104, `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col("panel2")}" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${(circ * f).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 11}" text-anchor="middle" fill="${col("text")}" font-size="33" font-weight="600"
      font-family="${SANS}" style="font-variant-numeric:tabular-nums">${v}</text>
    <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="transparent" data-tip="${esc(tip)}"/>`,
    `${label} ${v} of 100`);
}

// --------------------------------------------------------------- hypnogram
// One continuous ribbon, not four stacked totals. Vertical position encodes
// depth, connectors between blocks make the descent through each cycle a
// visible path, and cycle markers land at every REM exit. This is the shape
// the Google Health app draws, and the reason it reads better than a bar
// chart is that alcohol shows up as *structure*: deep sleep front-loaded,
// REM pushed late and short, awakenings clustered in the second half.
const LEVEL = { AWAKE: 0, REM: 1, LIGHT: 2, DEEP: 3 };
// "Rem" is not a word. Title-casing the others and leaving the acronym alone
// is the whole rule, and it is worth the three lines to not print it wrong.
const STAGE_NAME = { AWAKE: "Awake", REM: "REM", LIGHT: "Light", DEEP: "Deep" };
/** "0h 01m" reads badly for a one-minute block; under an hour, drop the hours. */
const dur = (m) => (m < 60 ? `${Math.round(m)}m` : hm(m));

export function hypnogram(W, h, ht = 244) {
  if (!h?.segs?.length) {
    return svg(W, 92, txt(W / 2, 50, "no stage data for this night", { anchor: "middle" }), "no stage data");
  }
  // padB carries both the hour ticks and, when present, the HR-floor marker
  // below the ribbon -- a second row bought with 18px, not a second chart.
  const pl = narrow(W) ? 40 : 48, pr = padR(W), padT = 20, padB = 50;
  const iw = W - pl - pr, ih = ht - padT - padB;
  const row = ih / 4, bar = row * 0.6;
  const X = (m) => pl + (m / h.span) * iw;
  const Y = (lvl) => padT + lvl * row + (row - bar) / 2;
  const startMin = (() => { const [a, b] = h.start.split(":").map(Number); return a * 60 + b; })();
  const clock = (m) => clock12(startMin + m);

  const COL = { AWAKE: col("awake"), REM: col("rem"), LIGHT: col("light"), DEEP: col("deep") };
  let p = "";

  for (const [name, lvl] of Object.entries(LEVEL)) {
    const yy = padT + lvl * row + row / 2;
    p += `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${W - pr}" y2="${yy.toFixed(1)}"
      stroke="${col("grid")}" stroke-width="1" stroke-dasharray="2 4"/>`;
    p += txt(pl - 7, yy + 3.5, narrow(W) ? name[0] : name[0] + name.slice(1).toLowerCase(), { size: 9.5 });
  }

  // connectors first so blocks sit on top
  for (let i = 1; i < h.segs.length; i++) {
    const a = h.segs[i - 1], b = h.segs[i], x = X(b.a);
    p += `<line x1="${x.toFixed(1)}" y1="${(Y(LEVEL[a.t]) + bar / 2).toFixed(1)}"
      x2="${x.toFixed(1)}" y2="${(Y(LEVEL[b.t]) + bar / 2).toFixed(1)}"
      stroke="${COL[b.t]}" stroke-width="2" opacity=".45"/>`;
  }

  for (const s of h.segs) {
    const x0 = X(s.a), wd = Math.max(X(s.b) - x0, 1.4);
    const tip = `${STAGE_NAME[s.t] || s.t} · ${dur(s.b - s.a)}|${clock(s.a)} – ${clock(s.b)}`;
    p += `<rect x="${x0.toFixed(1)}" y="${Y(LEVEL[s.t]).toFixed(1)}" width="${wd.toFixed(1)}"
      height="${bar.toFixed(1)}" rx="${Math.min(2.5, wd / 2).toFixed(1)}" fill="${COL[s.t]}" data-tip="${esc(tip)}"/>`;
  }

  let n = 0;
  for (let i = 1; i < h.segs.length; i++) {
    if (h.segs[i - 1].t === "REM" && h.segs[i].t !== "REM") {
      const xc = X(h.segs[i - 1].b); n++;
      p += `<line x1="${xc.toFixed(1)}" y1="${padT - 5}" x2="${xc.toFixed(1)}" y2="${padT + ih}"
        stroke="${col("muted")}" stroke-width=".8" opacity=".5"/>`;
      p += txt(xc, padT - 8, "C" + n, { size: 8, anchor: "middle" });
    }
  }

  // Hour ticks, strided so a phone gets ~4 rather than 9 overlapping ones.
  // Divisor sized for "11 PM" (5 chars), wider than the old lowercase "11p".
  const hourStep = Math.max(1, Math.ceil(h.span / 60 / Math.max(2, Math.floor(W / 68))));
  for (let m = 60 - (startMin % 60), k = 0; m < h.span; m += 60, k++) {
    if (k % hourStep) continue;
    p += txt(X(m), ht - 30, tick12(startMin + m), { size: 9, anchor: "middle" });
  }

  // The HR floor for the night: how low it went, and how long it took to get
  // there. Deliberately drawn below the ribbon rather than mapped onto its
  // depth axis -- the ribbon's y-position encodes sleep STAGE, not bpm, and
  // stacking a heart-rate value onto that axis would imply a scale that
  // doesn't exist. A time marker, same idiom as the C1/C2 cycle markers
  // above, keeps the two honestly separate while still reading as one night.
  if (ok(h.nadirMin) && ok(h.nadirBpm)) {
    const xn = X(h.nadirMin), yTop = padT + ih, yDot = yTop + 9, yLabel = ht - 8;
    p += `<line x1="${xn.toFixed(1)}" y1="${yTop}" x2="${xn.toFixed(1)}" y2="${yDot - 3}"
        stroke="${col("strain")}" stroke-width="1.25" opacity=".7"/>
      <circle cx="${xn.toFixed(1)}" cy="${yDot}" r="3" fill="${col("strain")}"/>
      ${txt(xn, yLabel, `${h.nadirBpm} bpm floor`, { size: 9.5, anchor: "middle", fill: "strain" })}`;
  }
  // Scrub bands across the night -- same contract as the heart-rate chart, one
  // band per sampled minute carrying the stage under it and the clock time.
  // The per-segment data-tips stop being reachable the moment data-scrub is set
  // (app.js excludes marks inside a scrubbable chart from the floating tooltip),
  // which is the point: a 3px REM sliver at the end of a cycle was never a
  // touch target, and those are exactly the transitions worth reading.
  const nb = Math.max(24, Math.min(320, Math.round(iw)));
  const bw = iw / nb;
  let si = 0;
  for (let i = 0; i < nb; i++) {
    const m = (i + 0.5) * (h.span / nb);
    while (si < h.segs.length - 1 && h.segs[si].b <= m) si++;
    const seg = h.segs[si];
    const name = STAGE_NAME[seg.t] || seg.t;
    p += `<rect data-i="${i}" data-x="${X(m).toFixed(1)}" data-y="${(Y(LEVEL[seg.t]) + bar / 2).toFixed(1)}"
      x="${(X(m) - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${ih.toFixed(1)}"
      fill="transparent" data-tip="${esc(`${name} · ${dur(seg.b - seg.a)}|${clock(seg.a)} – ${clock(seg.b)}`)}"/>`;
  }
  p += scrubLayer(padT, padT + ih);
  return svg(W, ht, p, "Sleep stages across the night with cycle markers and the heart-rate floor", "time");
}

// ---------------------------------------------------------------- intraday
// Clock helpers. The stored curve is [["HH:MM", bpm], ...] in local time, so a
// night wraps midnight and the minute-of-day goes backwards halfway through.
// Everything below works in "absolute minutes since the first sample" instead,
// unrolled once here, so the x scale is honestly proportional to time rather
// than to array index — those two disagree wherever the curve has a gap.
export const mins = (s) => { const [a, b] = String(s).split(":").map(Number); return a * 60 + b; };
const hhmm = (t) => `${String(Math.floor((t % 1440) / 60)).padStart(2, "0")}:${String(Math.round(t) % 60).padStart(2, "0")}`;
const unroll = (list, t0) => list.map((v) => { let m = mins(v); while (m < t0) m += 1440; return m; });

// Bucket the curve for drawing. push.py stores one point per minute
// (CURVE_BUCKET_SEC = 60), which across a ~16h window is ~960 points — two per
// pixel on a phone, and a scrub band a third of a pixel wide. Five-minute means
// are pixel-identical at any width this chart is ever drawn at and give the
// thumb something to actually land on.
//
// Done here rather than in push.py on purpose: the stored data stays at full
// resolution, so this is reversible, needs no backfill, and does not care that
// Actions only rewrites the last 30 nights.
export const BUCKET_MIN = 5;
function bucket(pts, size = BUCKET_MIN) {
  if (pts.length < 2) return pts;
  const t = unroll(pts.map((p) => p[0]), mins(pts[0][0]));
  if (t[1] - t[0] >= size) return pts;            // already this coarse or coarser
  const out = [];
  let key = Math.floor(t[0] / size), acc = [];
  const flush = () => { if (acc.length) out.push([hhmm(key * size), Math.round(acc.reduce((a, b) => a + b, 0) / acc.length)]); };
  pts.forEach((p, i) => {
    const k = Math.floor(t[i] / size);
    if (k !== key) { flush(); acc = []; key = k; }
    acc.push(p[1]);
  });
  flush();
  return out;
}

// The workout detail's "Time in each zone" bars (app.js's zoneBars) use
// Fitbit's own light/moderate/vigorous/peak split and are colored to match
// -- reusing colors already meaningful elsewhere (light = sleep's LIGHT
// stage, good/awake/warn = recovery's own good/moderate/bad) rather than
// inventing a fourth palette just for this.
export const WZONE = [col("light"), col("good"), col("awake"), col("warn")];

// The workout HR CHART is a separate coloring from those bars: an intensity
// gradient across the same 5 Karvonen bands zone_min already uses everywhere
// else in the app (day_strain() in metrics.py) -- green at the low end, red
// at the top, so "how hard was this moment" reads at a glance the way a
// heart-rate-zone chart conventionally does. Deliberately not tied to
// WZONE's 4 named bands above: this is a numbered Z1-Z5 gradient, not a
// recoloring of Fitbit's classification.
const HR_GRADIENT = ["#3FD68A", "#A3D639", "#F2CB3B", "#F2A93B", "#F2545B"];
const zoneEdges5 = (rhr, hrmax) => { const res = hrmax - rhr; return [0, 0.6, 0.7, 0.8, 0.9, 1].map((f) => rhr + res * f); };
const zoneIndex5 = (bpm, edges) => { for (let k = 0; k < 4; k++) { if (bpm < edges[k + 1]) return k; } return 4; };

/**
 * One civil day of heart rate, with Karvonen zone bands and drink markers.
 *
 * push.py stores 00:00-24:00 local, so there is no midnight wrap inside a
 * curve any more and every "HH:MM" here is simply a minute of this day. The
 * chart still fits the extent of the data it actually has rather than padding
 * out to a full 24 hours -- a day in progress ends at the last synced sample,
 * and reserving eight blank hours for the evening you have not lived yet would
 * squeeze the part you opened the app to look at.
 *
 * Takes an options bag rather than (D, t) because it is drawn for whichever
 * day the stepper is on, not only for the newest row.
 *
 * `zoned` swaps the single-color line and the usual muted Z1-Z5 background
 * for the green-to-red HR_GRADIENT above, with the line itself colored
 * per-segment by zone rather than drawn as one polyline -- used only by the
 * workout detail. Every other caller (the Day tab, heart rate during sleep)
 * is unaffected.
 */
export function hrIntraday(W, { curve, drinks = [], hrmax, rhr, zoned = false }) {
  const h = 232, x0 = padL(W), x1 = W - padR(W), y0 = 36, y1 = 186, yAxis = 208;
  // A night's row has no curve until that sleep session has ended and synced --
  // push.py only computes hr_curve once sleep_start/sleep_end exist. That is
  // the normal state on every first login of the day, not an error.
  if (!curve?.length) {
    return svg(W, 92, txt(W / 2, 50, "no heart-rate curve stored for this day", { anchor: "middle" }),
      "No heart rate curve for this day");
  }
  // A workout is at most 6h (MAX_SESSION_MIN, metrics.py) and usually well
  // under an hour, so the 5-minute bucketing built for a full 16h day would
  // throw away most of the detail a short session actually has -- a 22-minute
  // walk has only 22 raw samples to begin with, and bucketing to 5-minute
  // means would leave ~4 points. push.py already stores hr_curve at 1-minute
  // resolution, so zoned charts just draw it as-is.
  const pts = zoned ? curve : bucket(curve);
  const b = pts.map((p) => p[1]), lo = Math.min(...b) - 8, hi = Math.max(...b) + 8;
  const t = unroll(pts.map((p) => p[0]), mins(pts[0][0]));
  const span = t[t.length - 1] - t[0] || 1;
  // Time-proportional, not index-proportional: a gap in the curve should read
  // as a gap, and the drink markers below have always been placed on the clock.
  // Those two mappings used to be different functions and quietly disagreed.
  const X = (m) => x0 + ((m - t[0]) / span) * (x1 - x0);
  const Y = (v) => y1 - ((v - lo) / ((hi - lo) || 1)) * (y1 - y0);

  let p = "";
  // Same 5-band edges either way -- zoned only changes which palette paints
  // them and whether the line itself is one of the two below.
  const edges = ok(hrmax) && ok(rhr) ? zoneEdges5(rhr, hrmax) : null;
  if (edges) {
    const palette = zoned ? HR_GRADIENT : ZONE;
    for (let i = 0; i < 5; i++) {
      const yT = Y(Math.min(edges[i + 1], hi)), yB = Y(Math.max(edges[i], lo));
      if (yB > yT) p += `<rect x="${x0}" y="${yT.toFixed(1)}" width="${x1 - x0}" height="${(yB - yT).toFixed(1)}" fill="${palette[i]}" opacity=".16"/>`;
    }
  }
  p += grid(x0, x1, [y0, (y0 + y1) / 2, y1]);
  if (zoned && edges) {
    // One short segment per consecutive pair rather than one polyline: SVG
    // has no per-vertex stroke color, so a line whose color tracks the zone
    // it's passing through has to be built out of many single-color pieces.
    // Colored by the segment's OWN average bpm, not by which side crosses a
    // threshold -- consistent regardless of which endpoint you'd otherwise
    // have picked.
    for (let i = 0; i < pts.length - 1; i++) {
      const zi = zoneIndex5((pts[i][1] + pts[i + 1][1]) / 2, edges);
      p += `<line x1="${X(t[i]).toFixed(1)}" y1="${Y(pts[i][1]).toFixed(1)}" x2="${X(t[i + 1]).toFixed(1)}" y2="${Y(pts[i + 1][1]).toFixed(1)}"
        stroke="${HR_GRADIENT[zi]}" stroke-width="1.75" stroke-linecap="round"/>`;
    }
  } else {
    p += `<polyline points="${pts.map((q, i) => `${X(t[i]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join(" ")}"
      fill="none" stroke="${col("strain")}" stroke-width="1.5" stroke-linejoin="round"/>`;
  }

  // Drink markers are selected by WHERE THEY FALL, not by which drinking night
  // they belong to. A session runs 9pm to 1am and a civil day cuts it at
  // midnight, so a night key can no longer decide what belongs on this chart:
  // the 1am drinks are the next day's markers on the next day's curve, and the
  // stepper walks between the two halves. Anything outside the drawn window is
  // not this day's business.
  //
  // Staggered across two rows when they crowd. Rounds land 40-50 minutes apart,
  // which on a 320px phone spanning a whole day is ~10px -- less than one badge
  // diameter, so a single row merged the numbered dots into an amber blob.
  // Alternating rows doubles the effective spacing without shrinking the target.
  const R = 6.5, ROWS = [y0 - 12, y0 - 27];
  const tLo = t[0], tHi = t[t.length - 1];
  let lastX = -1e9, row = 0;
  drinks
    .map((s) => ({ at: s, v: mins(s) }))
    .filter((d) => d.v >= tLo - 3 && d.v <= tHi + 3)
    .sort((a, b2) => a.v - b2.v)
    .forEach((d, i) => {
      const x = X(Math.min(Math.max(d.v, tLo), tHi));
      row = x - lastX < R * 2 + 2 ? 1 - row : 0;
      lastX = x;
      const cy = ROWS[row];
      p += `<line x1="${x.toFixed(1)}" y1="${(cy + R).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y1}" stroke="${col("drink")}" stroke-width="1.25" opacity=".5"/>
        <circle cx="${x.toFixed(1)}" cy="${cy}" r="${R}" fill="${col("drink")}" data-tip="${esc(`Drink ${i + 1}|${t12(d.at)}`)}"/>
        ${txt(x, cy + 3.2, i + 1, { size: 8.5, anchor: "middle", fill: "bg", weight: 700 })}`;
    });

  // Hit bands are on the same time scale as everything else, so they stay
  // aligned across a gap; `data-x` hands the scrubber the centre directly.
  p += pts.map((q, i) => {
    const w = span / Math.max(1, pts.length - 1) / span * (x1 - x0);
    return `<rect data-i="${i}" data-x="${X(t[i]).toFixed(1)}" data-y="${Y(q[1]).toFixed(1)}"
      x="${(X(t[i]) - w / 2).toFixed(1)}" y="${y0}" width="${Math.max(w, 1).toFixed(1)}" height="${y1 - y0}"
      fill="transparent" data-tip="${esc(`${q[1]} bpm|${t12(q[0])}`)}"/>`;
  }).join("");

  p += [lo, (lo + hi) / 2, hi].map((v) => txt(x0 - 7, Y(v) + 4, Math.round(v))).join("");
  p += axis(x0, x1, y1);

  // Hour ticks on the clock, strided to fit. The old version stepped by array
  // index and printed "HH:MM" — at 7 labels on a phone that was a solid smear.
  // Divisor sized for "11 PM" (5 chars), wider than the old lowercase "11p".
  const hourStep = Math.max(1, Math.ceil(span / 60 / Math.max(2, Math.floor(W / 62))));
  const hourTicks = [];
  for (let m = Math.ceil(t[0] / 60) * 60, k = 0; m <= t[t.length - 1]; m += 60, k++) {
    if (k % hourStep) continue;
    hourTicks.push(m);
  }
  // Hour-aligned ticks work for a full day, which always crosses several, but
  // a session under ~2h (any workout) can cross zero or one -- a 56-minute
  // weights set spanning 3:29-4:25 only ever has "4 PM" to show, leaving both
  // ends of the chart unlabeled and the whole thing looking cut off. Below 3
  // ticks, fall back to evenly-spaced marks across the data's OWN start and
  // end instead of the clock's hour grid, so a short chart always shows where
  // it begins and ends. Labeled with minutes (clock12) rather than the bare
  // hour (tick12): four marks inside one hour would otherwise all print the
  // same "5 PM" and look like a labeling bug rather than four real times.
  const short = hourTicks.length < 3;
  const ticks = short ? [0, 1, 2, 3].map((k) => t[0] + (span * k) / 3) : hourTicks;
  ticks.forEach((m, k) => {
    // The fallback's first and last ticks sit exactly on the chart's own
    // edges (t[0] and t[last]) rather than an hour boundary with margin on
    // both sides -- center-anchoring "6:27 PM" there overflows it half past
    // the edge and clips. Anchor those two outward instead; the two middle
    // ticks have room and stay centered.
    const anchor = short && k === 0 ? "start" : short && k === ticks.length - 1 ? "end" : "middle";
    p += txt(X(m), yAxis, short ? clock12(m) : tick12(m), { size: 9.5, anchor });
  });
  p += scrubLayer(y0, y1);
  return svg(W, h, p, "Heart rate across the night with zone bands and drink markers", "time");
}

// -------------------------------------------------------------------- bars
export function bars(W, D, vals, days, color, fmt, unit) {
  const n = Math.max(1, Math.min(days, D.dates.length));
  const h = 190, x0 = padL(W), x1 = W - padR(W), y0 = 14, y1 = 138, i0 = vals.length - n;
  const v = vals.slice(i0), clean = v.filter(ok);
  const hi = (clean.length ? Math.max(...clean) : 1) * 1.12 || 1;
  const s = scales(x0, x1, y0, y1, n, 0, hi), bw = Math.max(3, Math.min(18, (x1 - x0) / n - 4));
  let p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]), mk = "";
  v.forEach((x, i) => {
    if (!ok(x)) return;
    p += `<rect x="${(s.x(i) - bw / 2).toFixed(1)}" y="${s.y(x).toFixed(1)}" width="${bw.toFixed(1)}"
      height="${Math.max(1, y1 - s.y(x)).toFixed(1)}" rx="2.5" fill="${color}"/>`;
    if (D.drinks[i0 + i]) mk += `<circle cx="${s.x(i).toFixed(1)}" cy="${y1 + 13}" r="4" fill="${col("drink")}"/>`;
  });
  p += axis(x0, x1, y1) + mk;
  p += hits(n, s, y0, y1 + 20, (i) => {
    const d = D.drinks[i0 + i];
    return `${ok(v[i]) ? Math.round(v[i]).toLocaleString() + " " + unit : "no data"}|${dlabel(D.dates[i0 + i])}${d ? `|${d} drink${d > 1 ? "s" : ""}` : ""}`;
  }, (i) => (ok(v[i]) ? s.y(v[i]) : null));
  p += [0, hi / 2, hi].map((x) => txt(x0 - 8, s.y(x) + 4, fmt(x))).join("");
  p += dateAxis(W, D.dates, i0, n, s, h - 8);
  p += scrubLayer(y0, y1);
  return svg(W, h, p, `${unit} over ${n} days`, "day");
}

export function strainHistory(W, D, days) {
  const n = Math.max(1, Math.min(days, D.dates.length));
  const h = 210, x0 = padL(W), x1 = W - padR(W), y0 = 14, y1 = 158, i0 = D.dates.length - n;
  const pool = [...D.strain.slice(i0), ...D.target_hi.slice(i0)].filter(ok);
  const hi = (pool.length ? Math.max(...pool) : 18) + 2;
  const s = scales(x0, x1, y0, y1, n, 0, hi), bw = Math.max(3, Math.min(20, (x1 - x0) / n - 5));
  let band = "", bar = "", mk = "";
  for (let i = 0; i < n; i++) {
    // j goes negative whenever fewer than `n` nights of data exist yet --
    // requesting 21 days with 6 real nights is the normal state for the
    // first several weeks. D.strain[-9] is undefined, not an error, and
    // s.y(undefined) is NaN -- which the browser then rejects as an SVG
    // coordinate. Skip rather than draw a broken bar.
    const j = i0 + i;
    if (j < 0 || !ok(D.strain[j])) continue;
    const cx = s.x(i), v = D.strain[j];
    if (ok(D.target_hi[j]) && ok(D.target_lo[j])) {
      band += `<rect x="${(cx - bw / 2 - 2).toFixed(1)}" y="${s.y(D.target_hi[j]).toFixed(1)}" width="${(bw + 4).toFixed(1)}"
        height="${Math.max(0, s.y(D.target_lo[j]) - s.y(D.target_hi[j])).toFixed(1)}" fill="${col("good")}" opacity=".14"/>`;
    }
    bar += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${s.y(v).toFixed(1)}" width="${bw.toFixed(1)}"
      height="${Math.max(1, y1 - s.y(v)).toFixed(1)}" rx="3" fill="${v > D.target_hi[j] ? col("warn") : col("strain")}"/>`;
    if (D.drinks[j]) mk += `<circle cx="${cx.toFixed(1)}" cy="${y1 + 13}" r="4.5" fill="${col("drink")}"/>
      ${txt(cx, y1 + 16.5, D.drinks[j], { size: 7, anchor: "middle", fill: "bg", weight: 700 })}`;
  }
  const p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]) + band + bar + axis(x0, x1, y1) + mk +
    hits(n, s, y0, y1 + 20, (i) => {
      const j = i0 + i;
      if (j < 0 || !ok(D.strain[j])) return `no data|${j < 0 ? "—" : dlabel(D.dates[j])}`;
      return `${D.strain[j]}|${dlabel(D.dates[j])} · target ${D.target_lo[j]}–${D.target_hi[j]}${D.drinks[j] ? `|${D.drinks[j]} drinks` : ""}`;
    }, (i) => (ok(D.strain[i0 + i]) ? s.y(D.strain[i0 + i]) : null)) +
    [0, hi / 2, hi].map((v) => txt(x0 - 7, s.y(v) + 4, v.toFixed(0))).join("") +
    dateAxis(W, D.dates, i0, n, s, h - 8) + scrubLayer(y0, y1);
  return svg(W, h, p, "Strain against the recovery-scaled target band", "day");
}

export function stagesVsBaseline(W, D, t) {
  const h = 200, x0 = padL(W), x1 = W - padR(W), y0 = 14, y1 = 152;
  const keys = ["deep", "light", "rem", "awake"];
  const cs = [col("deep"), col("light"), col("rem"), col("awake")];
  const base = keys.map((k) => { const v = D[k].filter(ok); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; });
  const mine = keys.map((k) => t[k]);
  const pool = [...base, ...mine].filter(ok);
  const hi = (pool.length ? Math.max(...pool) : 60) * 1.15;
  const s = scales(x0, x1, y0, y1, 4, 0, hi);
  const slot = (x1 - x0) / 4, bw = Math.min(34, slot / 2 - 4);
  let p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]);
  keys.forEach((k, i) => {
    const cx = x0 + (i + 0.5) * slot;
    const delta = ok(mine[i]) && ok(base[i]) ? Math.round(mine[i] - base[i]) : null;
    if (ok(base[i])) {
      p += `<rect x="${(cx - bw - 2).toFixed(1)}" y="${s.y(base[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y1 - s.y(base[i])).toFixed(1)}"
        rx="3" fill="${cs[i]}" opacity=".3" data-tip="${esc(`${k.toUpperCase()} baseline|${hm(base[i])} · 30-night average`)}"/>`;
    }
    if (ok(mine[i])) {
      p += `<rect x="${(cx + 2).toFixed(1)}" y="${s.y(mine[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y1 - s.y(mine[i])).toFixed(1)}"
        rx="3" fill="${cs[i]}" data-tip="${esc(`${k.toUpperCase()} this night|${hm(mine[i])}${delta === null ? "" : ` · ${delta >= 0 ? "+" : ""}${delta}m vs baseline`}`)}"/>`;
    }
    p += txt(cx, y1 + 18, k.toUpperCase(), { size: narrow(W) ? 9.5 : 11, anchor: "middle" });
  });
  p += axis(x0, x1, y1);
  p += [0, hi / 2, hi].map((v) => txt(x0 - 8, s.y(v) + 4, Math.round(v) + "m")).join("");
  return svg(W, h, p, "This night's stages against the 30-night average");
}

export function debtArea(W, D, days) {
  const n = Math.max(1, Math.min(days, D.dates.length));
  const h = 172, x0 = padL(W), x1 = W - padR(W), y0 = 14, y1 = 128, i0 = D.debt.length - n;
  const v = D.debt.slice(i0).map((x) => (ok(x) ? x : 0));
  const hi = Math.max(...v, 60) * 1.1, s = scales(x0, x1, y0, y1, n, 0, hi);
  const line = v.map((x, i) => `${s.x(i).toFixed(1)},${s.y(x).toFixed(1)}`).join(" ");
  const p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]) +
    `<polygon points="${x0},${y1} ${line} ${x1},${y1}" fill="${col("rem")}" opacity=".22"/>
     <polyline points="${line}" fill="none" stroke="${col("rem")}" stroke-width="2" stroke-linejoin="round"/>` +
    axis(x0, x1, y1) +
    hits(n, s, y0, y1, (i) => `${hm(v[i])} of debt|${dlabel(D.dates[i0 + i])}`, (i) => s.y(v[i])) +
    // Hours only in the gutter: "12h 00m" needs 44px of a 270px chart, and the
    // half-hour was never the point of a debt trend.
    [0, hi / 2, hi].map((x) => txt(x0 - 7, s.y(x) + 4, Math.round(x / 60) + "h")).join("") +
    dateAxis(W, D.dates, i0, n, s, h - 8) + scrubLayer(y0, y1);
  return svg(W, h, p, "Rolling sleep debt", "day");
}

export function sleepColumns(W, D, days) {
  const n = Math.max(1, Math.min(days, D.dates.length));
  const h = 215, x0 = padL(W), x1 = W - padR(W), y0 = 14, y1 = 163, i0 = D.dates.length - n;
  const s = scales(x0, x1, y0, y1, n, 0, 18 * 60), bw = Math.max(3, Math.min(24, (x1 - x0) / n - 6));
  let p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]);
  for (let i = 0; i < n; i++) {
    const j = i0 + i; if (j < 0 || !ok(D.asleep[j])) continue;
    const cx = s.x(i);
    let y = y1 - (D.asleep[j] / (18 * 60)) * (y1 - y0);
    for (const [k, c] of [["deep", col("deep")], ["light", col("light")], ["rem", col("rem")], ["awake", col("awake")]]) {
      const hh = ((D[k][j] || 0) / (18 * 60)) * (y1 - y0);
      p += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, hh - 1).toFixed(1)}" fill="${c}"/>`;
      y += hh;
    }
    if (D.drinks[j]) p += `<circle cx="${cx.toFixed(1)}" cy="${y1 + 13}" r="4" fill="${col("drink")}"/>`;
  }
  p += axis(x0, x1, y1);
  p += hits(n, s, y0, y1 + 20, (i) => {
    const j = i0 + i;
    if (j < 0 || !ok(D.asleep[j])) return `no data|${j < 0 ? "—" : dlabel(D.dates[j])}`;
    return `${hm(D.asleep[j])}|${dlabel(D.dates[j])} · REM ${hm(D.rem[j])} · deep ${hm(D.deep[j])}${D.drinks[j] ? `|${D.drinks[j]} drinks` : ""}`;
  });
  p += [0, 4, 8, 12].map((hh) => txt(x0 - 8, s.y(hh * 60) + 4, hh + "h")).join("");
  p += dateAxis(W, D.dates, i0, n, s, h - 8) + scrubLayer(y0, y1);
  return svg(W, h, p, "Sleep duration and composition over recent nights", "day");
}

export function sparkline(W, D, vals, color, days, unit) {
  const n = Math.max(1, Math.min(days, D.dates.length));
  const h = 158, x0 = padL(W), x1 = W - padR(W), y0 = 14, y1 = 118, i0 = vals.length - n;
  const v = vals.slice(i0), cl = v.filter(ok);
  if (!cl.length) return svg(W, 92, txt(W / 2, 50, "no data in this window", { anchor: "middle" }), "no data");
  const lo = Math.min(...cl) * 0.94, hi = Math.max(...cl) * 1.06, s = scales(x0, x1, y0, y1, n, lo, hi);
  let d = "", prev = false, mk = "";
  v.forEach((x, i) => {
    if (!ok(x)) { prev = false; return; }
    d += (prev ? " L" : " M") + `${s.x(i).toFixed(1)},${s.y(x).toFixed(1)}`; prev = true;
    if (D.drinks[i0 + i]) mk += `<circle cx="${s.x(i).toFixed(1)}" cy="${s.y(x).toFixed(1)}" r="3.6"
      fill="${col("drink")}" stroke="${col("panel")}" stroke-width="1.5"/>`;
  });
  const p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]) +
    `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` + mk +
    axis(x0, x1, y1) +
    hits(n, s, y0, y1, (i) => {
      const j = i0 + i;
      return `${ok(v[i]) ? v[i] + " " + unit : "no data"}|${dlabel(D.dates[j])}${D.drinks[j] ? `|after ${D.drinks[j]} drinks` : ""}`;
    }, (i) => (ok(v[i]) ? s.y(v[i]) : null)) +
    // The unit rides on the top label only; repeating "ms" three times down a
    // 270px gutter is noise, and the card title already says what this is.
    [lo, (lo + hi) / 2, hi].map((x, k) => txt(x0 - 8, s.y(x) + 4, Math.round(x) + (k === 2 && unit && !narrow(W) ? " " + unit : ""))).join("") +
    dateAxis(W, D.dates, i0, n, s, h - 8) + scrubLayer(y0, y1);
  return svg(W, h, p, `Trend over ${n} days`, "day");
}

// The payoff chart.
// Percentage-of-baseline points, shared by doseResponse() and slope() so the
// two can't quietly disagree the way the chart and the Today-tab strip once
// did. Each point prefers ITS OWN night's stored hrv_baseline -- a trailing
// 30-day median computed server-side, excluding that night itself -- over a
// single whole-account mean. The mean is only a fallback (an account with
// under 3 prior nights, or a fixture with no baseline column at all): as a
// shared denominator across every point it drifts every past night's
// percentage retroactively each time a new one arrives, which a per-night
// value never does. Verified against real data: the two methods gave 77.5%
// vs 82% for the same night.
function pctPoints(D) {
  const hasStored = Array.isArray(D.hrvBaseline);
  const sober = D.hrv.filter((_, i) => !D.drinks[i] && ok(D.hrv[i]));
  const wholeHistoryMean = sober.reduce((a, b) => a + b, 0) / sober.length;
  const pts = [];
  for (let i = 0; i < D.dates.length; i++) {
    if (!ok(D.hrv[i])) continue;
    const base = hasStored && ok(D.hrvBaseline[i]) ? D.hrvBaseline[i] : wholeHistoryMean;
    pts.push([D.drinks[i], (D.hrv[i] / base) * 100, D.dates[i], D.hrv[i]]);
  }
  return { pts, wholeHistoryMean };
}

export function doseResponse(W, D) {
  const h = 258, x0 = padL(W) + 6, x1 = W - padR(W) - (narrow(W) ? 4 : 16), y0 = 16, y1 = 196;
  const { pts } = pctPoints(D);
  if (!pts.length) return svg(W, 92, txt(W / 2, 50, "no HRV recorded yet", { anchor: "middle" }), "no data");
  const maxD = Math.max(6, ...pts.map((p) => p[0]));
  const lo = Math.min(55, ...pts.map((p) => p[1])) - 5, hi = Math.max(...pts.map((p) => p[1])) + 5;
  const X = (d) => x0 + (d / maxD) * (x1 - x0), Y = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
  const N = pts.length;
  const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0), sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
  const m = (N * sxy - sx * sy) / (N * sxx - sx * sx || 1), b = (sy - m * sx) / N;

  // Drinks are integers, so sober nights would stack into one opaque column
  // that hides how many nights are in it. Deterministic jitter, seeded so the
  // layout is stable across renders.
  let dots = "", seed = 7;
  const jit = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 0.34; };
  for (const [d, v, date, raw] of pts) {
    dots += `<circle cx="${X(d + jit()).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${d ? 5.5 : 4}"
      fill="${d ? col("drink") : col("muted")}" opacity="${d ? 0.92 : 0.42}" stroke="${col("panel")}" stroke-width="1.5"
      data-tip="${esc(`${date}|${d ? d + " drinks" : "sober"} → HRV ${raw}ms, ${Math.round(v)}% of baseline`)}"/>`;
  }
  const p = grid(x0, x1, [y0, y1]) +
    `<line x1="${x0}" y1="${Y(100).toFixed(1)}" x2="${x1}" y2="${Y(100).toFixed(1)}" stroke="${col("muted")}" stroke-width="1.25" stroke-dasharray="5 4" opacity=".8"/>
     ${txt(x1, Y(100) - 8, "sober average", { size: narrow(W) ? 9.5 : 11 })}
     <line x1="${X(0)}" y1="${Y(b).toFixed(1)}" x2="${X(maxD)}" y2="${Y(m * maxD + b).toFixed(1)}" stroke="${col("drink")}" stroke-width="2" opacity=".75"
       data-tip="${esc(`fit|${m.toFixed(1)}% of baseline HRV per drink`)}"/>
     ${dots}${axis(x0, x1, y1)}` +
    Array.from({ length: maxD + 1 }, (_, d) => txt(X(d), y1 + 18, d, { anchor: "middle" })).join("") +
    [lo, 100, hi].map((v) => txt(x0 - 9, Y(v) + 4, Math.round(v) + "%")).join("") +
    txt((x0 + x1) / 2, h - 8, "standard drinks that night", { size: 11, anchor: "middle" });
  return svg(W, h, p, "Drinks against next-morning HRV as a percentage of baseline");
}

export const slope = (D) => {
  const { pts, wholeHistoryMean } = pctPoints(D);
  const N = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0), sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
  // `base` is kept for callers with no per-night baseline of their own (the
  // Today-tab strip falls back to it for an account too new to have one) --
  // it is deliberately the same whole-history mean every point already falls
  // back to individually, not a third definition of "baseline".
  return { m: (N * sxy - sx * sy) / (N * sxx - sx * sx || 1), base: wholeHistoryMean };
};
