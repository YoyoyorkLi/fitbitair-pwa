// Pure SVG chart builders. Each takes plain arrays and returns an SVG string —
// no DOM, no fetch, no globals beyond the CSS custom properties.
//
// Ported from pulse/charts.py, which rendered these server-side into a static
// HTML file. Same shapes, same palette, same reasoning; the difference is that
// these run in the browser so they can be hovered.
//
// Interaction contract: any element carrying data-tip is hoverable. app.js
// installs one delegated listener for the whole page rather than a handler per
// mark. "|" splits the tooltip into lines.

const CSS = getComputedStyle(document.documentElement);
export const col = (n) => CSS.getPropertyValue("--" + n).trim();
const SANS = CSS.getPropertyValue("--sans");
export const ZONE = ["#3A4358", "#4C7BD6", "#3FD68A", "#F2A93B", "#F2545B"];

export const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
export const ok = (v) => typeof v === "number" && !Number.isNaN(v);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function svg(w, h, body, label) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}">${body}</svg>`;
}
const txt = (x, y, s, { size = 10.5, fill = "muted", anchor = "end", weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${col(fill)}" font-size="${size}" font-weight="${weight}" font-family="${SANS}">${s}</text>`;
const scales = (x0, x1, y0, y1, n, lo, hi) => ({
  x: (i) => x0 + (n < 2 ? 0 : (i / (n - 1)) * (x1 - x0)),
  y: (v) => y1 - ((v - lo) / ((hi - lo) || 1)) * (y1 - y0),
});
const grid = (x0, x1, ys) =>
  ys.map((y) => `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${col("grid")}" stroke-width="1"/>`).join("");

// A transparent full-height band per index, so the hit target is the column and
// not the 3px mark inside it. Charts are read with a thumb.
const hits = (n, s, y0, y1, tip) =>
  Array.from({ length: n }, (_, i) => {
    const w = n < 2 ? 40 : (s.x(1) - s.x(0));
    return `<rect x="${(s.x(i) - w / 2).toFixed(1)}" y="${y0}" width="${w.toFixed(1)}" height="${y1 - y0}"
      fill="transparent" data-tip="${esc(tip(i))}"/>`;
  }).join("");

// ------------------------------------------------------------------- dials
function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

export function gauge(v, max, c, label, tip) {
  const cx = 65, cy = 68, r = 44, a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
  const f = Math.max(0, Math.min(1, v / max));
  return svg(130, 104, `
    <path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${col("panel2")}" stroke-width="9" stroke-linecap="round"/>
    <path d="${arcPath(cx, cy, r, a0, a0 + (a1 - a0) * f)}" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"/>
    <text x="${cx}" y="${cy + 7}" text-anchor="middle" fill="${col("text")}" font-size="27" font-weight="600"
      font-family="${SANS}" style="font-variant-numeric:tabular-nums">${v}</text>
    <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="transparent" data-tip="${esc(tip)}"/>`,
    `${label} ${v} of ${max}`);
}

export function ring(v, c, label, tip) {
  const cx = 65, cy = 54, r = 40, circ = 2 * Math.PI * r;
  // A caller with no score yet (before tonight's sleep has synced) used to
  // pass a fallback 0, which drew a real-looking empty ring with a giant "0"
  // -- indistinguishable from an actual bad night. And a non-numeric v would
  // make f = NaN, reintroducing the same NaN-stroke-dasharray class of bug
  // fixed in strainHistory. Draw an honest "no data yet" state instead.
  if (!ok(v)) {
    return svg(130, 104, `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col("panel2")}" stroke-width="9"
        stroke-dasharray="3 5"/>
      <text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="${col("dim")}" font-size="22" font-weight="600"
        font-family="${SANS}">—</text>
      <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="transparent" data-tip="${esc(tip)}"/>`,
      `${label}: not yet available`);
  }
  const f = Math.max(0, Math.min(1, v / 100));
  return svg(130, 104, `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col("panel2")}" stroke-width="9"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${(circ * f).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="${col("text")}" font-size="26" font-weight="600"
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

export function hypnogram(h, w = 680, ht = 236) {
  if (!h?.segs?.length) return svg(w, ht, txt(w / 2, ht / 2, "no stage data", { anchor: "middle" }), "no stage data");
  // padB carries both the hour ticks and, when present, the HR-floor marker
  // below the ribbon -- a second row bought with 18px, not a second chart.
  const padL = 48, padR = 12, padT = 20, padB = 46;
  const iw = w - padL - padR, ih = ht - padT - padB;
  const row = ih / 4, bar = row * 0.6;
  const X = (m) => padL + (m / h.span) * iw;
  const Y = (lvl) => padT + lvl * row + (row - bar) / 2;
  const startMin = (() => { const [a, b] = h.start.split(":").map(Number); return a * 60 + b; })();
  const clock = (m) => { const t = (startMin + m) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

  const COL = { AWAKE: col("awake"), REM: col("rem"), LIGHT: col("light"), DEEP: col("deep") };
  let p = "";

  for (const [name, lvl] of Object.entries(LEVEL)) {
    const yy = padT + lvl * row + row / 2;
    p += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - padR}" y2="${yy.toFixed(1)}"
      stroke="${col("grid")}" stroke-width="1" stroke-dasharray="2 4"/>`;
    p += txt(padL - 7, yy + 3.5, name[0] + name.slice(1).toLowerCase(), { size: 9.5 });
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
    const tip = `${s.t[0] + s.t.slice(1).toLowerCase()} · ${hm(s.b - s.a)}|${clock(s.a)} – ${clock(s.b)}`;
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

  for (let m = 60 - (startMin % 60); m < h.span; m += 60) {
    p += txt(X(m), ht - 9, clock(m).slice(0, 2), { size: 9, anchor: "middle" });
  }

  // The HR floor for the night: how low it went, and how long it took to get
  // there. Deliberately drawn below the ribbon rather than mapped onto its
  // depth axis -- the ribbon's y-position encodes sleep STAGE, not bpm, and
  // stacking a heart-rate value onto that axis would imply a scale that
  // doesn't exist. A time marker, same idiom as the C1/C2 cycle markers
  // above, keeps the two honestly separate while still reading as one night.
  if (ok(h.nadirMin) && ok(h.nadirBpm)) {
    const xn = X(h.nadirMin), yTop = padT + ih, yDot = yTop + 10, yLabel = yTop + 24;
    p += `<line x1="${xn.toFixed(1)}" y1="${yTop}" x2="${xn.toFixed(1)}" y2="${yDot - 3}"
        stroke="${col("strain")}" stroke-width="1.25" opacity=".7"/>
      <circle cx="${xn.toFixed(1)}" cy="${yDot}" r="3" fill="${col("strain")}"/>
      ${txt(xn, yLabel, `${h.nadirBpm} bpm floor`, { size: 9.5, anchor: "middle", fill: "strain" })}`;
  }
  return svg(w, ht, p, "Sleep stages across the night with cycle markers and the heart-rate floor");
}

// ---------------------------------------------------------------- intraday
export function hrIntraday(D, t) {
  const pts = D.curve, w = 680, h = 214, x0 = 42, x1 = 666, y0 = 18, y1 = 176;
  // Today's own row has no curve until tonight's sleep session has ended and
  // synced -- push.py only computes hr_curve once sleep_start/sleep_end exist.
  // That is the normal state on every first login of the day, not an error.
  if (!pts.length) {
    return svg(w, 90, txt(w / 2, 48, "tonight's curve arrives after you sleep", { anchor: "middle" }),
      "No heart rate curve yet for tonight");
  }
  const b = pts.map((p) => p[1]), lo = Math.min(...b) - 8, hi = Math.max(...b) + 8;
  const s = scales(x0, x1, y0, y1, pts.length, lo, hi);
  const res = D.hrmax - t.rhr, edges = [0, 0.6, 0.7, 0.8, 0.9, 1].map((f) => t.rhr + res * f);
  let p = "";
  for (let i = 0; i < 5; i++) {
    const yT = s.y(Math.min(edges[i + 1], hi)), yB = s.y(Math.max(edges[i], lo));
    if (yB > yT) p += `<rect x="${x0}" y="${yT}" width="${x1 - x0}" height="${yB - yT}" fill="${ZONE[i]}" opacity=".16"/>`;
  }
  p += grid(x0, x1, [y0, (y0 + y1) / 2, y1]);
  p += `<polyline points="${pts.map((q, i) => `${s.x(i).toFixed(1)},${s.y(q[1]).toFixed(1)}`).join(" ")}"
    fill="none" stroke="${col("strain")}" stroke-width="1.5" stroke-linejoin="round"/>`;

  const mins = (str) => { const [a, c] = str.split(":").map(Number); return a * 60 + c; };
  const t0 = mins(pts[0][0]);
  const abs = pts.map((q) => { let v = mins(q[0]); if (v < t0) v += 1440; return v; });
  const tEnd = abs[abs.length - 1];
  (D.drink_times || []).forEach((dt, i) => {
    let v = mins(dt); if (v < t0) v += 1440;
    const x = x0 + ((v - t0) / (tEnd - t0)) * (x1 - x0);
    p += `<line x1="${x.toFixed(1)}" y1="${y0}" x2="${x.toFixed(1)}" y2="${y1}" stroke="${col("drink")}" stroke-width="1.25" opacity=".5"/>
      <circle cx="${x.toFixed(1)}" cy="${y0 - 4}" r="6.5" fill="${col("drink")}" data-tip="${esc(`Drink ${i + 1}|${dt}`)}"/>
      ${txt(x, y0 - 1, i + 1, { size: 8, anchor: "middle", fill: "bg", weight: 700 })}`;
  });

  p += hits(pts.length, s, y0, y1, (i) => `${pts[i][1]} bpm|${pts[i][0]}`);
  p += [lo, (lo + hi) / 2, hi].map((v) => txt(x0 - 7, s.y(v) + 4, Math.round(v))).join("");
  for (let i = 0; i < pts.length; i += Math.floor(pts.length / 7)) p += txt(s.x(i), y1 + 16, pts[i][0], { anchor: "middle" });
  return svg(w, h, p, "Heart rate across the day with zone bands and drink markers");
}

// -------------------------------------------------------------------- bars
export function bars(D, vals, days, color, fmt, unit) {
  const n = days, w = 680, h = 172, x0 = 46, x1 = 666, y0 = 14, y1 = 130, i0 = vals.length - n;
  const v = vals.slice(i0), hi = Math.max(...v.filter(ok)) * 1.12;
  const s = scales(x0, x1, y0, y1, n, 0, hi), bw = Math.min(18, (x1 - x0) / n - 4);
  let p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]), mk = "";
  v.forEach((x, i) => {
    if (!ok(x)) return;
    p += `<rect x="${(s.x(i) - bw / 2).toFixed(1)}" y="${s.y(x).toFixed(1)}" width="${bw}"
      height="${Math.max(1, y1 - s.y(x)).toFixed(1)}" rx="2.5" fill="${color}"/>`;
    if (D.drinks[i0 + i]) mk += `<circle cx="${s.x(i).toFixed(1)}" cy="${y1 + 13}" r="4" fill="${col("drink")}"/>`;
  });
  p += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${col("grid")}"/>${mk}`;
  p += hits(n, s, y0, y1 + 18, (i) => {
    const d = D.drinks[i0 + i];
    return `${D.dates[i0 + i]}|${ok(v[i]) ? Math.round(v[i]).toLocaleString() + " " + unit : "no data"}${d ? `|${d} drink${d > 1 ? "s" : ""}` : ""}`;
  });
  p += [0, hi / 2, hi].map((x) => txt(x0 - 8, s.y(x) + 4, fmt(x))).join("");
  return svg(w, h, p, `${unit} over ${days} days`);
}

export function strainHistory(D, days) {
  const n = days, w = 680, h = 196, x0 = 34, x1 = 666, y0 = 14, y1 = 156, i0 = D.dates.length - n;
  const hi = Math.max(...D.strain.slice(i0), ...D.target_hi.slice(i0)) + 2;
  const s = scales(x0, x1, y0, y1, n, 0, hi), bw = Math.min(20, (x1 - x0) / n - 5);
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
    band += `<rect x="${(cx - bw / 2 - 2).toFixed(1)}" y="${s.y(D.target_hi[j]).toFixed(1)}" width="${bw + 4}"
      height="${Math.max(0, s.y(D.target_lo[j]) - s.y(D.target_hi[j])).toFixed(1)}" fill="${col("good")}" opacity=".14"/>`;
    bar += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${s.y(v).toFixed(1)}" width="${bw}"
      height="${Math.max(1, y1 - s.y(v)).toFixed(1)}" rx="3" fill="${v > D.target_hi[j] ? col("warn") : col("strain")}"/>`;
    if (D.drinks[j]) mk += `<circle cx="${cx.toFixed(1)}" cy="${y1 + 13}" r="4.5" fill="${col("drink")}"/>
      ${txt(cx, y1 + 16.5, D.drinks[j], { size: 7, anchor: "middle", fill: "bg", weight: 700 })}`;
  }
  const p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]) + band + bar +
    `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${col("grid")}"/>` + mk +
    hits(n, s, y0, y1 + 18, (i) => {
      const j = i0 + i;
      return `${D.dates[j]}|strain ${D.strain[j]} · target ${D.target_lo[j]}–${D.target_hi[j]}${D.drinks[j] ? `|${D.drinks[j]} drinks` : ""}`;
    }) + [0, hi / 2, hi].map((v) => txt(x0 - 7, s.y(v) + 4, v.toFixed(0))).join("");
  return svg(w, h, p, "Strain against the recovery-scaled target band");
}

export function stagesVsBaseline(D, t) {
  const w = 680, h = 190, x0 = 46, x1 = 666, y0 = 14, y1 = 150;
  const keys = ["deep", "light", "rem", "awake"];
  const cs = [col("deep"), col("light"), col("rem"), col("awake")];
  const base = keys.map((k) => { const v = D[k].filter(ok); return v.reduce((a, b) => a + b, 0) / v.length; });
  const mine = keys.map((k) => t[k]);
  const hi = Math.max(...base, ...mine) * 1.15, s = scales(x0, x1, y0, y1, 4, 0, hi), bw = 34;
  let p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]);
  keys.forEach((k, i) => {
    const cx = x0 + ((i + 0.5) / 4) * (x1 - x0);
    const delta = Math.round(mine[i] - base[i]);
    p += `<rect x="${cx - bw - 3}" y="${s.y(base[i]).toFixed(1)}" width="${bw}" height="${(y1 - s.y(base[i])).toFixed(1)}"
        rx="3" fill="${cs[i]}" opacity=".3" data-tip="${esc(`${k.toUpperCase()} baseline|${hm(base[i])} · 30-night average`)}"/>
      <rect x="${cx + 3}" y="${s.y(mine[i]).toFixed(1)}" width="${bw}" height="${(y1 - s.y(mine[i])).toFixed(1)}"
        rx="3" fill="${cs[i]}" data-tip="${esc(`${k.toUpperCase()} last night|${hm(mine[i])} · ${delta >= 0 ? "+" : ""}${delta}m vs baseline`)}"/>
      ${txt(cx, y1 + 17, k.toUpperCase(), { size: 11, anchor: "middle" })}`;
  });
  p += [0, hi / 2, hi].map((v) => txt(x0 - 8, s.y(v) + 4, Math.round(v) + "m")).join("");
  return svg(w, h, p, "Last night's stages against the 30-night average");
}

export function debtArea(D, days) {
  const n = days, w = 680, h = 152, x0 = 42, x1 = 666, y0 = 14, y1 = 116, i0 = D.debt.length - n;
  const v = D.debt.slice(i0).map((x) => (ok(x) ? x : 0));
  const hi = Math.max(...v, 60) * 1.1, s = scales(x0, x1, y0, y1, n, 0, hi);
  const line = v.map((x, i) => `${s.x(i).toFixed(1)},${s.y(x).toFixed(1)}`).join(" ");
  const p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]) +
    `<polygon points="${x0},${y1} ${line} ${x1},${y1}" fill="${col("rem")}" opacity=".22"/>
     <polyline points="${line}" fill="none" stroke="${col("rem")}" stroke-width="2" stroke-linejoin="round"/>` +
    hits(n, s, y0, y1, (i) => `${D.dates[i0 + i]}|${hm(v[i])} of debt`) +
    [0, hi / 2, hi].map((x) => txt(x0 - 7, s.y(x) + 4, hm(x))).join("");
  return svg(w, h, p, "Rolling sleep debt");
}

export function sleepColumns(D, days) {
  const n = days, w = 680, h = 202, x0 = 44, x1 = 666, y0 = 14, y1 = 164, i0 = D.dates.length - n;
  const s = scales(x0, x1, y0, y1, n, 0, 18 * 60), bw = Math.min(24, (x1 - x0) / n - 6);
  let p = grid(x0, x1, [y0, (y0 + y1) / 2, y1]);
  for (let i = 0; i < n; i++) {
    const j = i0 + i; if (!ok(D.asleep[j])) continue;
    const cx = s.x(i);
    let y = y1 - (D.asleep[j] / (18 * 60)) * (y1 - y0);
    for (const [k, c] of [["deep", col("deep")], ["light", col("light")], ["rem", col("rem")], ["awake", col("awake")]]) {
      const hh = ((D[k][j] || 0) / (18 * 60)) * (y1 - y0);
      p += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${Math.max(0, hh - 1).toFixed(1)}" fill="${c}"/>`;
      y += hh;
    }
    if (D.drinks[j]) p += `<circle cx="${cx.toFixed(1)}" cy="${y1 + 14}" r="4" fill="${col("drink")}"/>`;
  }
  p += hits(n, s, y0, y1 + 18, (i) => {
    const j = i0 + i;
    if (!ok(D.asleep[j])) return `${D.dates[j]}|no sleep recorded`;
    return `${D.dates[j]} · ${hm(D.asleep[j])}|REM ${hm(D.rem[j])} · deep ${hm(D.deep[j])}${D.drinks[j] ? `|${D.drinks[j]} drinks` : ""}`;
  });
  p += [0, 4, 8, 12].map((hh) => txt(x0 - 8, s.y(hh * 60) + 4, hh + "h")).join("");
  return svg(w, h, p, "Sleep duration and composition over recent nights");
}

export function sparkline(D, vals, color, days, unit) {
  const n = days, w = 680, h = 134, x0 = 44, x1 = 666, y0 = 14, y1 = 100, i0 = vals.length - n;
  const v = vals.slice(i0), cl = v.filter(ok);
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
    hits(n, s, y0, y1, (i) => {
      const j = i0 + i;
      return `${D.dates[j]}|${ok(v[i]) ? v[i] + " " + unit : "no data"}${D.drinks[j] ? `|after ${D.drinks[j]} drinks` : ""}`;
    }) + [lo, (lo + hi) / 2, hi].map((x) => txt(x0 - 8, s.y(x) + 4, Math.round(x) + " " + unit)).join("");
  return svg(w, h, p, `Trend over ${days} days`);
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

export function doseResponse(D) {
  const w = 680, h = 252, x0 = 52, x1 = 650, y0 = 16, y1 = 196;
  const { pts } = pctPoints(D);
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
    `<line x1="${x0}" y1="${Y(100)}" x2="${x1}" y2="${Y(100)}" stroke="${col("muted")}" stroke-width="1.25" stroke-dasharray="5 4" opacity=".8"/>
     ${txt(x1, Y(100) - 8, "your sober average", { size: 11 })}
     <line x1="${X(0)}" y1="${Y(b)}" x2="${X(maxD)}" y2="${Y(m * maxD + b)}" stroke="${col("drink")}" stroke-width="2" opacity=".75"
       data-tip="${esc(`fit|${m.toFixed(1)}% of baseline HRV per drink`)}"/>
     ${dots}<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${col("grid")}"/>` +
    Array.from({ length: maxD + 1 }, (_, d) => txt(X(d), y1 + 18, d, { anchor: "middle" })).join("") +
    [lo, 100, hi].map((v) => txt(x0 - 9, Y(v) + 4, Math.round(v) + "%")).join("") +
    txt((x0 + x1) / 2, h - 6, "standard drinks that night", { size: 11.5, anchor: "middle" });
  return svg(w, h, p, "Drinks against next-morning HRV as a percentage of baseline");
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
