// Pulse PWA.
//
// Renders the dashboard from whichever source is available:
//   Supabase   once nights/drinks are populated and you are signed in
//   demo.json  otherwise, or with ?demo=1
//
// Both paths run the identical chart code in charts.js. That is deliberate:
// the preview and the app cannot drift, because there is only one renderer.
//
// The dashboard is scoped to ONE NIGHT at a time (dayIdx), stepped with the
// header's ‹ › controls. Everything the Day tab and its card-detail overlays
// draw comes out of the arrays already loaded for the whole 45-night window,
// so stepping is a re-render and never a fetch.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm";
import * as ch from "./charts.js";

// The offline preview (build-preview.mjs) inlines the fixture here rather
// than serving a file, so the same code path runs in both.
const demoData = () => window.__PULSE_DEMO__ ?? fetch("./demo.json").then((r) => r.json());

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll(".screen")) s.hidden = true;
  $(id).hidden = false;
};
const { hm, ok, col, ZONE } = ch;

// Recovery Load: 0/1/2 = settled / elevated / high (bands 0.5, 1.0 -- mirror
// metrics.load_state). The strain ceiling mirrors metrics.strain_ceiling +
// STRAIN_CEILING_LOAD_CAP: an elevated/high load hard-caps it because the
// recovery score can't see skin temp or breathing.
const LOAD_WORD = ["settled", "elevated", "high"];
const loadStateOf = (v) => (!ok(v) ? NaN : v < 0.5 ? 0 : v < 1.0 ? 1 : 2);
const ceilingWithLoad = (rec, st) => {
  const c = 6 + 0.09 * rec;
  return st === 2 ? Math.min(c, 8) : st === 1 ? Math.min(c, 11) : c;
};

// Module-level, not local to render(): renderTrendCharts() (the range-toggle
// handler) rebuilds part of the Trends tab independently of a full render(),
// and needs the same markup helpers -- one definition, not a second copy that
// could quietly drift from the first.
// `detail`, when given, turns the tile into a button opening the matching
// card-detail overlay (see openDetail below) instead of a plain div.
const kpi = (c, cap, sub, detail) => detail
  ? `<button type="button" class="kpi" data-detail="${detail}">${c}<p class="cap">${cap}</p><p class="sub">${sub}</p></button>`
  : `<div class="kpi">${c}<p class="cap">${cap}</p><p class="sub">${sub}</p></div>`;
const stat = (v, k, c) => `<div class="stat"><div class="v"${c ? ` style="color:${c}"` : ""}>${v}</div><div class="k">${k}</div></div>`;

// Which overnight markers moved against baseline, as short phrases. Uses the
// same "past a floor" gates as metrics.recovery_load so the text matches what
// actually drove the number.
function loadMarkers(t) {
  const b = [];
  if (ok(t.skinTempDelta) && Math.abs(t.skinTempDelta) >= 0.15)
    b.push(`skin temp ${t.skinTempDelta > 0 ? "+" : ""}${t.skinTempDelta.toFixed(1)}°C`);
  // Prefer the deep-sleep RMSSD lens -- what recovery_load now uses for the HRV
  // marker -- and fall back to the all-night average when it has no baseline.
  if (ok(t.hrvDeepPct) && t.hrvDeepPct < 92)
    b.push(`deep-sleep HRV ${Math.round(t.hrvDeepPct)}% of normal`);
  else if (ok(t.hrv) && ok(t.hrvBaseline) && t.hrv < t.hrvBaseline * 0.92)
    b.push(`HRV ${Math.round((t.hrv / t.hrvBaseline) * 100)}% of normal`);
  if (ok(t.rhrDelta) && t.rhrDelta >= 2) b.push(`resting HR +${Math.round(t.rhrDelta)}`);
  if (ok(t.respRateDelta) && t.respRateDelta >= 0.5) b.push(`breathing +${t.respRateDelta.toFixed(1)}`);
  return b;
}

// The Recovery Load status bar under the three dials -- one line every day the
// signal exists, colour = state, expands with the contributing markers when
// elevated/high and reconciles against the drink log. Taps into the Recovery
// detail. Empty when there's no body_load yet (early nights, pre-migration).
function loadBar(t) {
  if (!ok(t.bodyLoad) || !Number.isInteger(t.loadState)) return "";
  const s = t.loadState;
  const bits = loadMarkers(t);
  const why = s === 0 ? "" : bits.length ? ` — ${bits.join(" · ")}` : "";
  const drink = t.drinks
    ? (s === 0 ? ` · ${t.drinks} drink${t.drinks > 1 ? "s" : ""}, no lasting hit`
      : ` · ${t.drinks} drink${t.drinks > 1 ? "s" : ""} — expected`)
    : (s > 0 ? " · nothing logged" : "");
  return `<button type="button" class="loadbar l${s}" data-detail="recovery">
    <span class="lb-dot"></span><span class="lb-txt">Recovery load: <b>${LOAD_WORD[s]}</b>${why}${drink}</span></button>`;
}
// ------------------------------------------------------------------- naps
// A nap is a sleep session that is not the day's main sleep. push.py stores it
// in the same shape as a night -- clock start/end, minutes asleep, stage offsets
// from its own start -- so it draws with the night's own hypnogram. Naps are
// filed under the civil day they started on, which is the row (D.dates[i]) whose
// Day tab shows that afternoon.
//
// Naps are kept apart from sleep: nothing here adds a nap's minutes to the
// night's. metrics.py counts them toward sleep debt and nothing else -- not the
// night, its score, or recovery (cfg.NAPS_COUNT_TOWARD_DEBT). The Sleep detail
// says so, because a nap that appears without moving the score would otherwise
// look like a bug.
const napTime = (n) => `${ch.clock12(ch.mins(n.start))} – ${ch.clock12(ch.mins(n.end))}`;
// "46m" under an hour, "2h 26m" over -- hm() alone reads "0h 46m".
const shortDur = (m) => (m < 60 ? `${Math.round(m)}m` : hm(m));
const stageMin = (n, type) => (n.stages || []).filter((s) => s.t === type).reduce((a, s) => a + s.b - s.a, 0);
// Same object hypnoFrom() builds for a night, minus the heart-rate floor: that is
// a whole-night measure and means nothing over a two-hour nap.
const napHypno = (n) => n.stages?.length
  ? { start: n.start, span: Math.max(...n.stages.map((s) => s.b)), segs: n.stages, nadirMin: NaN, nadirBpm: NaN }
  : null;

// One line on the Day tab, under the dials, in the loadbar's own idiom. Taps
// into the Sleep detail where the naps are drawn.
function napBar(naps) {
  if (!naps.length) return "";
  const total = naps.reduce((a, n) => a + n.min, 0);
  const what = naps.length === 1 ? `Nap <b>${napTime(naps[0])}</b>` : `<b>${naps.length} naps</b>`;
  return `<button type="button" class="loadbar nap" data-detail="sleep">
    <span class="lb-dot"></span><span class="lb-txt">${what} · ${shortDur(total)} asleep</span></button>`;
}

// One card per nap, then a single line on how they are counted.
function napCards(naps) {
  if (!naps.length) return "";
  return naps.map((n) => {
    const hyp = napHypno(n);
    const parts = [`<b>${shortDur(n.min)}</b> asleep of ${shortDur(n.in_bed)} in bed`];
    if (hyp) parts.push(`deep ${shortDur(stageMin(n, "DEEP"))}`, `REM ${shortDur(stageMin(n, "REM"))}`);
    return card(`Nap — ${napTime(n)}`, ch.hypnogram(W, hyp, 200), parts.join(" · "));
  }).join("") + `<p class="note" style="margin:-4px 2px 16px">Naps are shown on their own — they are not part of your sleep time, Sleep Score or recovery. Their minutes do count toward sleep debt.</p>`;
}

// Scrubbable charts get a readout row between the title and the chart: the
// values land THERE rather than in a bubble under your thumb. On a phone the
// floating tooltip was the whole problem -- the finger covers the number it
// just asked for, and lifting it takes the answer away with it.
// The steppers are the reason a phone does not need the drag to work. Tapping
// a chart has always selected the right band on iOS -- it is only movement the
// platform withholds -- so tap picks the neighbourhood and these walk it one
// sample at a time, without a finger sitting on top of the chart.
const stepper =
  `<span class="stepper"><button type="button" class="step" data-step="-1" aria-label="Previous sample">&lsaquo;</button>` +
  `<button type="button" class="step" data-step="1" aria-label="Next sample">&rsaquo;</button></span>`;
const card = (ttl, inner, note, scrub = true) => {
  const hasScrub = /data-scrub/.test(inner);
  return `<div class="card"><h2>${ttl}</h2>${scrub ? `<div class="readrow"><p class="readout" aria-live="polite"></p>${hasScrub ? stepper : ""}</div>` : ""}
   <div class="chartbox${hasScrub ? " scrubbable" : ""}">${inner}</div>${note ? `<p class="note">${note}</p>` : ""}</div>`;
};

// Recovery and Sleep Score rings share one colour scale -- green, amber, red --
// and one red line, so a bad night reads the same on both. Only the green
// cutoff differs: a sleep score has to reach 80 to count as good.
const RING_RED_BELOW = 34;
const RING_GOOD = { recovery: 67, sleep: 80 };
const ringCol = (v, good) => (v >= good ? col("good") : v >= RING_RED_BELOW ? col("awake") : col("warn"));

let sb = null, DATA = null, isDemo = false;

// Which night the Day tab is showing. -1 until data lands, then pinned to
// the newest night; the ‹ › controls and the swipe gesture move it.
let dayIdx = -1;

// Chart width in CSS pixels, measured not assumed -- charts.js authors its
// viewBox at exactly this so 1 unit = 1 real pixel. See the header comment
// there for why that matters more than it sounds like it should.
let W = 680;

// The 4am night boundary and every clock label are computed in this zone. It
// comes from the server (PULSE_TZ) so the browser's own zone -- which is wrong
// the moment you travel -- never decides which night a drink belongs to.
let tz = "America/Chicago";

// --------------------------------------------------------------- geometry
// .card is 18px of padding plus a 1px border on each side. Measuring #dash
// rather than hardcoding a breakpoint means an iPad in split view, a desktop
// window being dragged narrower and a phone in landscape all get a chart sized
// to what is actually on screen.
const CARD_INSET = 38;
function chartWidth() {
  // Measure a real chartbox once one exists, so the constant above is only
  // ever load-bearing for the very first render. Anything that changes card
  // padding later self-corrects on the next resize instead of silently
  // authoring every viewBox at the wrong scale.
  const box = document.querySelector("#dash .card .chartbox");
  if (box?.clientWidth) return Math.round(box.clientWidth);
  const outer = $("dash").clientWidth || Math.min(760, innerWidth - 32);
  return Math.max(260, Math.round(outer - CARD_INSET));
}
const isNarrow = () => ch.narrow(W);
// Step-axis labels. The old formatter was (v/1000).toFixed(0)+"k", which printed
// the zero baseline as "0k" and collapsed a low-step window's whole axis to
// "0k 0k 0k".
const kfmt = (v) => (v >= 1000 ? Math.round(v / 1000) + "k" : String(Math.round(v)));
/** Window length for a fixed-range card: shorter on a phone, never longer than the data. */
const win = (D, wide, narrow) => Math.max(2, Math.min(isNarrow() ? narrow : wide, D.dates.length));

// ------------------------------------------------------------------ tooltip
// One delegated listener for every non-scrubbable mark on the page. Charts opt
// in by putting data-tip on an element. Marks inside a scrubbable chart are
// deliberately excluded -- those feed the pinned readout instead, and showing
// both would put two copies of the same number on screen.
const tip = Object.assign(document.createElement("div"), { className: "tip" });
tip.hidden = true;
document.body.appendChild(tip);

function moveTip(e, el) {
  const lines = el.getAttribute("data-tip").split("|");
  tip.innerHTML = "";
  lines.forEach((l, i) => {
    const s = document.createElement("span");
    s.className = i ? "d" : "h";
    s.textContent = l;
    tip.appendChild(s);
  });
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - r.width / 2, 8), innerWidth - r.width - 8);
  const y = e.clientY - r.height - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y < 8 ? e.clientY + 18 : y}px`;
}
const tipTarget = (e) => {
  const el = e.target.closest?.("[data-tip]");
  return el && !el.closest("svg[data-scrub]") ? el : null;
};
function bindTips(root) {
  root.addEventListener("pointermove", (e) => {
    const el = tipTarget(e);
    if (el) moveTip(e, el); else tip.hidden = true;
  });
  root.addEventListener("pointerleave", () => { tip.hidden = true; });
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    const el = tipTarget(e);
    if (el) moveTip(e, el); else tip.hidden = true;
  });
}

// ------------------------------------------------------------------ scrubber
// Drag anywhere across a chart and a crosshair follows your finger while the
// values land in the card's readout row -- the touch replacement for hover.
//
// The contract with charts.js: the <svg> carries data-scrub, and every sample
// has a `rect[data-i]` hit band carrying data-x (centre, in user units),
// optional data-y (the mark, for the cursor dot) and data-tip (the text).
// Nothing here re-derives a scale, so the crosshair cannot drift from the marks.
// ---- touch diagnostics, behind ?debug ------------------------------------
// Prints what a phone actually does (gestures, viewport, the tab bar's position),
// which a desktop browser cannot reproduce. Inert unless switched on. ?debug does
// it in a browser tab; the installed home-screen app has no address bar and a
// storage partition of its own, so there five taps on the date stamp toggle it,
// and the choice is kept in localStorage.
const DBG_KEY = "pulse-debug";
const stickyDbg = () => { try { return localStorage.getItem(DBG_KEY) === "1"; } catch { return false; } };
let DBG = new URLSearchParams(location.search).has("debug") || stickyDbg();
let brandTaps = 0, brandTimer = null;
addEventListener("click", (e) => {
  if (!e.target.closest?.("#stamp")) return;
  clearTimeout(brandTimer);
  brandTimer = setTimeout(() => { brandTaps = 0; }, 2000);
  if (++brandTaps < 5) return;
  brandTaps = 0;
  DBG = !DBG;
  try { localStorage.setItem(DBG_KEY, DBG ? "1" : "0"); } catch { /* private mode */ }
  if (DBG) dbg(`debug ON ${CTX} | BUILD ${BUILD} | tap the date 5x to stop`);
  else if (dbgBox) { dbgBox.remove(); dbgBox = null; }
});
// Labels this bundle in the debug log, next to the commit /api/config reports, so
// a stale cached bundle is visible instead of inferred. Bump it by hand when two
// bundles need telling apart.
const BUILD = "scrubber-fixed";
let dbgBox = null;
function dbg(line) {
  if (!DBG) return;
  if (!dbgBox) {
    dbgBox = document.createElement("pre");
    dbgBox.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:9999;max-height:40vh;overflow:auto;" +
      "margin:0;padding:8px;background:rgba(0,0,0,.88);color:#3FD68A;" +
      "font:11px/1.35 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap";
    document.body.appendChild(dbgBox);
  }
  dbgBox.textContent = (line + "\n" + dbgBox.textContent).slice(0, 3000);
}

function bandsOf(svgEl) {
  if (!svgEl._bands) {
    svgEl._bands = [...svgEl.querySelectorAll("rect[data-i]")];
    svgEl._xs = svgEl._bands.map((b) => +b.dataset.x);
  }
  return svgEl._bands;
}

function writeReadout(svgEl, tipText, live) {
  const box = svgEl.closest(".card")?.querySelector(".readout");
  if (!box) return;
  // One <b> for the head, one <span> for everything after it, with the
  // separators baked into the text. Was one <span> per segment, each drawing
  // its " * " from a ::before -- see the note in styles.css for why that had
  // to go.
  const seg = String(tipText).split("|");
  const parts = seg.length > 1 ? [seg[0], seg.slice(1).map((t) => " \u00b7 " + t).join("")] : [seg[0]];

  // Update the existing nodes IN PLACE instead of destroying and recreating
  // them. A drag calls this on every move -- up to 60x a second -- and the old
  // version cleared the box and built fresh <b>/<span> elements each time,
  // inside an aria-live region, mid-gesture. On device the readout has been
  // seen updating its date while the value stayed on a number from an earlier
  // touch, which is what a half-applied rebuild looks like. Nothing needs
  // rebuilding when only the text differs.
  if (box.childElementCount !== parts.length) {
    box.textContent = "";
    for (let i = 0; i < parts.length; i++) {
      box.appendChild(document.createElement(i ? "span" : "b"));
    }
  }
  for (let i = 0; i < parts.length; i++) {
    const el = box.children[i];
    if (el.textContent !== parts[i]) el.textContent = parts[i];
  }
  box.classList.toggle("live", !!live);
}

function setScrub(svgEl, idx, live = true) {
  const bands = bandsOf(svgEl), b = bands[idx];
  if (!b) return;
  svgEl._i = idx;                         // where the steppers step from
  const g = svgEl.querySelector(".scrubg");
  if (g && live) {
    g.removeAttribute("hidden");
    const x = b.dataset.x;
    const cross = g.querySelector(".cross");
    cross.setAttribute("x1", x); cross.setAttribute("x2", x);
    const dot = g.querySelector(".cursor");
    if (b.dataset.y) {
      dot.setAttribute("cx", x); dot.setAttribute("cy", b.dataset.y); dot.setAttribute("opacity", "1");
    } else dot.setAttribute("opacity", "0");
  }
  writeReadout(svgEl, b.getAttribute("data-tip"), live);
}

function scrubAt(svgEl, clientX) {
  const bands = bandsOf(svgEl);
  if (!bands.length) return dbg("scrubAt: NO BANDS");
  const r = svgEl.getBoundingClientRect();
  if (!r.width) return dbg("scrubAt: rect width 0 (detached?)");
  // Pointer x -> user units. viewBox width is the chart's own coordinate space,
  // which equals its CSS width by construction but is read rather than assumed
  // so a mid-resize render cannot put the crosshair somewhere else.
  const ux = ((clientX - r.left) / r.width) * svgEl.viewBox.baseVal.width;
  let best = 0, bd = Infinity;
  svgEl._xs.forEach((x, i) => { const d = Math.abs(x - ux); if (d < bd) { bd = d; best = i; } });
  setScrub(svgEl, best);
}

// Safari tab or installed home-screen app? iOS runs those in different
// contexts with different gesture recognizers, and every device log so far was
// taken without recording which one produced it. It is one string; print it.
const CTX = matchMedia("(display-mode: standalone)").matches ||
            navigator.standalone ? "[PWA]" : "[tab]";

function bindScrub(root) {
  let drag = null, sx = 0, sy = 0, lx = 0, ly = 0;
  let nPointer = 0, nTouch = 0;          // per-gesture, reset on every start
  let gesture = false;                   // did this touch start on a chart?
  let what = "";                         // which chart, for the one log line

  // Consumes BOTH event streams (pointer and touch); scrubAt is idempotent, so
  // being driven twice for one movement costs a redundant index lookup.
  //
  // No axis arbitration, on purpose: a drag that starts on a chart is the
  // scrubber's for its whole life (touch-action:none, so the page cannot scroll
  // from a chart anyway). Releasing the drag on vertical travel looks safe but
  // is not -- a thumb pivots as it lands, so a deliberate sideways drag can read
  // dy=30 before dx=10 and would be cancelled ~40ms in.
  const begin = (svgEl, x, y) => {
    drag = svgEl; sx = lx = x; sy = ly = y; gesture = true;
    if (DBG) what = `${svgEl.dataset.scrub}/${bandsOf(svgEl).length}`;
    nPointer = 0; nTouch = 0;            // per gesture, reset on every start
    scrubAt(svgEl, x);
  };

  const move = (x, y) => {
    if (!drag) return;
    lx = x; ly = y;
    scrubAt(drag, x);
  };

  // Logs EVERY gesture that started on a chart and the distance it actually
  // moved, not only the ones still holding a drag at the end -- a log that can
  // only report the outcome it is looking for is worse than none.
  const end = (why) => {
    if (gesture) {
      dbg(`${why}: ${what} moves p=${nPointer} t=${nTouch} ` +
          `travel dx=${(lx - sx) | 0} dy=${(ly - sy) | 0} ${CTX}`);
    }
    gesture = false; drag = null;
  };

  root.addEventListener("pointerdown", (e) => {
    const s = e.target.closest?.("svg[data-scrub]");
    if (!s) return;
    begin(s, e.clientX, e.clientY);
  });

  addEventListener("pointermove", (e) => {
    if (drag) { nPointer++; move(e.clientX, e.clientY); return; }
    if (e.pointerType !== "mouse") return;
    const s = e.target.closest?.("svg[data-scrub]");
    if (s) scrubAt(s, e.clientX);         // desktop hover
  }, { passive: true });

  // Non-passive so it can preventDefault: on iOS that is what stops a
  // press-and-drag from becoming a scroll or a selection once the gesture is
  // ours. Also a second chance at the movement when pointermove stays silent.
  root.addEventListener("touchmove", (e) => {
    if (!drag) return;
    nTouch++;                             // counted before any guard
    const t = e.touches[0];
    if (!t) return;
    if (e.cancelable) e.preventDefault();
    move(t.clientX, t.clientY);
  }, { passive: false });

  // Claim the gesture at touchstart, non-passively. preventDefault() on a
  // NON-PASSIVE touchstart is what tells WebKit the touch sequence belongs to the
  // page; touch-action only covers scrolling and zooming, not the selection,
  // callout and drag recognizers, and preventDefault is a no-op on a passive
  // listener.
  //
  // Cost: the synthesized click on a chart is suppressed. Nothing binds click on
  // a chart (scrubbing runs off pointerdown), and the steppers sit outside
  // .chartbox and keep their clicks.
  root.addEventListener("touchstart", (e) => {
    const s = e.target.closest?.("svg[data-scrub]");
    if (!s) return;
    if (e.cancelable) e.preventDefault();
    if (drag) return;                     // pointerdown already handled it
    const t = e.changedTouches[0];
    begin(s, t.clientX, t.clientY);
  }, { passive: false });

  // Delegated: cards are rebuilt by every render, so a handler per button
  // would leak one set per re-render. Click (not pointerdown) because these
  // are ordinary buttons and should repeat on key-activation too.
  root.addEventListener("click", (e) => {
    const b = e.target.closest?.(".step");
    if (!b) return;
    const svgEl = b.closest(".card")?.querySelector("svg[data-scrub]");
    if (!svgEl) return;
    const n = bandsOf(svgEl).length;
    if (!n) return;
    const cur = svgEl._i ?? n - 1;
    setScrub(svgEl, Math.max(0, Math.min(n - 1, cur + Number(b.dataset.step))));
  });

  addEventListener("pointerup", () => end("pointerup"));
  addEventListener("pointercancel", () => end("pointercancel"));
  addEventListener("touchend", () => end("touchend"));
  addEventListener("touchcancel", () => end("touchcancel"));
}

// Every scrubbable chart starts showing its newest sample, so the readout row
// is never an empty band of space waiting to be earned. The crosshair stays
// hidden until touched -- the number is useful unprompted, a line across the
// chart is not.
function primeReadouts(root) {
  // Date-indexed charts prime to THE SELECTED DAY, not to their newest bar.
  // Priming to the newest put a different date in the readout from the one in
  // the tiles above it -- step back a day and the stats said Sep 2 while the
  // steps chart said Sep 3. Two dates on one screen with nothing saying which
  // was which, which is how a full 24h of yesterday gets read as a clock
  // running fast. They all end on the newest night, so the selected day is
  // simply that many bands back from the right edge.
  const back = DATA ? DATA.dates.length - 1 - dayIdx : 0;
  for (const s of root.querySelectorAll("svg[data-scrub]")) {
    const bands = bandsOf(s);
    if (!bands.length) continue;
    const idx = s.dataset.scrub === "day"
      ? Math.max(0, bands.length - 1 - back)   // clamped: the day may predate this window
      : bands.length - 1;                       // time-indexed (heart rate): latest sample
    setScrub(s, idx, false);
  }
}

// -------------------------------------------------------------------- swipe
// Secondary to the ‹ › buttons, never the only way to do anything. Deliberately
// strict: 64px of travel and twice as much horizontal as vertical, or a thumb
// drifting during a normal scroll would throw you onto another night.
// A detail screen is mostly scrub charts (every trend line, the hypnogram,
// the bars) -- excluding svg[data-scrub] below means an ordinary swipe over
// almost any of it never reaches this handler at all, it just scrubs the
// chart underneath the finger. Restricting the close-swipe to a touch that
// STARTS within this many px of the left edge sidesteps the conflict rather
// than trying to out-arbitrate it: .detail's own padding (16px) plus every
// .card's (18px) already keeps chart content clear of this margin, so nothing
// exclusive to charts is ever within it, and it mirrors the system edge-back
// gesture every phone user already has muscle memory for.
const CLOSE_EDGE_PX = 28;

// Whichever full-screen overlay is actually on top, or null. #workout-day can
// be open OVER #detail (a workout row inside the Strain detail opens it), so
// it takes priority -- closing the TOPMOST screen is the only thing "back"
// can mean when two are stacked.
const topOverlay = () => (!$("day-picker").hidden ? $("day-picker") : !$("drinks-day").hidden ? $("drinks-day") : !$("workout-day").hidden ? $("workout-day") : !$("detail").hidden ? $("detail") : null);
const closeTopOverlay = () => (!$("day-picker").hidden ? closeDayPicker() : !$("drinks-day").hidden ? closeDrinksDay() : !$("workout-day").hidden ? closeWorkoutDay() : closeDetail());

// Logged the same way bindScrub's gestures are (see dbg() above): every
// attempt, not just the ones that end up qualifying. The scrubber bug looked
// completely different from every angle reasoned about it in advance and was
// only found by reading a log of what iOS actually delivered -- no reason to
// assume this gesture is any more predictable in advance than that one was.
function bindSwipe(root) {
  let sx = 0, sy = 0, sTop = 0, sDTop = 0, live = false;
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    if (e.target.closest?.("svg[data-scrub], button, a, input")) return;
    const ov = topOverlay();
    if (ov && e.clientX > CLOSE_EDGE_PX) {
      if (DBG) dbg(`swipe rejected: x=${e.clientX} > edge ${CLOSE_EDGE_PX} ${CTX}`);
      return;
    }
    sx = e.clientX; sy = e.clientY; sTop = scrollY; sDTop = ov ? ov.scrollTop : 0; live = true;
    if (DBG) dbg(`swipe start: x=${sx} y=${sy} overlay=${ov ? ov.id : "none"} ${CTX}`);
  });
  // iOS hands a gesture to its own scroller and CANCELS our pointer rather than
  // ending it. Without this the flag stayed set, and a later, unrelated
  // pointerup got measured against a stale start point -- which silently
  // stepped the day. That is how you end up reading yesterday without having
  // touched the date control.
  root.addEventListener("pointercancel", () => {
    if (DBG && live) dbg(`swipe cancelled ${CTX}`);
    live = false;
  });
  root.addEventListener("pointerup", (e) => {
    if (!live) return;
    live = false;
    // If the page moved under the finger, that was a scroll, whatever the net
    // horizontal distance ended up being. Cheaper and far more reliable than
    // trying to out-guess the gesture from dx/dy alone. Two scroll containers
    // share this root -- the page behind, and whichever overlay's own
    // overflow-y when one is open -- so both are checked; only one is ever
    // actually moving.
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const ov = topOverlay();
    const scrolled = Math.abs(scrollY - sTop) > 8 || (ov && Math.abs(ov.scrollTop - sDTop) > 8);
    if (DBG) dbg(`swipe end: dx=${dx | 0} dy=${dy | 0} scrolled=${scrolled} ${CTX}`);
    if (scrolled) return;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 2) return;
    // A full-screen overlay is not a day -- a qualifying swipe closes the
    // topmost one (any direction: there is nowhere else for it to go) rather
    // than falling through to the day stepper underneath it.
    if (ov) return closeTopOverlay();
    if (currentTab() === "trends") return;
    setDay(dayIdx + (dx < 0 ? 1 : -1));
  });
}

const currentTab = () => document.querySelector(".tab[aria-selected='true']")?.dataset.tab || "today";

// --------------------------------------------------------------------- boot
async function boot() {
  const params = new URLSearchParams(location.search);
  // Which bundle am I actually running? Printed FIRST and unconditionally
  // under ?debug, before any branch. It used to live inside the live-data
  // path, so ?demo=1&debug -- the link you hand someone to reproduce a bug --
  // was the one mode that never said. "Is this even the new code?" is the
  // first question every round of this bug has had to answer.
  if (DBG) dbg(`BUILD ${BUILD} | ${CTX}`);

  if (!params.has("demo")) {
    try {
      const cfg = await fetch("/api/config").then((r) => r.json());
      if (!cfg.error) {
        if (cfg.tz) tz = cfg.tz;
        // Deliberately a second, cache-busted request rather than reading
        // cfg.commit: /api/config sets max-age=3600 (its own header beats
        // vercel.json's no-store), so the cached copy could report an
        // hour-old commit -- exactly the ambiguity this is meant to remove.
        if (DBG) {
          fetch(`/api/config?nocache=${Date.now()}`, { cache: "no-store" })
            .then((r) => r.json())
            .then((c) => dbg(`BUILD ${BUILD} | server ${c.commit || "?"} | ${CTX}`))
            .catch(() => dbg(`BUILD ${BUILD} | server unreachable`));
        }
        sb = createClient(cfg.url, cfg.anonKey);
        const { data } = await sb.auth.getSession();
        if (!data.session) return show("signin");
        const live = await loadLive();
        if (live) { DATA = normalize(live); return render(); }
      }
    } catch { /* fall through to demo */ }
  }

  isDemo = true;
  DATA = normalize(await demoData());
  render();
}

// Fill in the per-night arrays the day stepper needs, for any source that does
// not already carry them. loadLive() does; demo.json does not -- the fixture
// holds one `curve` and one `hypno`, for its newest night only (39 more would
// bloat the file 30x), so the older nights get an empty curve and the chart
// says so. The drink and workout detail, though, IS carried per night in the
// fixture's `*_nights` arrays so the Drinks and Workouts calendars aren't a
// single lit cell -- older `pulse demo` fixtures without them still work via
// the newest-night-only fallback.
function normalize(D) {
  const n = D.dates.length, last = n - 1;
  const only = (v) => Array.from({ length: n }, (_, i) => (i === last ? v : null));
  const rows = (list) => (list || []).map((r) => ({ ...r, logged_at: new Date(r.logged_at) }));

  D.curves ??= only(D.curve || []).map((v) => v || []);
  D.hypnos ??= only(D.hypno || null);
  D.drinkTimes ??= D.drink_times_nights
    ? D.drink_times_nights.map((v) => v || [])
    : only(D.drink_times || []).map((v) => v || []);
  D.drinkRows ??= D.drink_rows_nights
    ? D.drink_rows_nights.map(rows)
    : only(rows(D.drink_rows)).map((v) => v || []);
  D.workouts ??= D.workout_nights
    ? D.workout_nights.map((v) => v || [])
    : only(D.workout_list || []).map((v) => v || []);
  // A fixture from before naps existed has no nap_nights: no naps, not an error.
  D.naps ??= D.nap_nights ? D.nap_nights.map((v) => v || []) : D.dates.map(() => []);

  for (const k of ["inBed", "need", "hrvBaseline", "bodyLoad", "loadState",
                   "skinTempDelta", "respRate", "respRateDelta", "rhrDelta",
                   "hrvDeep", "hrvDeepBaseline", "hrvDeepPct", "nonRemHr",
                   "spo2Min"]) D[k] ??= [];
  // Not indexed by D.dates -- a flat list of the current drinking-night's
  // drinks, so it is not touched by trimInProgressNight below.
  D.tonight ??= [];
  // Derive loadState from bodyLoad if a fixture carried only the raw score.
  if (Array.isArray(D.bodyLoad) && (!Array.isArray(D.loadState) || !D.loadState.length)) {
    D.loadState = D.bodyLoad.map(loadStateOf);
  }
  // Strain ceiling is a pure function of recovery + load state, so always
  // (re)derive it here -- loadLive supplies its own, an old fixture may carry
  // a stale or load-blind one.
  D.target = (D.recovery || []).map((v, i) =>
    (ok(v) ? +ceilingWithLoad(v, D.loadState[i]).toFixed(1) : NaN));
  // Drinks regrouped by drinking night for the Drinks calendar and its day
  // sheet. BEFORE trimInProgressNight on purpose: a 1am drink is filed on the
  // civil-day placeholder row that is about to be dropped, and has to reach the
  // night it belongs to first.
  groupByNight(D);
  return trimInProgressNight(D);
}

// night_summary FULL OUTER JOINs nights with drinks (schema.sql), so a night
// still in progress -- drinks already logged tonight, no nights row synced
// yet -- shows up as the newest row in D.dates with every n.* column null.
// Left in place, that row silently becomes "the latest night" everywhere:
// the Day tab defaults onto a blank dashboard, the Workouts/Drinks calendars
// default to browsing a month that may not even be this one, "latest" stops
// matching D.dates.length - 1 so the pastbar wrongly reads "tap for latest"
// on the actual latest real night, and every trend chart grows a trailing
// empty day. Dropping it here, once, at the source fixes all of those at
// once instead of teaching each of them to recognize it individually.
// Nothing is lost: the Drinks tab gets tonight's count from the drinks
// table directly, keyed by civil day (see loadLive()'s drinkRows comment),
// not from this per-night rollup -- so tonight's drinks still show up
// under today's own, now-real row.
function trimInProgressNight(D) {
  const last = D.dates.length - 1;
  if (last <= 0 || ok(D.strain[last])) return D;
  for (const k of ["dates", "hrv", "rhr", "rem", "deep", "light", "awake", "asleep",
                   "inBed", "need", "hrvBaseline", "debt", "score", "recovery", "strain",
                   "steps", "drinks", "target", "curves", "hypnos",
                   "bodyLoad", "loadState", "skinTempDelta", "respRate", "respRateDelta", "rhrDelta",
                   "hrvDeep", "hrvDeepBaseline", "hrvDeepPct", "nonRemHr", "spo2Min",
                   "workouts", "naps", "drinkTimes", "drinkRows",
                   "nightRows", "nightTimes", "nightFirst", "nightLast"]) {
    if (Array.isArray(D[k])) D[k].pop();
  }
  D.z.forEach((zone) => zone.pop());
  return D;
}

// Pull the last 45 nights out of night_summary and shape them exactly like
// demo.json, so render() and every chart stay source-agnostic. Returns null
// when the sync has not populated anything yet.
//
// Two queries, not one: night_summary aggregates drinks to a count, but the
// heart-rate chart needs each drink's clock time to place its marker.
async function loadLive() {
  // DESC + limit to get the 45 MOST RECENT nights, then flip back to
  // ascending -- everything below assumes oldest-first (data[data.length-1]
  // as "latest", D.dates as an ascending timeline). Querying ascending with
  // a limit instead returns the 45 OLDEST nights: harmless while the table
  // had <=45 rows, but the moment it passed 45 the newest night silently
  // stopped coming back at all, and it would fall one more day behind for
  // every day past that. Not the trimInProgressNight placeholder logic --
  // the real row never reached the client to begin with.
  const { data: desc, error } = await sb
    .from("night_summary").select("*").order("night", { ascending: false }).limit(45);
  const data = desc ? [...desc].reverse() : desc;
  if (error || !data?.length) return null;

  // Number(null) is 0, not NaN -- a bare Number() on a not-yet-computed column
  // (today's sleep score before tonight has happened) would read as a real
  // zero and silently defeat every ok()/NaN guard downstream. n1 is the same
  // null-preserving coercion as the array version below, for scalars.
  const n1 = (v) => (v == null ? NaN : Number(v));
  const num = (k) => data.map((r) => n1(r[k]));
  const last = data[data.length - 1];

  // zone_min arrives as one array per night; the charts want one array per zone.
  const z = [0, 1, 2, 3, 4].map((i) =>
    data.map((r) => (Array.isArray(r.zone_min) ? Number(r.zone_min[i]) || 0 : 0)));

  // Recovery Load: an overnight anomaly flag (metrics.recovery_load, stored).
  // 0/1/2 = settled / elevated / high; bands are 0.5 and 1.0. loadState and the
  // strain ceiling derived from it are (re)computed in normalize().
  const rec = num("recovery");
  const bodyLoad = num("body_load");

  const D = {
    dates: data.map((r) => r.night),
    hrv: num("hrv_rmssd"), rhr: num("rhr"),
    rem: num("rem_min"), deep: num("deep_min"), light: num("light_min"),
    awake: num("waso_min"), asleep: num("total_sleep_min"),
    inBed: num("in_bed_min"), need: num("sleep_need_min"),
    hrvBaseline: num("hrv_baseline"),
    debt: num("sleep_debt_min"), score: num("sleep_score"),
    recovery: rec, strain: num("strain"), steps: num("steps"),
    drinks: data.map((r) => Number(r.drinks || 0)),
    z,
    bodyLoad, loadState: bodyLoad.map(loadStateOf),
    skinTempDelta: num("skin_temp_delta"), respRate: num("resp_rate"),
    respRateDelta: num("resp_rate_delta"), rhrDelta: num("rhr_delta"),
    // migration 002: the deep-sleep HRV lens, non-REM HR, SpO2 floor. The view
    // also carries hrv_deep_rmssd's raw value, non_rem_hr_delta, spo2_drop and
    // spo2_sd (stored for later) and hr_nadir_min_baseline / nadir_delay_min
    // (parked as too noisy -- see METRICS.md); the PWA reads only these.
    hrvDeep: num("hrv_deep_rmssd"), hrvDeepBaseline: num("hrv_deep_baseline"),
    hrvDeepPct: num("hrv_deep_pct_baseline"),
    nonRemHr: num("non_rem_hr"),
    spo2Min: num("spo2_min"),
    hrmax: Number(last.hrmax) || 192,
    // Per night, not just the newest one: hr_curve and stages are columns on
    // every row of night_summary and are already in this response (select "*"),
    // so browsing back through nights costs nothing beyond the render.
    curves: data.map((r) => (Array.isArray(r.hr_curve) ? r.hr_curve : [])),
    hypnos: data.map(hypnoFrom),
    workouts: data.map((r) => (Array.isArray(r.workouts) ? r.workouts : [])),
    // Naps that started that civil day (push.py's `naps` column). Absent from a
    // row synced before migration 003, hence the guard rather than an assumption.
    naps: data.map((r) => (Array.isArray(r.naps) ? r.naps : [])),
    drinkTimes: data.map(() => []),
    drinkRows: data.map(() => []),
  };

  // One query for every drink in the window rather than one per night visited.
  // A heavy night is ~8 rows, so 45 nights is a couple of hundred at worst --
  // cheaper in one round trip than in a fetch each time you press ‹.
  //
  // Grouped by the CIVIL DAY each drink happened on, not by its drinking-
  // night key (D.drinks above stays night-keyed on purpose -- that is what
  // the dose-response fit and "N drinks the night before" are actually
  // scoped to, and this would be a second, disagreeing definition of the
  // same number if it changed too). Civil day is right for the CHARTS:
  // hr_curve is one midnight-to-midnight day, so a session that runs 9pm to
  // 1am needs its markers split across two consecutive charts anyway. The
  // Drinks calendar wants the opposite -- the whole session on one cell --
  // and normalize() regroups these same rows by night for it (groupByNight).
  //
  // One day earlier than the first row: a drink at 1am on dates[0] is on the
  // civil day before dates[0], so a gte on dates[0] would miss it. Runs
  // unconditionally now, not just when a synced night already has drinks --
  // D.tonight (below) needs it so the "Log a drink now" button can show and
  // undo tonight's drinks before tonight's row exists.
  {
    const from = new Date(`${D.dates[0]}T12:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 2);
    const { data: rows } = await sb
      .from("drinks").select("id,logged_at,std_drinks")
      .gte("logged_at", from.toISOString()).order("logged_at");
    const byDay = {};
    for (const r of rows || []) {
      const at = new Date(r.logged_at);
      const day = at.toLocaleDateString("en-CA", { timeZone: tz });   // YYYY-MM-DD
      (byDay[day] ||= []).push({ id: r.id, logged_at: at, std_drinks: r.std_drinks });
    }
    D.drinkRows = D.dates.map((d) => byDay[d] || []);
    D.drinkTimes = D.drinkRows.map((day) => day.map((r) => r.logged_at.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: tz,
    })));

    // Tonight = drinks in the CURRENT 4am drinking-night (drinkNightOf), which
    // is what the tap endpoint counts. Kept separate from D.drinkRows because
    // that array is indexed by D.dates and today isn't in it until the sync
    // catches up.
    const tn = drinkNightOf(new Date(), tz);
    D.tonight = (rows || [])
      .filter((r) => drinkNightOf(new Date(r.logged_at), tz) === tn)
      .map((r) => ({ id: r.id, logged_at: new Date(r.logged_at), std_drinks: r.std_drinks }));

    // The first drink ever logged, not just the first in this window: a night
    // before it isn't sober, it's unrecorded. The drink charts' sober baseline
    // starts here (see alcoholTimingPoints).
    const { data: first } = await sb.from("drinks").select("logged_at").order("logged_at").limit(1);
    D.loggingSince = first?.[0] ? new Date(first[0].logged_at) : null;
  }

  // The dead man's check the schema was built around and nothing ever read.
  // push() writes this on every run, success or failure; Supabase sleeps a
  // project after 7 days idle and GitHub disables a cron workflow after ~60,
  // and in both cases the dashboard keeps rendering yesterday's numbers with
  // no other symptom. A wrapped failure on purpose: a missing sync_state row
  // is a stale timestamp, not a reason to show no dashboard.
  try {
    const { data: s } = await sb
      .from("sync_state").select("last_sync_at,last_ok,message").eq("id", 1).maybeSingle();
    if (s?.last_sync_at) D.sync = { at: s.last_sync_at, ok: s.last_ok !== false };
  } catch { /* keep the dashboard */ }
  return D;
}

// "12 min ago". Coarsens as it gets older -- past a couple of hours the exact
// minute stops being the point and "3h ago" is the whole message.
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
// The sync runs hourly, so 45 minutes would cry wolf every single hour; two
// missed runs is the first thing actually worth looking at.
const STALE_MIN = 100;

// stages are stored as minute offsets from sleep_start; the hypnogram wants a
// wall-clock start and a span.
function hypnoFrom(row) {
  if (!Array.isArray(row.stages) || !row.stages.length || !row.sleep_start) return null;
  const segs = row.stages;
  const start = new Date(row.sleep_start).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: tz,
  });
  // Sourced from the SAME row the ribbon is drawn from, not a separate lookup
  // -- night_summary computes min_to_nadir server-side, already in the ribbon's
  // own minutes-from-sleep-start coordinate space, so no re-deriving here.
  return {
    start, span: Math.max(...segs.map((s) => s.b)), segs,
    nadirMin: row.min_to_nadir == null ? NaN : Number(row.min_to_nadir),
    nadirBpm: row.hr_nadir_bpm == null ? NaN : Number(row.hr_nadir_bpm),
  };
}

// ----------------------------------------------------------------- day view
// The per-night object every panel reads. Used to be built once, for the newest
// row only, and called `D.today`; now it is a function of the index the stepper
// is on. Every field comes out of an array that was already loaded, which is
// why stepping never touches the network.
function dayView(D, i) {
  const at = (a) => (Array.isArray(a) && ok(a[i]) ? a[i] : NaN);
  const round = (v) => (ok(v) ? Math.round(v) : NaN);
  const asleep = at(D.asleep), inBed = at(D.inBed), strain = at(D.strain);
  const need = at(D.need);
  // The debt you carried INTO this night is the prior night's stored debt.
  // The score's duration term divides by need + a capped slice of it (mirrors
  // SLEEP_DEBT_TARGET_* in metrics.py) -- so a flat 7h only scores clean when
  // you're caught up. For display/explanation; the score itself is computed
  // server-side.
  const debtIn = i > 0 && ok(D.debt?.[i - 1]) ? D.debt[i - 1] : 0;
  return {
    i, night: D.dates[i],
    strain: ok(strain) ? +strain.toFixed(1) : NaN,
    recovery: round(at(D.recovery)),
    score: round(at(D.score)),
    hrv: at(D.hrv), hrvBaseline: at(D.hrvBaseline), rhr: round(at(D.rhr)),
    eff: ok(asleep) && inBed > 0 ? Math.round((asleep / inBed) * 100) : NaN,
    debt: at(D.debt), asleep, need, target: at(D.target),
    scoreTarget: ok(need) ? Math.round(need + Math.min(90, 0.35 * debtIn)) : NaN,
    deep: at(D.deep), light: at(D.light), rem: at(D.rem), awake: at(D.awake),
    drinks: Number(D.drinks[i] || 0), steps: at(D.steps),
    bodyLoad: at(D.bodyLoad),
    loadState: Array.isArray(D.loadState) && Number.isInteger(D.loadState[i]) ? D.loadState[i] : NaN,
    skinTempDelta: at(D.skinTempDelta), respRateDelta: at(D.respRateDelta), rhrDelta: at(D.rhrDelta),
    hrvDeepPct: at(D.hrvDeepPct),
  };
}
// The newest night keeps whatever richer object the source handed us (demo.json
// carries `eff` and `need` it has no arrays for), so the default view is not
// quietly poorer than it was before the stepper existed.
const viewFor = (D, i) =>
  i === D.dates.length - 1 && D.today ? { ...dayView(D, i), ...D.today, i } : dayView(D, i);

// The most recent night at or before `upto` that has stage data -- for a day
// you have not slept through yet. Returns null on a genuinely empty dataset.
function lastSleptNight(D, upto) {
  for (let i = Math.min(upto, D.dates.length - 1); i >= 0; i--) {
    if (ok(D.asleep[i]) && ok(D.deep[i])) return dayView(D, i);
  }
  return null;
}

// ------------------------------------------------------------------- render
let bound = false;
function render() {
  show("dash");
  W = chartWidth();
  const D = DATA;
  // normalize() already drops a "tonight, in progress" placeholder row (see
  // its own comment) -- D.dates.length - 1 is always a real, complete night.
  if (dayIdx < 0 || dayIdx >= D.dates.length) dayIdx = D.dates.length - 1;
  $("demo-banner").hidden = !isDemo;
  renderTrends(D);
  renderWorkoutsTab(D);
  renderDrinksTab(D);
  renderDay();
  if (workoutDayIdx != null && !$("workout-day").hidden) { renderWorkoutDayBody(); primeReadouts($("workout-day")); }
  if (drinksDayIdx != null && !$("drinks-day").hidden) { renderDrinksDayBody(); primeReadouts($("drinks-day")); }
  if (!$("day-picker").hidden) renderDayPicker();
  if (!bound) {
    bound = true;
    bindTips($("dash"));
    bindScrub($("dash"));
    bindSwipe($("dash"));
    watchWidth();
  }
}

function setDay(i) {
  const next = Math.max(0, Math.min(DATA.dates.length - 1, i));
  if (next === dayIdx) return;
  dayIdx = next;
  tip.hidden = true;
  renderDay();
}

// ------------------------------------------------------------------- sync
// GitHub's schedule is best-effort: the cron asks hourly, observed gaps run
// 2.5-4h. This is the "no, now" button. The work happens on GitHub, not here
// -- /api/sync returns the moment the dispatch is accepted -- so the phone can
// lock and the app can close while it runs. Polling below only exists to
// notice when it lands while you happen to still be looking.
//
// null | "busy" | {error}. Rendered through updateDayNav's suffix rather than
// as new chrome: the stamp is already the freshness indicator, and a second
// place to look for the same answer is a worse header, not a better one.
let syncUi = null;
let syncPoll = null, syncSince = null, syncChecking = false, syncErrTimer = null;

function setSyncUi(state) {
  syncUi = state;
  clearTimeout(syncErrTimer);
  // An error must not squat on the freshness stamp forever. It has said its
  // piece after twenty seconds, and "synced 12 min ago" is more useful than a
  // stale complaint about a network blip that has long since passed. A run
  // that genuinely FAILED still shows through, because updateDayNav reads
  // that from sync_state.last_ok rather than from here.
  if (state?.error) {
    syncErrTimer = setTimeout(() => { if (syncUi?.error) setSyncUi(null); }, 20_000);
  }
  const btn = $("sync-btn");
  btn.disabled = state === "busy";
  btn.title = state === "busy" ? "Syncing…" : state?.error ? state.error : "Sync now";
  if (DATA && !$("dash").hidden) updateDayNav(DATA, dayIdx);
}

async function syncNow() {
  if (!sb || syncUi === "busy") return;
  let token;
  try {
    const { data } = await sb.auth.getSession();
    token = data?.session?.access_token;
  } catch { /* handled below */ }
  if (!token) return setSyncUi({ error: "sign in first" });

  // Read the baseline STRAIGHT FROM THE SERVER rather than from DATA.sync.
  // loadLive()'s sync_state read is deliberately wrapped in a catch so a
  // failure there cannot blank the dashboard -- which means DATA.sync can be
  // undefined while the column holds a real timestamp. Seeding the comparison
  // from that would make the very first poll see "null !== <timestamp>",
  // declare the sync finished a second after dispatch, and reload the same
  // stale data. Comparing values, not clocks, also keeps this immune to device
  // clock skew.
  try {
    const { data: s0 } = await sb
      .from("sync_state").select("last_sync_at").eq("id", 1).maybeSingle();
    syncSince = s0?.last_sync_at ?? null;
  } catch {
    return setSyncUi({ error: "no connection" });
  }
  setSyncUi("busy");
  try {
    const res = await fetch("/api/sync", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    // 409 means one was already running -- that is a success for our purposes
    // (data is on its way), so watch for it to land rather than cry failure.
    if (!res.ok && res.status !== 409) return setSyncUi({ error: body.error || `error ${res.status}` });
    watchForSync();
  } catch {
    setSyncUi({ error: "no connection" });
  }
}

// Has sync_state moved since we asked? That is the only honest "done" signal:
// the workflow writes it last, on success AND on failure.
async function checkSynced() {
  // syncChecking, because the visibilitychange listener calls this directly
  // and the poll can already be mid-await. Without it, coming back to the app
  // at the wrong moment starts a second 45-night loadLive() and a second
  // render() racing the first over DATA and dayIdx.
  if (syncUi !== "busy" || !sb || syncChecking) return;
  syncChecking = true;
  try {
    const { data: s } = await sb
      .from("sync_state").select("last_sync_at,last_ok").eq("id", 1).maybeSingle();
    if (!s?.last_sync_at || s.last_sync_at === syncSince) return;

    stopWatching();
    const wasOn = DATA?.dates?.[dayIdx];
    // workoutDayIdx/drinksDayIdx are raw indices too, independent of dayIdx --
    // same exposure to a sync shifting the window out from under them.
    const wasOnWorkout = workoutDayIdx != null ? DATA?.dates?.[workoutDayIdx] : null;
    const wasOnDrinks = drinksDayIdx != null ? DATA?.dates?.[drinksDayIdx] : null;
    const live = await loadLive();
    if (live) {
      DATA = normalize(live);
      // Hold the night you were reading, by DATE not index -- a sync can add a
      // row and shift every index under you.
      const i = wasOn ? DATA.dates.indexOf(wasOn) : -1;
      dayIdx = i >= 0 ? i : DATA.dates.length - 1;
      // Same remap for the two detail sheets. A date that aged out of the
      // 45-night window (only possible if it was already the oldest one
      // loaded) closes the sheet instead of silently relabelling it onto
      // whichever night now sits at that index.
      if (workoutDayIdx != null) {
        const wi = wasOnWorkout ? DATA.dates.indexOf(wasOnWorkout) : -1;
        if (wi >= 0) workoutDayIdx = wi; else closeWorkoutDay();
      }
      if (drinksDayIdx != null) {
        const di = wasOnDrinks ? DATA.dates.indexOf(wasOnDrinks) : -1;
        if (di >= 0) drinksDayIdx = di; else closeDrinksDay();
      }
      render();
    }
    setSyncUi(s.last_ok === false ? { error: "sync failed" } : null);
  } catch {
    // Nothing may leave the button wedged on "busy". If the poll is still
    // running the next tick retries and this was just a blip; if we already
    // stopped it -- the throw came from loadLive(), after the timestamp had
    // moved -- there is no tick left to recover us, so say so and re-enable.
    if (!syncPoll) setSyncUi({ error: "couldn't refresh — reload" });
  } finally {
    syncChecking = false;
  }
}

function stopWatching() { clearInterval(syncPoll); syncPoll = null; }

function watchForSync() {
  stopWatching();
  const started = Date.now();
  syncPoll = setInterval(() => {
    // A run takes ~4 minutes; 12 is generous enough that giving up means
    // something is actually wrong rather than merely slow.
    if (Date.now() - started > 12 * 60_000) {
      stopWatching();
      return setSyncUi({ error: "timed out — check Actions" });
    }
    checkSynced();
  }, 10_000);
  checkSynced();
}

// iOS suspends timers in a backgrounded tab, so a sync that finishes while the
// phone is locked would otherwise sit unnoticed until the next interval after
// you return. Check immediately on the way back in.
addEventListener("visibilitychange", () => { if (!document.hidden) checkSynced(); });
$("sync-btn").addEventListener("click", syncNow);

// The stamp doubles as the freshness indicator, which is why it replaces
// "· latest" rather than sitting beside it: on the newest night "latest" was
// only ever restating the disabled › button, and the question you actually
// have looking at today's numbers is how old they are. Google's own pipeline
// (watch -> phone -> their servers) lags by minutes to tens of minutes on top
// of whatever this shows, so treat it as a floor on the delay, not the total.
function updateDayNav(D, i) {
  const latest = i === D.dates.length - 1;
  const d = new Date(D.dates[i] + "T12:00:00");   // noon: no zone can roll it
  const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const s = D.sync;
  const mins = s ? (Date.now() - new Date(s.at).getTime()) / 60000 : NaN;
  const failed = !!s && !s.ok;
  const stale = !!s && (failed || !(mins < STALE_MIN));

  let suffix = "";
  if (latest) {
    // An in-flight sync outranks the timestamp: "synced 3h ago" while a run is
    // underway is true but useless, and the thing you want to know is that
    // something is happening about it.
    if (syncUi === "busy") suffix = "syncing…";
    else if (syncUi?.error) suffix = syncUi.error;
    else suffix = s ? (failed ? "sync failed" : `synced ${ago(s.at)}`) : "latest";
  }

  // Date on its own line, never broken; the freshness ("synced 54 min ago",
  // "syncing…", an error) sits under it rather than trailing after a "·" that
  // used to wrap the date onto two lines once the buttons grew.
  $("stamp").innerHTML = suffix
    ? `<span class="d">${label}</span><span class="s">${suffix}</span>`
    : `<span class="d">${label}</span>`;
  $("stamp").title = latest ? "" : "Back to the latest night";
  $("day-prev").disabled = i <= 0;
  $("day-next").disabled = latest;
  $("daynav").classList.toggle("stepped", !latest);
  $("daynav").classList.toggle("stale", latest && (stale || !!syncUi?.error) && syncUi !== "busy");
  // No point offering a sync the demo cannot run or an anonymous caller
  // cannot authenticate.
  $("sync-btn").hidden = isDemo || !sb;

  const pb = $("pastbar");
  pb.hidden = latest;
  if (!latest) pb.textContent = `Viewing ${label} — tap for latest`;
}

// "12 min ago" is wrong sixty seconds later, and this app gets left open on a
// bedside table. Cheap enough to just re-stamp; only the newest night shows it.
setInterval(() => {
  if (DATA && !$("dash").hidden && dayIdx === DATA.dates.length - 1) updateDayNav(DATA, dayIdx);
}, 60_000);

// Off by default: most days have no workout, and the band would just be
// visual noise on the one chart everyone opens first. Same localStorage
// pattern as DBG_KEY above, so the choice sticks per device.
const WO_KEY = "pulse-hr-workouts";
let showWorkouts = (() => { try { return localStorage.getItem(WO_KEY) === "1"; } catch { return false; } })();

// On by default, unlike the workout toggle above: drink markers are a
// long-standing, always-shown part of this chart, so hiding them without
// being asked would be a regression, not a quiet default. Stored only once
// someone actually flips it, so "unset" still reads as on.
const DR_KEY = "pulse-hr-drinks";
let showDrinks = (() => { try { return localStorage.getItem(DR_KEY) !== "0"; } catch { return true; } })();

// Off by default, same reasoning as workouts: brand new overlay, so the
// existing chart should not change shape for anyone who hasn't asked for it.
const SL_KEY = "pulse-hr-sleep";
let showSleep = (() => { try { return localStorage.getItem(SL_KEY) === "1"; } catch { return false; } })();

function renderDay() {
  const D = DATA, i = dayIdx, t = viewFor(D, i);
  const latest = i === D.dates.length - 1;
  updateDayNav(D, i);

  const recCol = ringCol(t.recovery, RING_GOOD.recovery);
  const sober = D.recovery.filter((_, k) => !D.drinks[k] && ok(D.recovery[k]));
  const recBase = sober.length ? Math.round(sober.reduce((a, b) => a + b, 0) / sober.length) : NaN;
  // Prefer the trailing-median baseline Postgres already computed for THIS
  // night (excludes the night itself, windowed to 30 days) over a fallback --
  // a whole-account mean that includes the very point being scored, which
  // drifts every past night's percentage retroactively as new nights arrive.
  // Verified against real data: the two methods gave 77.5% vs 82% for the
  // same night. Falls back only when the account is too new for a baseline
  // (fewer than 3 prior nights) or the fixture doesn't carry one (demo.json).
  const hrvBaseUsed = ok(t.hrvBaseline) ? t.hrvBaseline : ch.slope(D).base;
  const hrvPct = Math.round((t.hrv / hrvBaseUsed) * 100);

  const strip = t.drinks ? `<div class="strip">
      <span class="n">${t.drinks}</span>
      <span class="pips">${"<i></i>".repeat(Math.min(t.drinks, 12))}</span>
      <span class="txt">drinks the night before${ok(hrvPct) ? ` · HRV <b>${hrvPct}%</b> of your sober average` : ""}${
        ok(t.recovery) && ok(recBase) ? `, recovery <b>${t.recovery}</b> against a usual <b>${recBase}</b>` : ""}</span></div>` : "";

  const stepsDays = win(D, 30, 14), strainDays = win(D, 21, 10);

  $("today").innerHTML = `
    <div class="kpis">
      ${kpi(ch.gauge(t.strain, 21, ok(t.target) && t.strain > t.target ? col("warn") : col("strain"), "Day Strain", `Day Strain ${t.strain} of 21|waking heart-rate load — sleep doesn't count${ok(t.target) ? `|stay under ${t.target} today${t.loadState > 0 ? " (capped — recovery load)" : ""}` : ""}`), "Day Strain", ok(t.target) ? `under ${t.target}` : "", "strain")}
      ${kpi(ch.ring(t.recovery, recCol, "Recovery", `Recovery ${t.recovery}|55% HRV · 25% resting HR · 20% sleep`), "Recovery", `${t.recovery >= 67 ? "well recovered" : t.recovery >= 34 ? "moderate" : "low"}${t.drinks ? ` · ${t.drinks} drink${t.drinks > 1 ? "s" : ""}` : ""}`, "recovery")}
      ${kpi(ch.ring(t.score, ringCol(t.score, RING_GOOD.sleep), "Sleep Score", ok(t.score) ? `Sleep Score ${t.score}|how well + how settled, scaled to how long you slept vs what you needed — more when you're carrying sleep debt` : "No sleep recorded|this night has not been scored"), "Sleep Score", ok(t.asleep) ? hm(t.asleep) : "not yet", "sleep")}
    </div>
    ${loadBar(t)}
    ${napBar(D.naps[i] || [])}
    ${strip}
    <div class="card"><div class="stats">
      ${stat(ok(t.hrv) ? t.hrv : "—", "HRV ms", recCol)}${stat(ok(t.rhr) ? t.rhr : "—", "RHR bpm")}
      ${stat(ok(t.steps) ? t.steps.toLocaleString() : "—", "Steps", col("steps"))}${stat(ok(t.debt) ? hm(t.debt) : "—", "Sleep debt")}
    </div>${latest ? `<p class="note">Today is still in progress — strain and steps are running
      totals and keep climbing until midnight.</p>` : ""}</div>
    ${card(`Heart rate<span class="card-toggles">
        <button type="button" class="chip-toggle${showDrinks ? " on" : ""}" data-dr-toggle aria-pressed="${showDrinks}"><span class="dot"></span>Drinks</button>
        <button type="button" class="chip-toggle${showSleep ? " on" : ""}" data-sl-toggle aria-pressed="${showSleep}"><span class="dot"></span>Sleep</button>
        <button type="button" class="chip-toggle${showWorkouts ? " on" : ""}" data-wo-toggle aria-pressed="${showWorkouts}"><span class="dot"></span>Workouts</button>
      </span>`, ch.hrIntraday(W, {
        curve: D.curves[i], drinks: showDrinks ? D.drinkTimes[i] : [], hrmax: D.hrmax, rhr: t.rhr,
        workouts: showWorkouts ? (D.workouts[i] || []) : [],
        // D.hypnos[i] is keyed by WAKE date -- this night mostly ran the
        // evening before, so its "start" clock time typically needs to read
        // as yesterday relative to this chart. See nightSpan() in charts.js.
        sleep: showSleep && D.hypnos[i] ? { start: D.hypnos[i].start, min: D.hypnos[i].span, asleep: t.asleep } : null,
        // The Sleep chip is "when was I asleep", so a nap is part of it.
        naps: showSleep ? (D.naps[i] || []) : [],
      }),
      // The workout bands carry no spelled-out on-chart label any more -- two
      // sessions an hour apart overlapped into a smear. Each band gets a
      // numbered badge; this caption, one session per line, decodes the number
      // and gives its span. Shown only while the bands are.
      showWorkouts && D.workouts[i]?.length
        ? D.workouts[i].map((w, k) => {
            const s = ch.mins(w.start);
            return `${k + 1}: ${ch.workoutLabel(w.type)} · ${ch.clockCompact(s)}-${ch.clockCompact(s + (Number(w.min) || 0))}`;
          }).join("<br>")
        : "")}
    ${card(`Steps — ${stepsDays} days`, ch.bars(W, D, D.steps, stepsDays, col("steps"), kfmt, "steps"))}
    ${card(`Strain vs ceiling — ${strainDays} days`, ch.strainHistory(W, D, strainDays))}`;

  primeReadouts($("dash"));
  if (detailKind) { $("detail-body").innerHTML = renderDetailBody(detailKind); primeReadouts($("detail")); }
}

// -------------------------------------------------------------- card detail
// Each Day-tab dial opens onto the charts that actually explain its number,
// instead of sending you hunting across the Day and Trends tabs for them.
const DETAIL_TITLE = { strain: "Day Strain", recovery: "Recovery", sleep: "Sleep Score" };
let detailKind = null;   // re-rendered by renderDay() above whenever open, so a sync or resize can't leave it stale

function openDetail(kind) {
  detailKind = kind;
  $("detail-title").textContent = DETAIL_TITLE[kind] || "";
  $("detail-body").innerHTML = renderDetailBody(kind);
  $("detail").hidden = false;
  $("detail").scrollTop = 0;
  primeReadouts($("detail"));
}
function closeDetail() {
  detailKind = null;
  $("detail").hidden = true;
  tip.hidden = true;
}

// One day's workouts -- opened from a marked day on the Workouts calendar, or
// from a workout row on the Strain detail. `i` is an index into D.dates, the
// same convention as dayIdx, but independent of it: browsing a past day's
// workouts from the calendar must not change which night the Day tab is on.
let workoutDayIdx = null;   // re-rendered by render() below whenever open, same reasoning as detailKind

function openWorkoutDay(i) {
  workoutDayIdx = i;
  renderWorkoutDayBody();
  $("workout-day").hidden = false;
  $("workout-day").scrollTop = 0;
  primeReadouts($("workout-day"));
}
function closeWorkoutDay() {
  workoutDayIdx = null;
  $("workout-day").hidden = true;
  tip.hidden = true;
}
function renderWorkoutDayBody() {
  const D = DATA, i = workoutDayIdx;
  const workouts = D.workouts[i] || [];
  $("workout-day-title").textContent = ch.dlabel(D.dates[i]);
  $("workout-day-body").innerHTML = workouts.length
    ? workouts.map((w, idx) => workoutCard(D, i, w, idx)).join("")
    : `<p class="note">No workouts recorded for this day.</p>`;
}

// Every manually-added drink counts as one plain "other" -- same
// simplification as the NFC stickers (see api/tap.js): the kind/std_drinks
// distinction exists in the schema but nothing here asks about it anymore.
const MANUAL_DRINK_KIND = "other", MANUAL_DRINK_STD = 1.0;

// One night's drinks -- opened from a marked day on the Drinks calendar.
// Same independence from dayIdx as workoutDayIdx above.
let drinksDayIdx = null;

function openDrinksDay(i) {
  drinksDayIdx = i;
  renderDrinksDayBody();
  $("drinks-day").hidden = false;
  $("drinks-day").scrollTop = 0;
  primeReadouts($("drinks-day"));
}
function closeDrinksDay() {
  drinksDayIdx = null;
  $("drinks-day").hidden = true;
  tip.hidden = true;
}

// A drink after midnight sits on the sheet of the night it belongs to, so it
// carries the calendar date it actually happened on: "1:30 AM  Sep 7" under
// Sep 6. Without it the list reads as though the clock ran backwards.
const drinkRow = (r, nightISO) => `<div class="drinkrow">
    <span class="wtime">${r.logged_at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}${
      civilDay(r.logged_at) === nightISO ? ""
        : `<span class="wday">${r.logged_at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>`}</span>
    <button type="button" class="drdel" data-del-drink="${r.id}" aria-label="Delete this drink">×</button>
  </div>`;

// Defaults the add-form's time to now ONLY when the opened night is the one in
// progress right now (the 4am drinking night, in PULSE_TZ) -- not merely the
// newest loaded night, which is yesterday's whenever the sleep sync is lagging.
// "Now" on last night's sheet was silently misdating drinks by a day. Any other
// night defaults to 9pm. At 1am this is still LAST evening's night, so the
// default is 01:00 and drinkTimestamp puts it on the right side of midnight.
function defaultDrinkTime(D, i) {
  const tonight = drinkNightOf(new Date(), clockTz());
  const at = D.dates[i] === tonight ? new Date() : new Date(`${D.dates[i]}T21:00:00`);
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function renderDrinksDayBody() {
  const D = DATA, i = drinksDayIdx;
  const rows = D.nightRows[i] || [];
  const curve = drinkingHrCurve(D, i);
  $("drinks-day-title").textContent = ch.dlabel(D.dates[i]);
  $("drinks-day-body").innerHTML = `
    ${rows.length
      ? `<div class="drinklist">${rows.map((r) => drinkRow(r, D.dates[i])).join("")}</div>`
      : `<p class="note" style="margin:0 0 20px">No drinks recorded for this night.</p>`}
    <form class="drinkadd" data-add-drink>
      <label class="field"><span>Time</span>
        <input type="time" name="time" value="${defaultDrinkTime(D, i)}" required></label>
      <button type="submit" class="primary">Add</button>
      <p class="note">Before ${NIGHT_CUTOFF_H}:00 AM counts as after midnight — logged on the next calendar day, kept with this night.</p>
    </form>
    ${curve ? card("Heart rate while drinking",
        // Same numbered drink markers as the Day-tab HR chart; the caption
        // below spells out which number was when, since a dot on a 4-hour
        // window is not something you can read a time off. One drink per
        // line -- a single row ran off the edge past ~4 drinks.
        ch.hrIntraday(W, { curve, drinks: D.nightTimes[i], session: true, hrmax: D.hrmax, rhr: D.rhr[i] }),
        rows.length
          ? rows.map((r, k) => `Drink ${k + 1}: ${r.logged_at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`).join("<br>")
          : "")
      : ""}`;
  primeReadouts($("drinks-day-body"));
}

// The add-form's night plus a plain wall-clock time. A night is the evening it
// started, and the small hours belong to it: "1:30" on Sep 6's sheet is 1:30 AM
// on Sep 7. Anything before the cutoff therefore lands on the NEXT civil day --
// without that, "1:30" on Sep 6 would be Sep 6 1:30 AM, which drinkNightOf files
// under Sep 5, and the drink would vanish from the sheet it was added to.
function drinkTimestamp(nightISO, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(`${nightISO}T00:00:00`);
  if (hh < NIGHT_CUTOFF_H) d.setDate(d.getDate() + 1);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// The clock the heart-rate curves are stored on: PULSE_TZ for live data. The
// demo fixture's timestamps are zoneless wall time, so there the browser's own
// zone IS the fixture's (an undefined timeZone means "the browser's").
const clockTz = () => (isDemo ? undefined : tz);
const clockOf = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: clockTz() });
const civilDay = (d) => d.toLocaleDateString("en-CA", { timeZone: clockTz() });

// The Drinks calendar's grouping: by drinking night (drinks.night), so 9pm and
// 1am of one session share a cell -- the evening it started. Indexed by D.dates
// like everything else, but mind the offset: nightRows[i] is the night that
// STARTS on D.dates[i], the evening after that row's morning, whereas D.drinks[i]
// counts the night that ENDED it. The civil-day arrays stay as they are; the
// Day-tab heart-rate chart puts markers on a midnight-to-midnight curve and
// wants them where they fall.
function groupByNight(D) {
  const at = new Map(D.dates.map((d, i) => [d, i]));
  D.nightRows = D.dates.map(() => []);
  D.nightTimes = []; D.nightFirst = []; D.nightLast = [];
  for (const r of D.drinkRows.flat()) D.nightRows[at.get(drinkNightOf(r.logged_at, clockTz()))]?.push(r);
  D.nightRows.forEach((_, i) => refreshNight(D, i));
}

// Re-derive one night's sorted rows, clock strings and first/last drink -- the
// fields the calendar, the sheet and its heart-rate chart read.
function refreshNight(D, i) {
  const day = D.nightRows[i].sort((a, b) => a.logged_at - b.logged_at);
  D.nightTimes[i] = day.map((r) => clockOf(r.logged_at));
  D.nightFirst[i] = day.length ? day[0].logged_at : null;
  D.nightLast[i] = day.length ? day[day.length - 1].logged_at : null;
}

// Mirrors drinkNight() in lib/night.js and drink_night() in sql/schema.sql --
// public/app.js can't import lib/ (Vercel only serves public/ as static
// files). The drinks table needs the actual drinking-NIGHT bucket written
// alongside every drink -- the dose-response fit and "N drinks the night
// before" are scoped to it -- and the Drinks calendar now groups by it too.
// All four places share this cutoff; it moves together or not at all.
const NIGHT_CUTOFF_H = 4;
function drinkNightOf(at, tzName) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tzName, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(at)) if (part.type !== "literal") p[part.type] = part.value;
  if (p.hour === "24") p.hour = "00";
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(wall - NIGHT_CUTOFF_H * 3600_000).toISOString().slice(0, 10);
}

// Re-derive the civil-day drink fields the Day-tab chart reads (marker times)
// from D.drinkRows[i] after a demo-mode edit. The live path gets these from
// loadLive()/normalize() for free; demo has no server to round-trip, so it
// keeps them in step here. Deliberately NOT touching D.drinks[i] -- that stays
// night-keyed and fixture-sourced, same as before.
function resyncDemoDrinks(D, i) {
  const day = (D.drinkRows[i] || []).slice().sort((a, b) => a.logged_at - b.logged_at);
  D.drinkRows[i] = day;
  D.drinkTimes[i] = day.map((r) =>
    `${String(r.logged_at.getHours()).padStart(2, "0")}:${String(r.logged_at.getMinutes()).padStart(2, "0")}`);
}

async function addDrink(i, hhmm) {
  const D = DATA;
  const at = drinkTimestamp(D.dates[i], hhmm);

  if (isDemo) {
    const row = { id: `demo-${Date.now()}`, logged_at: at, std_drinks: MANUAL_DRINK_STD };
    D.nightRows[i].push(row);
    refreshNight(D, i);
    // The civil-day arrays as well, for the Day-tab chart -- unless this lands
    // on a calendar day the fixture has no row for (1am after its newest night).
    const k = D.dates.indexOf(civilDay(at));
    if (k >= 0) { D.drinkRows[k].push(row); resyncDemoDrinks(D, k); }
    return render();
  }
  const { error } = await sb.from("drinks").insert({
    logged_at: at.toISOString(), night: drinkNightOf(at, tz), kind: MANUAL_DRINK_KIND, std_drinks: MANUAL_DRINK_STD, source: "manual",
  });
  if (error) return alert(`Could not add drink: ${error.message}`);
  const live = await loadLive();
  if (live) DATA = normalize(live);
  render();
}

async function deleteDrink(i, id) {
  const D = DATA;
  if (isDemo || String(id).startsWith("demo-")) {
    D.nightRows[i] = D.nightRows[i].filter((r) => r.id !== id);
    refreshNight(D, i);
    D.drinkRows.forEach((day, k) => {
      if (!day.some((r) => r.id === id)) return;
      D.drinkRows[k] = day.filter((r) => r.id !== id);
      resyncDemoDrinks(D, k);
    });
    return render();
  }
  const { error } = await sb.from("drinks").delete().eq("id", id);
  if (error) return alert(`Could not delete drink: ${error.message}`);
  const live = await loadLive();
  if (live) DATA = normalize(live);
  render();
}

// "Log a drink now" -- the in-app equivalent of an NFC tap: current instant,
// current 4am night, straight to the drinks table. Independent of the
// calendar, which stays for backfilling forgotten drinks on past days. Works
// even when tonight has no night_summary row yet (the drink just doesn't show
// on the Day tab / calendar until the sync catches up -- same as a tap).
async function addDrinkNow() {
  const D = DATA, at = new Date();
  if (isDemo) {
    (D.tonight ||= []).push({ id: `demo-${Date.now()}`, logged_at: at, std_drinks: MANUAL_DRINK_STD });
    D.tonight.sort((a, b) => a.logged_at - b.logged_at);
    return render();
  }
  const { error } = await sb.from("drinks").insert({
    logged_at: at.toISOString(), night: drinkNightOf(at, tz),
    kind: MANUAL_DRINK_KIND, std_drinks: MANUAL_DRINK_STD, source: "manual",
  });
  if (error) return alert(`Could not log drink: ${error.message}`);
  const live = await loadLive();
  if (live) DATA = normalize(live);
  render();
}

async function deleteDrinkById(id) {
  const D = DATA;
  if (isDemo || String(id).startsWith("demo-")) {
    D.tonight = (D.tonight || []).filter((r) => r.id !== id);
    return render();
  }
  const { error } = await sb.from("drinks").delete().eq("id", id);
  if (error) return alert(`Could not delete drink: ${error.message}`);
  const live = await loadLive();
  if (live) DATA = normalize(live);
  render();
}

// Re-pull just the current drinking-night's drinks and re-render the Drinks
// tab. Called when the tab is opened and on foreground, so a
// drink logged on the NFC sticker while the app was elsewhere shows up (and is
// deletable) without waiting for a full sync. Tag and in-app drinks are the
// same rows -- source is "nfc" vs "manual" -- so this list carries both.
let refreshingTonight = false;
async function refreshTonight() {
  if (isDemo || !sb || !DATA || refreshingTonight) return;
  refreshingTonight = true;
  try {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 2);
    const { data: rows, error } = await sb
      .from("drinks").select("id,logged_at,std_drinks")
      .gte("logged_at", from.toISOString()).order("logged_at");
    if (error) return;
    const tn = drinkNightOf(new Date(), tz);
    const next = (rows || [])
      .filter((r) => drinkNightOf(new Date(r.logged_at), tz) === tn)
      .map((r) => ({ id: r.id, logged_at: new Date(r.logged_at), std_drinks: r.std_drinks }));
    // Re-render even when nothing changed: the bedtime planner's first row is
    // "if you went to bed now", which moves with the clock.
    DATA.tonight = next;
    renderDrinksTab(DATA);
  } finally {
    refreshingTonight = false;
  }
}
addEventListener("visibilitychange", () => {
  if (!document.hidden && currentTab() === "drinks") refreshTonight();
});

$("dash").addEventListener("click", (e) => {
  if (e.target.closest?.("[data-wo-toggle]")) {
    showWorkouts = !showWorkouts;
    try { localStorage.setItem(WO_KEY, showWorkouts ? "1" : "0"); } catch { /* private mode */ }
    return renderDay();
  }
  if (e.target.closest?.("[data-dr-toggle]")) {
    showDrinks = !showDrinks;
    try { localStorage.setItem(DR_KEY, showDrinks ? "1" : "0"); } catch { /* private mode */ }
    return renderDay();
  }
  if (e.target.closest?.("[data-sl-toggle]")) {
    showSleep = !showSleep;
    try { localStorage.setItem(SL_KEY, showSleep ? "1" : "0"); } catch { /* private mode */ }
    return renderDay();
  }
  const b = e.target.closest?.(".kpi[data-detail], .loadbar[data-detail]");
  if (b) return openDetail(b.dataset.detail);
  const w = e.target.closest?.(".workrow[data-workout-day]");
  if (w) return openWorkoutDay(Number(w.dataset.workoutDay));
  const cell = e.target.closest?.(".calcell.has[data-day-idx]");
  if (cell) return openWorkoutDay(Number(cell.dataset.dayIdx));
  if (e.target.closest?.("#cal-btn")) return openDayPicker();
  const pk = e.target.closest?.(".calcell[data-pick-idx]");
  if (pk) { closeDayPicker(); return setDay(Number(pk.dataset.pickIdx)); }
  if (e.target.closest?.("#pk-prev")) return stepPickMonth(-1);
  if (e.target.closest?.("#pk-next")) return stepPickMonth(1);
  if (e.target.closest?.("#cal-prev")) return stepCalMonth(-1);
  if (e.target.closest?.("#cal-next")) return stepCalMonth(1);
  if (e.target.closest?.("[data-log-now]")) return addDrinkNow();
  const delNow = e.target.closest?.("[data-del-now]");
  if (delNow) return deleteDrinkById(delNow.dataset.delNow);
  const drCell = e.target.closest?.(".calcell[data-drinks-day-idx]");
  if (drCell) return openDrinksDay(Number(drCell.dataset.drinksDayIdx));
  if (e.target.closest?.("#drcal-prev")) return stepDrinksCalMonth(-1);
  if (e.target.closest?.("#drcal-next")) return stepDrinksCalMonth(1);
  const del = e.target.closest?.("[data-del-drink]");
  if (del) return deleteDrink(drinksDayIdx, del.dataset.delDrink);
  const wt = e.target.closest?.(".wsummary[data-wtoggle]");
  if (wt) {
    const body = $(`wexpand-${wt.dataset.wtoggle}`);
    const opening = body.hidden;
    body.hidden = !opening;
    wt.setAttribute("aria-expanded", String(opening));
    wt.querySelector(".wchev").textContent = opening ? "⌄" : "›";
    if (opening) primeReadouts(body);
  }
});
$("dash").addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-add-drink]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  addDrink(drinksDayIdx, fd.get("time"));
});
$("detail-close").addEventListener("click", closeDetail);
$("workout-day-close").addEventListener("click", closeWorkoutDay);
$("drinks-day-close").addEventListener("click", closeDrinksDay);
$("day-picker-close").addEventListener("click", closeDayPicker);
// #workout-day can be open OVER #detail (opened from a Strain-detail workout
// row); closeTopOverlay (defined with bindSwipe above) closes whichever is
// topmost, so Escape and the edge-swipe agree on the same order.
addEventListener("keydown", (e) => { if (e.key === "Escape" && topOverlay()) closeTopOverlay(); });

// From the resolved night's hypnogram, pull the matching stretch of heart-rate
// curve. h.start (clock time) and h.span (total minutes) already say exactly
// when the session ran; whether start+span crosses midnight decides whether
// the evening half lives in yesterday's civil-day curve or today's, per the
// "night = wake date" convention main_sleeps() uses server-side (pulse/metrics.py)
// -- a session that never crosses midnight has its wake date equal to its own
// start date, so there is nothing to reach into D.curves[i-1] for at all.
function sleepHrCurve(D, i, h) {
  if (!h?.segs?.length || i < 0) return null;
  const startMin = ch.mins(h.start), endAbs = startMin + h.span;
  if (endAbs <= 1440) {
    const same = (D.curves[i] || []).filter((p) => { const m = ch.mins(p[0]); return m >= startMin && m <= endAbs; });
    return same.length ? same : null;
  }
  if (i < 1) return null;
  const endWrapped = endAbs - 1440;
  const evening = (D.curves[i - 1] || []).filter((p) => ch.mins(p[0]) >= startMin);
  const morning = (D.curves[i] || []).filter((p) => ch.mins(p[0]) <= endWrapped);
  const merged = [...evening, ...morning];
  return merged.length ? merged : null;
}

// "CARDIO_WORKOUT" -> "Cardio workout". Google's exerciseType enum is
// SHOUT_CASE; nothing else on this page is.
const titleCase = (s) => String(s).toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
// A button, not a static row: tapping it opens #workout-day for `dayIdx` --
// the same screen a marked day on the Workouts calendar opens, showing every
// workout that day (not just this one). See the note on #workout-day in
// index.html for why it's the whole day rather than just this row.
const workoutRow = (w, dayIdx) => `<button type="button" class="workrow" data-workout-day="${dayIdx}">
    <div><span class="wtype">${titleCase(w.type)}</span><span class="wtime"> · ${ch.clock12(ch.mins(w.start))} · ${w.min}m</span></div>
    <div class="wmetrics">${w.cal != null ? `${w.cal} cal` : ""}</div>
  </button>`;

// From a workout's own start clock + duration (already clamped to <=6h, see
// normalize_exercise() in metrics.py), pull the matching stretch of the day's
// heart-rate curve. Unlike sleepHrCurve, no wake-date offset is needed here --
// _daily_workouts() groups by the workout's OWN start date, the same civil day
// D.curves[i] already is, so a same-day session just slices D.curves[i]; only
// a session that itself crosses midnight needs D.curves[i + 1] too.
function workoutHrCurve(D, i, w) {
  const startMin = ch.mins(w.start), endAbs = startMin + w.min;
  if (endAbs <= 1440) {
    const same = (D.curves[i] || []).filter((p) => { const m = ch.mins(p[0]); return m >= startMin && m <= endAbs; });
    return same.length ? same : null;
  }
  const endWrapped = endAbs - 1440;
  const first = (D.curves[i] || []).filter((p) => ch.mins(p[0]) >= startMin);
  const second = (D.curves[i + 1] || []).filter((p) => ch.mins(p[0]) <= endWrapped);
  const merged = [...first, ...second];
  return merged.length ? merged : null;
}

// From first drink to two hours past the last -- the night's first and last
// drink are absolute timestamps (unlike a workout's plain clock string), so the
// span comes straight from their difference. Otherwise identical to
// workoutHrCurve above: a drinking night that runs past midnight needs
// D.curves[i + 1] the same way a late workout would. The night is the
// EVENING's, so its curves start at D.curves[i]; the one exception is a night
// whose first drink is itself after midnight (nothing logged in the evening),
// which begins on the next civil day's curve.
function drinkingHrCurve(D, i) {
  const first = D.nightFirst[i], last = D.nightLast[i];
  if (!first || !last) return null;
  const k = civilDay(first) === D.dates[i] ? i : i + 1;
  const startMin = ch.mins(clockOf(first));
  const spanMin = Math.round((last.getTime() - first.getTime()) / 60000) + 120;
  const endAbs = startMin + spanMin;
  if (endAbs <= 1440) {
    const same = (D.curves[k] || []).filter((p) => { const m = ch.mins(p[0]); return m >= startMin && m <= endAbs; });
    return same.length ? same : null;
  }
  const endWrapped = endAbs - 1440;
  const evening = (D.curves[k] || []).filter((p) => ch.mins(p[0]) >= startMin);
  const morning = (D.curves[k + 1] || []).filter((p) => ch.mins(p[0]) <= endWrapped);
  const merged = [...evening, ...morning];
  return merged.length ? merged : null;
}

// Row style and the zone bars are both lifted from the Google Health app's
// own workout detail screen -- label-left/value-right rows rather than
// tiles, and a bar per zone (Peak down to Light) instead of a sentence.
// `zones` is Fitbit's own light/moderate/vigorous/peak split
// (metrics.py's normalize_exercise, straight from the API's
// heartRateZoneDurations), not a Karvonen recomputation of ours, so the
// PERCENTAGES here never disagree with what the same workout shows in that
// app -- only the chart's zone coloring above is an approximation (see
// zoneEdges4 in charts.js), because this project has no access to Fitbit's
// own personalized thresholds.
const detRow = (label, value) => `<div class="detrow"><span class="dlabel">${label}</span><span class="dvalue">${value}</span></div>`;

const ZONE_ORDER = [["Peak", "peak", 3], ["Vigorous", "vigorous", 2], ["Moderate", "moderate", 1], ["Light", "light", 0]];

function zoneBars(z) {
  if (!z) return "";
  const total = z.light + z.moderate + z.vigorous + z.peak;
  if (!total) return "";
  return `<div class="zonebars">
    ${ZONE_ORDER.map(([label, key, ci]) => {
      const pct = Math.round((z[key] / total) * 100);
      return `<div class="zonebar">
        <p class="zlabel">${label} · ${pct}% · ${z[key]} min</p>
        <div class="ztrack"><div class="zfill" style="width:${pct}%;background:${ch.WZONE[ci]}"></div></div>
      </div>`;
    }).join("")}
  </div>`;
}

// "24'33\" /mi" -- averagePaceSecondsPerMeter converted to seconds-per-mile,
// then to minutes:seconds. Google supplies this directly (not derived from
// our own duration/distance, which would compound whatever rounding each of
// those already carries).
function paceLabel(secPerMeter) {
  if (!ok(secPerMeter)) return null;
  const secPerMi = secPerMeter * 1609.344;
  const m = Math.floor(secPerMi / 60), s = Math.round(secPerMi % 60);
  return `${m}'${String(s).padStart(2, "0")}" /mi`;
}

// Collapsed to time/duration/calories -- what you'd want at a glance for
// every workout that day. Heart rate (the chart, the zone breakdown, the
// average) only renders once expanded: it's the thing worth a tap, not the
// thing worth scanning six of in a row.
function workoutCard(D, i, w, idx) {
  const curve = workoutHrCurve(D, i, w);
  const meta = [`${ch.clock12(ch.mins(w.start))} · ${w.min}m`, w.cal != null ? `${w.cal} cal` : ""]
    .filter(Boolean).join(" · ");
  const miles = w.dist_m != null ? w.dist_m / 1609.344 : null;
  const pace = paceLabel(w.pace_s_per_m);
  const rows = [
    detRow("Duration", `${w.min}m`),
    w.cal != null ? detRow("Calories", `${w.cal} cal`) : "",
    miles != null ? detRow("Distance", `${miles.toFixed(2)} mi`) : "",
    w.steps != null ? detRow("Steps", w.steps.toLocaleString()) : "",
    pace ? detRow("Pace", pace) : "",
    w.avg_hr != null ? detRow("Avg heart rate", `${w.avg_hr} bpm`) : "",
    w.azm != null ? detRow("Active zone min", `${w.azm} min`) : "",
  ].filter(Boolean).join("");
  return `<div class="card">
    <button type="button" class="wsummary" data-wtoggle="${idx}" aria-expanded="false" aria-controls="wexpand-${idx}">
      <span class="wtype">${titleCase(w.type)}</span>
      <span class="wmeta">${meta}</span>
      <span class="wchev">›</span>
    </button>
    <div class="wexpand" id="wexpand-${idx}" hidden>
      <div class="detlist">${rows}</div>
      <div class="readrow"><p class="readout" aria-live="polite"></p>${stepper}</div>
      <div class="chartbox scrubbable">${ch.hrIntraday(W, { curve, hrmax: D.hrmax, rhr: D.rhr[i], session: true })}</div>
      ${zoneBars(w.zones)}
    </div>
  </div>`;
}

function renderDetailBody(kind) {
  const D = DATA, i = dayIdx, t = viewFor(D, i);

  if (kind === "strain") {
    const strainDays = win(D, 21, 10), stepsDays = win(D, 30, 14);
    const workouts = D.workouts[i] || [];
    const over = ok(t.target) && t.strain > t.target;
    return `
      <div class="detail-dial">${ch.gauge(t.strain, 21, over ? col("warn") : col("strain"), "Day Strain", `Day Strain ${t.strain} of 21|waking heart-rate load only`)}</div>
      <p class="note center">${ok(t.target) ? `stay under <b>${t.target}</b> today` : ""}${ok(t.steps) ? ` · <b>${t.steps.toLocaleString()}</b> steps` : ""}</p>
      ${card(`Strain vs ceiling — ${strainDays} days`, ch.strainHistory(W, D, strainDays))}
      ${card("Workouts", workouts.length
        ? `<div class="worklist">${workouts.map((w) => workoutRow(w, i)).join("")}</div>`
        : `<p class="note" style="margin:0">No workouts detected for this day.</p>`, "", false)}
      ${card(`Steps — ${stepsDays} days`, ch.bars(W, D, D.steps, stepsDays, col("steps"), kfmt, "steps"))}
      ${card("Time in zone", `<div class="stats" style="grid-template-columns:repeat(5,1fr)">
        ${[0, 1, 2, 3, 4].map((k) => stat(Math.round(D.z[k]?.[i] || 0) + "m", "Z" + (k + 1), k ? ZONE[k] : null)).join("")}</div>`, "", false)}
      <p class="note">Strain is your waking heart-rate load — Banister TRIMP over every sample
        while you're awake, log-compressed. Sleep is left out: an elevated resting heart
        rate overnight is your body recovering, not training, and it shows up as low
        recovery instead. The ceiling scales with recovery — a number to stay under on a
        low-recovery day, not a target to hit.</p>`;
  }

  if (kind === "recovery") {
    const recCol = ringCol(t.recovery, RING_GOOD.recovery);
    const trendDays = win(D, 30, 14);
    const hrvBaseUsed = ok(t.hrvBaseline) ? t.hrvBaseline : ch.slope(D).base;
    const hrvPct = Math.round((t.hrv / hrvBaseUsed) * 100);
    const hasTemp = Array.isArray(D.skinTempDelta) && D.skinTempDelta.some(ok);
    const hasRR = Array.isArray(D.respRate) && D.respRate.some(ok);
    const hasDeep = Array.isArray(D.hrvDeepPct) && D.hrvDeepPct.some(ok);
    const hasNonRem = Array.isArray(D.nonRemHr) && D.nonRemHr.some(ok);
    const hasSpo2Min = Array.isArray(D.spo2Min) && D.spo2Min.some(ok);
    const deepPct = ok(t.hrvDeepPct) ? Math.round(t.hrvDeepPct) : NaN;
    const bits = loadMarkers(t);
    const loadCard = ok(t.bodyLoad) && Number.isInteger(t.loadState)
      ? `<div class="card loadcard l${t.loadState}">
          <h2>Recovery load — ${LOAD_WORD[t.loadState]}</h2>
          <p class="note" style="margin:0">${t.loadState === 0
            ? "Your overnight heart rate, HRV, breathing and skin temperature all sat within their normal range."
            : `${bits.length ? bits.join(" · ") : "One or more overnight signals ran outside your 30-night normal"}. ${
                t.drinks ? `The expected hit from ${t.drinks} drink${t.drinks > 1 ? "s" : ""}.`
                         : "Illness, stress, a late meal, or a missed tap?"} It also caps today's strain ceiling.`}</p></div>`
      : "";
    return `
      <div class="detail-dial">${ch.ring(t.recovery, recCol, "Recovery", `Recovery ${t.recovery}|55% HRV · 25% resting HR · 20% sleep`)}</div>
      <p class="note center">55% HRV · 25% resting heart rate · 20% sleep score, each against your
        rolling baseline${ok(hrvPct) ? ` — HRV is <b>${hrvPct}%</b> of yours` : ""}${
        ok(deepPct) ? ` (deep-sleep HRV <b>${deepPct}%</b>)` : ""}.</p>
      ${loadCard}
      ${card(`Recovery — ${trendDays} days`, ch.sparkline(W, D, D.recovery, recCol, trendDays, ""))}
      ${card(`HRV (rMSSD) — ${trendDays} days`, ch.sparkline(W, D, D.hrv, col("accent"), trendDays, "ms"))}
      ${hasDeep ? card(`Deep-sleep HRV vs baseline — ${trendDays} nights`, ch.sparkline(W, D, D.hrvDeepPct, col("accent"), trendDays, "%"),
        "A true rMSSD measured in deep sleep only — a cleaner autonomic read than the all-night average, and Recovery Load uses it in place of the average once it has a baseline.") : ""}
      ${card(`Resting heart rate — ${trendDays} days`, ch.sparkline(W, D, D.rhr, col("warn"), trendDays, "bpm"))}
      ${hasNonRem ? card(`Non-REM resting HR — ${trendDays} nights`, ch.sparkline(W, D, D.nonRemHr, col("warn"), trendDays, "bpm"),
        "Resting HR measured in stable non-REM sleep — the RHR analogue of the deep-sleep HRV lens.") : ""}
      ${hasTemp ? card(`Skin temperature vs baseline — ${trendDays} nights`, ch.sparkline(W, D, D.skinTempDelta, col("warn"), trendDays, "°C")) : ""}
      ${hasRR ? card(`Respiratory rate — ${trendDays} nights`, ch.sparkline(W, D, D.respRate, col("accent"), trendDays, "br/min")) : ""}
      ${hasSpo2Min ? card(`Blood-oxygen low — ${trendDays} nights`, ch.sparkline(W, D, D.spo2Min, col("accent"), trendDays, "%"),
        "The night's lowest SpO₂, from the range the API reports. A low floor or a wide swing points at breathing — congestion, a cold, altitude. Too coarse for an apnea screen.") : ""}
      ${card(`Sleep Score — ${trendDays} nights`, ch.sparkline(W, D, D.score, col("rem"), trendDays, ""))}`;
  }

  // sleep — same "last slept night" fallback renderDay() used to, back when
  // this was its own tab, so a day with no sleep yet drills into last
  // night's rather than a blank ring.
  const slept = ok(t.asleep) && ok(t.deep);
  const sn = slept ? t : lastSleptNight(D, i) ?? t;
  const sIdx = slept ? i : sn.i ?? i;
  const hyp = D.hypnos[sIdx];
  const remDays = win(D, 30, 14), colDays = win(D, 14, 7), debtDays = win(D, 30, 14);
  // Tonight's need, mirroring sleep_series() server-side (metrics.py): a flat
  // personal baseline (7h) plus up to 30 min the night after a hard day, using
  // today's strain so far as that "previous day" input. Debt is deliberately
  // NOT folded in -- it is tracked and shown on its own, not as a moving
  // target. Only shown on the latest day; a past night's own sn.need already
  // says what it needed.
  const NEED_MIN = 420, GOAL_MIN = 480;
  const tonightNeed = i === D.dates.length - 1 && ok(D.strain[i])
    ? NEED_MIN + Math.min(30, 3 * Math.max(0, D.strain[i] - 10))
    : NaN;
  // How the score judged this night: need, plus a capped slice of the debt
  // carried in. When that's bigger than the bare need, a flat 7h night is
  // being measured against ~8h and can't score a clean 90.
  const debtBump = ok(sn.scoreTarget) && ok(sn.need) ? sn.scoreTarget - sn.need : 0;
  return `
    ${slept ? "" : `<div class="banner">No sleep recorded for <b>${t.night}</b> — showing the night of
      <b>${sn.night ?? "the last full night"}</b>.</div>`}
    <div class="detail-dial">${ch.ring(sn.score, ringCol(sn.score, RING_GOOD.sleep), "Sleep Score", ok(sn.score) ? `Sleep Score ${sn.score}|how well + how settled, × the fraction of ${hm(ok(sn.scoreTarget) ? sn.scoreTarget : sn.need)} you slept` : "No sleep recorded|this night has not been scored")}</div>
    <p class="note center">${ok(sn.asleep) ? `<b>${hm(sn.asleep)}</b> asleep of <b>${hm(sn.need)}</b> needed${ok(sn.asleep) && sn.asleep >= GOAL_MIN ? " · hit your 8h goal" : ""}` : "not yet scored"}</p>
    <div class="card"><div class="stats">
      ${stat(ok(sn.asleep) ? hm(sn.asleep) : "—", "Asleep")}${stat(ok(sn.eff) ? sn.eff + "%" : "—", "Efficiency")}
      ${stat(ok(sn.need) ? hm(sn.need) : "—", "Needed last night")}${stat(ok(sn.score) ? sn.score : "—", "Sleep Score", sn.score >= 80 ? col("good") : col("awake"))}
    </div>${debtBump > 5 ? `<p class="note">Scored against <b>${hm(sn.scoreTarget)}</b> — your ${hm(sn.need)} need plus <b>${hm(debtBump)}</b> because you went in carrying sleep debt. Sleep long or pay the debt down and the same night scores higher.</p>` : ok(tonightNeed) ? `<p class="note">Needed tonight: <b>${hm(tonightNeed)}</b> — a flat 7h baseline${tonightNeed > NEED_MIN ? ", plus a little for today's exertion" : ""}. Carrying debt raises the bar the score is measured against; your 8h goal is the stretch target.</p>` : ""}</div>
    ${card("Hypnogram", ch.hypnogram(W, hyp))}
    ${napCards(D.naps[i] || [])}
    ${card("Heart rate during sleep", ch.hrIntraday(W, { curve: sleepHrCurve(D, sIdx, hyp), hrmax: D.hrmax, rhr: sn.rhr }))}
    ${card(`REM — ${remDays} nights`, ch.sparkline(W, D, D.rem, col("rem"), remDays, "min"))}
    ${card("Stages vs your 30-night baseline", ch.stagesVsBaseline(W, D, sn), "", false)}
    ${card(`Sleep consistency — last ${colDays} nights`, ch.sleepColumns(W, D, colDays))}
    ${card(`Sleep debt — ${debtDays} days`, ch.debtArea(W, D, debtDays))}`;
}

// ----------------------------------------------------------------- workouts
// A real month calendar: one cell per day, a dot on days that had a workout,
// tap one to open #workout-day. calYear/calMonth track which month is showing
// independently of dayIdx -- browsing March from the calendar has nothing to
// do with which night the Day tab is scoped to.
let calYear = null, calMonth = null;   // calMonth is 0-indexed, JS Date style

function stepCalMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderWorkoutsTab(DATA);
}

const pad2 = (n) => String(n).padStart(2, "0");
const CAL_WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function renderWorkoutsTab(D) {
  // Defaults to the month containing the newest synced night, not the
  // browser's real "today" -- those can disagree (a sync that hasn't run
  // yet, a phone in the wrong timezone), and every other date on this page
  // is already anchored to the account's own data rather than the clock.
  if (calYear == null) {
    const [y, m] = D.dates[D.dates.length - 1].split("-").map(Number);
    calYear = y; calMonth = m - 1;
  }
  const byDate = new Map(D.dates.map((d, i) => [d, i]));
  const first = new Date(calYear, calMonth, 1);
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  let cells = "";
  for (let k = 0; k < first.getDay(); k++) cells += `<div class="calcell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${calYear}-${pad2(calMonth + 1)}-${pad2(day)}`;
    const idx = byDate.get(iso);
    const n = idx != null ? (D.workouts[idx]?.length || 0) : 0;
    cells += n
      ? `<button type="button" class="calcell has" data-day-idx="${idx}">${day}<span class="dot">${n > 1 ? n : ""}</span></button>`
      : `<div class="calcell${idx == null ? " out" : ""}">${day}</div>`;
  }

  $("workouts").innerHTML = `
    <div class="calnav">
      <button class="nav" id="cal-prev" type="button" aria-label="Previous month">‹</button>
      <p class="calmonth">${monthLabel}</p>
      <button class="nav" id="cal-next" type="button" aria-label="Next month">›</button>
    </div>
    <div class="calgrid">
      ${CAL_WEEKDAYS.map((d) => `<div class="calhead">${d}</div>`).join("")}
      ${cells}
    </div>`;
}

// Own month cursor, independent of calYear/calMonth above -- browsing March
// on the Drinks calendar has nothing to do with which month Workouts is on,
// same reasoning calYear/calMonth's own comment gives for staying off dayIdx.
let drCalYear = null, drCalMonth = null;

function stepDrinksCalMonth(delta) {
  drCalMonth += delta;
  if (drCalMonth < 0) { drCalMonth = 11; drCalYear--; }
  if (drCalMonth > 11) { drCalMonth = 0; drCalYear++; }
  renderDrinksTab(DATA);
}

function renderDrinksTab(D) {
  if (drCalYear == null) {
    const [y, m] = D.dates[D.dates.length - 1].split("-").map(Number);
    drCalYear = y; drCalMonth = m - 1;
  }
  const byDate = new Map(D.dates.map((d, i) => [d, i]));
  const first = new Date(drCalYear, drCalMonth, 1);
  const daysInMonth = new Date(drCalYear, drCalMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  let cells = "";
  for (let k = 0; k < first.getDay(); k++) cells += `<div class="calcell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${drCalYear}-${pad2(drCalMonth + 1)}-${pad2(day)}`;
    const idx = byDate.get(iso);
    // D.nightRows, not D.drinks or the civil-day D.drinkRows -- a cell is the
    // drinking night that STARTS on that date (see groupByNight), so a session
    // is one cell whether the drink was at 9pm or 1am, and a night still in
    // progress shows up on the day it's actually happening rather than tomorrow.
    const n = idx != null ? (D.nightRows[idx]?.length || 0) : 0;
    // Every loaded day is tappable here, not just ones with drinks already --
    // unlike Workouts (browse-only), this screen's whole point is adding a
    // forgotten night, which by definition starts at zero.
    cells += idx != null
      ? `<button type="button" class="calcell${n ? " has drink" : ""}" data-drinks-day-idx="${idx}">${day}${n ? `<span class="dot">${n > 1 ? n : ""}</span>` : ""}</button>`
      : `<div class="calcell out">${day}</div>`;
  }

  // "Log a drink now" + tonight's running list. Independent of the calendar
  // below (and of D.dates) so it works before tonight has synced.
  const tn = (D.tonight || []).slice().sort((a, b) => a.logged_at - b.logged_at);
  const time12 = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const nowBlock = `
    <button type="button" class="lognow" data-log-now>
      <span class="plus">+</span> Log drink now
    </button>
    ${tn.length ? `<div class="nowlist">
      <p class="nowhd">Tonight — <b>${tn.length}</b></p>
      ${tn.map((r, k) => `<div class="nowrow"><span class="nown">${k + 1}</span>
        <span class="nowt">${time12(r.logged_at)}</span>
        <button type="button" class="nowdel" data-del-now="${r.id}" aria-label="Delete drink ${k + 1}">×</button></div>`).join("")}
    </div>` : ""}`;

  $("drinks").innerHTML = `
    ${nowBlock}
    ${tn.length ? bedPlanner(D, tn) : ""}
    <div class="calnav">
      <button class="nav" id="drcal-prev" type="button" aria-label="Previous month">‹</button>
      <p class="calmonth">${monthLabel}</p>
      <button class="nav" id="drcal-next" type="button" aria-label="Next month">›</button>
    </div>
    <div class="calgrid">
      ${CAL_WEEKDAYS.map((d) => `<div class="calhead">${d}</div>`).join("")}
      ${cells}
    </div>`;
}

// The dose-response chart pools every night the account has ever had -- more
// history is always better for a fit, so it stays outside the range toggle
// below. The four trend charts are windowed reads of the *same* day-count.
function renderTrends(D) {
  const { m: perDrink } = ch.slope(D);
  const nights = D.drinks.filter(Boolean).length;
  // Hand-built rather than card(): the prose under every chart is gone, but the
  // fitted slope is the one number this whole project exists to produce, so it
  // gets the readout treatment the scrubbable charts get -- a value line, not a
  // paragraph. Losing it with the prose would have been the one real casualty.
  $("trends").innerHTML = `
    <div class="card"><h2>Drinks vs next-morning HRV</h2>
      <p class="readout live"><b>${perDrink.toFixed(1)}% of baseline HRV per drink</b><span> · ${nights} drinking night${nights === 1 ? "" : "s"}</span></p>
      <div class="chartbox">${ch.doseResponse(W, D)}</div></div>
    <div id="timing-card"></div>
    <div id="score-gap-card"></div>
    <div class="range" role="tablist" aria-label="Trend window">
      ${RANGE_PRESETS.map((n) => `<button class="rbtn" role="tab" aria-selected="false" data-days="${n}" type="button">${n}d</button>`).join("")}
    </div>
    <div id="trend-cards"></div>`;
  renderTimingCard(D);
  renderScoreGapCard(D);
  renderTrendCharts(D, pickDefaultRange(D));
}

// ------------------------------------------------- last drink -> bedtime gap
// Deliberately just the clock gap, with no clearance model: how fast a body
// clears alcohol varies by person and nobody has measured it here.
// Bounds the lookup so a stray row from last week can't pair with tonight's sleep.
const TIMING_LOOKBACK_MIN = 12 * 60;

const dayNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };

// Pairs each night's sleep with the drinks before it BY TIMESTAMP, not by index:
// nightRows[i] is the evening that starts on dates[i] while the sleep it wrecked
// is the row dated the next morning, and the demo fixture doesn't follow that
// offset. Both sides are put on one wall-clock minute line (day * 1440 + clock),
// which sidesteps timezone arithmetic -- clockOf/civilDay already speak the
// display zone.
function alcoholTimingPoints(D, metric) {
  const all = D.drinkRows.flat()
    .map((r) => ({ at: dayNum(civilDay(r.logged_at)) * 1440 + ch.mins(clockOf(r.logged_at)), std: Number(r.std_drinks) || 1 }))
    .sort((a, b) => a.at - b.at);
  const vals = metric === "score" ? D.score : D.recovery;
  // Nights before drink logging began say nothing about drinking -- no drinks
  // logged there means unrecorded, not sober -- so they sit out of both the
  // sober baseline and the drinking points. The demo has no loggingSince; its
  // first fixture drink stands in.
  const wall = (d) => dayNum(civilDay(d)) * 1440 + ch.mins(clockOf(d));
  const since = D.loggingSince ? wall(D.loggingSince) : all.length ? all[0].at : -Infinity;
  const nights = [];
  for (let j = 0; j < D.dates.length; j++) {
    if (!ok(vals[j])) continue;
    let bed;
    if (D.bed_nights) {
      // demo fixture: minutes from this row's own midnight, evening-keyed
      if (!ok(D.bed_nights[j])) continue;
      bed = dayNum(D.dates[j]) * 1440 + D.bed_nights[j];
    } else {
      const hyp = D.hypnos[j];
      if (!hyp) continue;
      // A start after noon is the previous evening; a small hour is after midnight.
      const sm = ch.mins(hyp.start);
      bed = (dayNum(D.dates[j]) - (sm >= 720 ? 1 : 0)) * 1440 + sm;
    }
    if (bed < since) continue;
    const startMin = ((bed % 1440) + 1440) % 1440;
    const mine = all.filter((d) => d.at <= bed && d.at >= bed - TIMING_LOOKBACK_MIN);
    nights.push({ j, v: vals[j], mine, bed, startMin });
  }
  const sober = nights.filter((n) => !n.mine.length).map((n) => n.v);
  const pool = sober.length >= 3 ? sober : nights.map((n) => n.v);
  const mean = pool.reduce((a, v) => a + v, 0) / (pool.length || 1);
  const sd = Math.sqrt(pool.reduce((a, v) => a + (v - mean) ** 2, 0) / (pool.length || 1));
  const pts = nights.filter((n) => n.mine.length).map((n) => {
    const drinks = n.mine.reduce((a, d) => a + d.std, 0);
    const last = n.mine[n.mine.length - 1];
    const gapH = (n.bed - last.at) / 60;
    const lastClock = ch.clock12(((last.at % 1440) + 1440) % 1440);
    return {
      gapH, drinks, v: n.v, dy: n.v - mean,
      tip: `${D.dates[n.j]}|${+drinks.toFixed(1)} drinks, last ${lastClock}, bed ${ch.clock12(n.startMin)} (${gapH.toFixed(1)}h later) → ${Math.round(n.v)} (${n.v - mean >= 0 ? "+" : ""}${Math.round(n.v - mean)} vs sober ${Math.round(mean)})`,
    };
  });
  return { pts, sd: sd || 5, mean };
}

// Grid buckets. Columns: hours from last drink to falling asleep, closed at 3h+
// because past that a typical evening has few nights per cell. Rows: standard
// drinks, in pairs -- std_drinks can be fractional (a cocktail is 1.5), so the
// edges sit on the halves.
const GAP_BUCKETS = [[0, 1, "<1h"], [1, 2, "1–2h"], [2, 3, "2–3h"], [3, Infinity, "3h+"]];
const DRINK_BUCKETS = [[0, 2.5, "1–2"], [2.5, 4.5, "3–4"], [4.5, 6.5, "5–6"], [6.5, Infinity, "7+"]];
const signedPts = (v) => (Math.round(v) === 0 ? "±0" : v > 0 ? `−${Math.round(v)}` : `+${Math.round(-v)}`);

let timingMetric = "recovery";
function renderTimingCard(D) {
  const { pts, sd } = alcoholTimingPoints(D, timingMetric);
  const label = timingMetric === "score" ? "sleep score" : "recovery";
  // loss = points below the sober average, so a bad night is positive here
  let worst = null;
  const cells = DRINK_BUCKETS.map(([r0, r1, rl]) => GAP_BUCKETS.map(([c0, c1, cl]) => {
    const ns = pts.filter((p) => p.drinks >= r0 && p.drinks < r1 && p.gapH >= c0 && p.gapH < c1);
    const loss = ns.length ? -ns.reduce((a, p) => a + p.dy, 0) / ns.length : NaN;
    if (ns.length && (!worst || loss > worst.loss)) worst = { loss, at: `${rl} drinks, ${cl}` };
    return { n: ns.length, loss };
  }));
  $("timing-card").innerHTML = `
    <div class="card"><h2>Drinks × timing vs next-morning score</h2>
      <p class="readout live tight"><b>${worst ? `${signedPts(worst.loss)} at ${worst.at}` : "No drinking nights yet"}</b></p>
      ${worst ? `<p class="subline">Worst combo vs a sober night · ${pts.length} drinking night${pts.length === 1 ? "" : "s"}</p>` : ""}
      <div class="range" role="tablist" aria-label="Score">
        ${[["recovery", "Recovery"], ["score", "Sleep score"]].map(([k, t]) =>
          `<button class="rbtn" role="tab" aria-selected="${k === timingMetric}" data-metric="${k}" type="button">${t}</button>`).join("")}
      </div>
      <div class="chartbox">${ch.drinkGapGrid(W, {
        rows: DRINK_BUCKETS.map((b) => b[2]), cols: GAP_BUCKETS.map((b) => b[2]), cells, sd, metric: label })}</div></div>`;
}

// Sleep score against the last-drink-to-bed gap, dot size = drinks. The
// headline only states a slope once its 95% interval clears zero; until then
// it says so, because a line through a few nights is mostly the heaviest one.
// Own toggle state, independent of the grid's: flipping one card shouldn't
// silently redraw the other. Opens on sleep score, which it was built around.
let scoreGapMetric = "score";
function renderScoreGapCard(D) {
  const { pts, sd, mean } = alcoholTimingPoints(D, scoreGapMetric);
  const label = scoreGapMetric === "score" ? "sleep score" : "recovery";
  const fit = pts.length >= 3 ? ch.ols(pts.map((p) => [1, p.gapH]), pts.map((p) => p.v)) : null;
  const avg = pts.length ? Math.round(pts.reduce((a, p) => a + p.v, 0) / pts.length) : NaN;
  const head = !pts.length ? "No drinking nights yet"
    : !fit ? "Not enough nights yet"
    : ch.isClear(fit, 1) ? `${fit.b[1] >= 0 ? "+" : "−"}${Math.abs(fit.b[1]).toFixed(1)} per hour later to bed`
    : "No clear trend yet";
  $("score-gap-card").innerHTML = `
    <div class="card"><h2>${scoreGapMetric === "score" ? "Sleep score" : "Recovery"} vs drink timing</h2>
      <p class="readout live tight"><b>${head}</b></p>
      ${pts.length ? `<p class="subline">${pts.length} drinking night${pts.length === 1 ? "" : "s"} · avg ${avg} vs ${Math.round(mean)} sober · bigger dot = more drinks</p>` : ""}
      <div class="range" role="tablist" aria-label="Score">
        ${[["recovery", "Recovery"], ["score", "Sleep score"]].map(([k, t]) =>
          `<button class="rbtn" role="tab" aria-selected="${k === scoreGapMetric}" data-sg-metric="${k}" type="button">${t}</button>`).join("")}
      </div>
      <div class="chartbox">${ch.scoreGapScatter(W, { pts, mean, sd, metric: label })}</div></div>`;
}

// ---------------------------------------------------------- bedtime planner
// One least-squares fit over every paired drinking night:
//   recovery lost vs sober = a + b * drinks + c * hours from last drink to bed
// Linear and additive on purpose -- with a few dozen nights anything with more
// knobs would fit the noise. Below PLAN_MIN_NIGHTS it isn't shown at all, and
// below PLAN_ROUGH_NIGHTS it says it's rough.
const PLAN_MIN_NIGHTS = 5;
const PLAN_ROUGH_NIGHTS = 15;

function fitDrinkGap(pts) {
  if (pts.length < PLAN_MIN_NIGHTS) return null;
  const y = pts.map((p) => -p.dy);
  const full = ch.ols(pts.map((p) => [1, p.drinks, p.gapH]), y);
  // Waiting only counts once it is distinguishable from zero. Until then the
  // gap is dropped and the fit is drinks alone, so bedtime changes nothing --
  // which is what the data says, rather than a slope made of one odd night.
  const gapClear = ch.isClear(full, 2) && full.b[2] < 0;
  const fit = gapClear ? full : ch.ols(pts.map((p) => [1, p.drinks]), y);
  if (!fit) return null;
  return {
    a: fit.b[0], b: fit.b[1], c: gapClear ? fit.b[2] : 0, gapClear, n: pts.length,
    maxGap: Math.max(...pts.map((p) => p.gapH)), maxDrinks: Math.max(...pts.map((p) => p.drinks)),
  };
}

// Tonight's drinks in, a bedtime out: the earliest bed (after the last drink so
// far) whose predicted recovery lands back inside the sober nights' normal
// spread. Never extrapolates past the longest gap the history actually has.
function bedPlanner(D, tn) {
  const { pts, sd, mean } = alcoholTimingPoints(D, "recovery");
  const fit = fitDrinkGap(pts);
  const drinks = tn.reduce((a, r) => a + (Number(r.std_drinks) || 1), 0);
  const last = tn[tn.length - 1].logged_at;
  const time12 = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sub = `${+drinks.toFixed(1)} drink${drinks === 1 ? "" : "s"} · last ${time12(last)}`;
  if (!fit) {
    return `<div class="card planner"><h2>Bedtime planner</h2>
      <p class="readout live tight"><b>Not enough nights yet</b><span> · ${pts.length} of ${PLAN_MIN_NIGHTS}</span></p></div>`;
  }
  const lossAt = (g) => fit.a + fit.b * drinks + fit.c * g;
  const hrs = (h) => { const m = Math.round(h * 60); return m % 60 ? shortDur(m) : `${m / 60}h`; };
  const elapsed = Math.max(0, (Date.now() - last.getTime()) / 3600e3);
  const bedAt = (g) => new Date(last.getTime() + g * 3600e3);
  const per = (v) => Math.max(0, Math.round(Math.abs(v)));
  const caveat = [fit.n < PLAN_ROUGH_NIGHTS && "still rough",
                  drinks > fit.maxDrinks && "more drinks than you've had before"].filter(Boolean);
  const basis = `Based on ${fit.n} nights${caveat.length ? ` — ${caveat.join(", ")}` : ""}.`;
  const drinkLine = fit.b > 0 ? ` Each drink costs ~${per(fit.b)}.` : "";
  const recOf = (loss) => Math.round(Math.min(100, Math.max(0, mean - loss)));

  // No clear waiting effect yet: one number for tonight, no bedtime rows --
  // every row would say the same thing.
  if (!fit.gapClear) {
    const loss = lossAt(0);
    return `<div class="card planner"><h2>Bedtime planner</h2>
      <p class="readout live tight"><b>${loss <= sd ? "Should be a normal night" : `Expect recovery ~${recOf(loss)}`}</b></p>
      <p class="subline">${sub}</p>
      <p class="note">A normal night for you is about ${Math.round(mean)}.${drinkLine}
        Waiting longer before bed hasn't made a clear difference yet. ${basis}</p></div>`;
  }

  // One line of big type; the rows and the footnote carry the rest.
  let head, tail = "";
  if (lossAt(elapsed) <= sd) {
    head = "Bed any time";
  } else {
    const g = Math.ceil(((sd - fit.a - fit.b * drinks) / fit.c) * 4) / 4;   // to the quarter hour
    if (g > fit.maxGap + 0.25) head = "Not back to normal tonight";
    else { head = `Bed after ${time12(bedAt(g))}`; tail = `wait ${hrs(g)}`; }
  }
  // A few concrete options: now, then each whole hour after the last drink,
  // up to the longest gap the history covers.
  const opts = [elapsed];
  for (let h = Math.floor(elapsed) + 1; h <= Math.min(fit.maxGap, elapsed + 3.5) && opts.length < 4; h++) opts.push(h);
  const rows = opts.map((g, k) => {
    const loss = lossAt(g), rec = recOf(loss);
    const good = loss <= sd;
    // A clock time even for the first row: "Now" read as the last drink's time,
    // and stayed "Now" on a screen left open for an hour.
    return `<div class="planrow${good ? " ok" : ""}"><span class="pl">${time12(bedAt(g))}</span>
      <span class="pg">${g >= 5 / 60 ? `+${hrs(g)}` : ""}</span>
      <span class="pv">${rec}</span></div>`;
  }).join("");
  return `<div class="card planner"><h2>Bedtime planner</h2>
    <p class="readout live tight"><b>${head}</b>${tail ? `<span> · ${tail}</span>` : ""}</p>
    <p class="subline">${sub}</p>
    <div class="planhd"><span>Bed at</span><span>Recovery</span></div>
    ${rows}
    <p class="note">A normal night for you is about ${Math.round(mean)}.${drinkLine}
      Each hour you wait gets ~${per(fit.c)} back. ${basis}</p></div>`;
}

const RANGE_PRESETS = [7, 14, 30, 90];

// Smallest preset that covers everything the account actually has, so a fresh
// account's first look at Trends isn't 24 blank days out of 30 -- and capped at
// a week on a phone, where 30 bars across 320px is a grey smear whatever the
// account has in it.
function pickDefaultRange(D) {
  const have = D.dates.length;
  const fit = RANGE_PRESETS.find((n) => n >= have) ?? RANGE_PRESETS[RANGE_PRESETS.length - 1];
  return isNarrow() ? Math.min(fit, 7) : fit;
}

function renderTrendCharts(D, days) {
  $("trends").querySelectorAll(".rbtn[data-days]").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.days) === days)));
  $("trend-cards").innerHTML = `
    ${card(`HRV (rMSSD) — ${days} days`, ch.sparkline(W, D, D.hrv, col("accent"), days, "ms"))}
    ${card(`Resting heart rate — ${days} days`, ch.sparkline(W, D, D.rhr, col("warn"), days, "bpm"))}
    ${card(`Drinks — ${days} days`, ch.bars(W, D, D.drinks, days, col("drink"), Math.round, "drinks"))}
    ${card(`Steps — ${days} days`, ch.bars(W, D, D.steps, days, col("steps"), kfmt, "steps"))}
    ${card(`Sleep Score — ${days} nights`, ch.sparkline(W, D, D.score, col("rem"), days, ""))}`;
  primeReadouts($("trend-cards"));
}

// --------------------------------------------------------------------- tabs
// Under ?debug: where did the bottom tab bar actually land? On a phone in
// standalone mode it has been seen ~47px (the top safe-area inset) above the
// screen's bottom on pages shorter than the screen and flush on tall ones, and
// nothing a desktop browser does reproduces that. So print the numbers instead
// of guessing at them -- viewport, visual viewport, document height, and the
// gap between the bar's bottom and the screen's. Twice: at once, and after the
// page has had time to settle, since the shift may only appear after layout.
function barDbg(tab) {
  if (!DBG) return;
  const say = (when) => {
    const r = document.querySelector(".tabs").getBoundingClientRect(), vv = window.visualViewport;
    dbg(`bar ${tab}/${when}: gap=${Math.round(screen.height - r.bottom)} inner=${innerHeight} ` +
        `vv=${vv ? `${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : "-"} screen=${screen.height} ` +
        `doc=${document.documentElement.scrollHeight} scrollY=${Math.round(scrollY)} ${CTX}`);
  };
  say("now");
  setTimeout(() => say("+400ms"), 400);
}

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b === btn));
    for (const id of ["today", "workouts", "drinks", "trends"]) $(id).hidden = id !== btn.dataset.tab;
    // Trends pools every night the account has, and Workouts has its own
    // month navigation -- a night selector on top of either would be a
    // control that changes nothing on Trends, and a second, conflicting
    // "which date" control on Workouts.
    // The wrapper, not just the selector inside it: .top keeps its bottom margin
    // when empty, and that was 18px of dead space above the calendar -- the
    // Workouts and Drinks pages started lower than the Day page's header.
    $("dash-top").hidden = btn.dataset.tab !== "today";
    tip.hidden = true;
    // The tabs used to sit at the top of the page, so reaching them meant the
    // page was already at scroll 0. At the bottom they can be tapped from deep
    // in a long tab, and the new one would open scrolled to wherever that was.
    scrollTo(0, 0);
    barDbg(btn.dataset.tab);
    if (btn.dataset.tab === "drinks") refreshTonight();
  });
}

// Delegated: the range buttons are rebuilt by every render(), so a handler per
// button would have to be reattached each time (and was).
$("trends").addEventListener("click", (e) => {
  const b = e.target.closest(".rbtn");
  if (!b || !DATA) return;
  if (b.dataset.metric) { timingMetric = b.dataset.metric; renderTimingCard(DATA); return; }
  if (b.dataset.sgMetric) { scoreGapMetric = b.dataset.sgMetric; renderScoreGapCard(DATA); return; }
  renderTrendCharts(DATA, Number(b.dataset.days));
});

// -------------------------------------------------------------- night picker
// ‹ › walks one night at a time, which is a lot of taps to reach the night you
// had a drink three weeks ago. This is the month grid the Drinks and Workouts
// tabs already use, pointed at the Day tab: every loaded night is a target and
// tapping one is setDay(). Own month cursor, like theirs -- browsing March here
// says nothing about which night is selected.
//
// Its dots read the same arrays the Drinks and Workouts calendars do, so a date
// carries the same mark in all three. Mind that the Day tab a cell opens is that
// date's MORNING: the amber dot is the night that STARTS on the date, and the
// aftermath of it (the "drinks the night before" strip) is one day on.
let pickYear = null, pickMonth = null;   // pickMonth is 0-indexed, JS Date style
const monthKey = (iso) => { const [y, m] = iso.split("-").map(Number); return y * 12 + m - 1; };

function openDayPicker() {
  if (!DATA) return;
  const [y, m] = DATA.dates[dayIdx].split("-").map(Number);
  pickYear = y; pickMonth = m - 1;
  renderDayPicker();
  $("day-picker").hidden = false;
  $("day-picker").scrollTop = 0;
}
function closeDayPicker() {
  $("day-picker").hidden = true;
  tip.hidden = true;
}
function stepPickMonth(delta) {
  pickMonth += delta;
  if (pickMonth < 0) { pickMonth = 11; pickYear--; }
  if (pickMonth > 11) { pickMonth = 0; pickYear++; }
  renderDayPicker();
}

function renderDayPicker() {
  const D = DATA;
  const byDate = new Map(D.dates.map((d, i) => [d, i]));
  const first = new Date(pickYear, pickMonth, 1);
  const daysInMonth = new Date(pickYear, pickMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const shown = pickYear * 12 + pickMonth;

  let cells = "";
  for (let k = 0; k < first.getDay(); k++) cells += `<div class="calcell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const idx = byDate.get(`${pickYear}-${pad2(pickMonth + 1)}-${pad2(day)}`);
    if (idx == null) { cells += `<div class="calcell out">${day}</div>`; continue; }
    const dr = (D.nightRows[idx]?.length || 0) > 0, wo = (D.workouts[idx]?.length || 0) > 0;
    const label = new Date(pickYear, pickMonth, day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    cells += `<button type="button" class="calcell pick${idx === dayIdx ? " sel" : ""}" data-pick-idx="${idx}"
      aria-label="${label}"${idx === dayIdx ? ` aria-current="true"` : ""}>${day}${dr || wo
        ? `<span class="pds">${dr ? `<i class="dr"></i>` : ""}${wo ? `<i class="wo"></i>` : ""}</span>` : ""}</button>`;
  }

  $("day-picker-body").innerHTML = `
    <div class="calnav">
      <button class="nav" id="pk-prev" type="button" aria-label="Previous month"${shown <= monthKey(D.dates[0]) ? " disabled" : ""}>‹</button>
      <p class="calmonth">${monthLabel}</p>
      <button class="nav" id="pk-next" type="button" aria-label="Next month"${shown >= monthKey(D.dates[D.dates.length - 1]) ? " disabled" : ""}>›</button>
    </div>
    <div class="calgrid">
      ${CAL_WEEKDAYS.map((d) => `<div class="calhead">${d}</div>`).join("")}
      ${cells}
    </div>`;
}

// ------------------------------------------------------------------ day nav
$("day-prev").addEventListener("click", () => setDay(dayIdx - 1));
$("day-next").addEventListener("click", () => setDay(dayIdx + 1));
$("stamp").addEventListener("click", () => DATA && setDay(DATA.dates.length - 1));
$("pastbar").addEventListener("click", () => DATA && setDay(DATA.dates.length - 1));
addEventListener("keydown", (e) => {
  if (!DATA || $("dash").hidden || currentTab() === "trends" || topOverlay()) return;
  if (e.target.matches?.("input,textarea")) return;
  if (e.key === "ArrowLeft") setDay(dayIdx - 1);
  if (e.key === "ArrowRight") setDay(dayIdx + 1);
});

// ------------------------------------------------------------------- resize
// Charts are authored at a measured pixel width, so a width change is a
// re-render, not a CSS reflow.
//
// This observes the CONTAINER rather than listening for window `resize`,
// because the case that actually bites is a first render before layout has
// settled -- a tab opened in the background, a pane being revealed, a
// home-screen launch behind the splash. The container measures 0, chartWidth()
// falls back to its floor, CSS stretches that viewBox to the real width, and
// every label comes out the wrong size. No window `resize` fires for any of
// that, so the chart would stay wrong until something unrelated moved.
//
// Re-rendering changes the height of #dash but never its width, and the 12px
// threshold ignores the height-only notification, so this cannot feed itself.
function recheckWidth() {
  if (!DATA || $("dash").hidden || document.hidden) return;
  if (Math.abs(chartWidth() - W) >= 12) render();
}

let widthObserver;
function watchWidth() {
  if (!widthObserver && window.ResizeObserver) {
    widthObserver = new ResizeObserver(recheckWidth);
    widthObserver.observe($("dash"));
  }
  // The observer alone is not enough. A hidden document has no rendering
  // lifecycle, so it receives NO resize callbacks at all -- measured in this
  // browser: zero deliveries for an explicit width change while
  // document.hidden was true. That is exactly the state a home-screen PWA
  // launch and a background tab start in, and the render that happens there
  // measures 0 and authors every viewBox at the fallback width. Becoming
  // visible resumes delivery, but re-measuring on the transition itself costs
  // one comparison and does not depend on that.
  addEventListener("visibilitychange", recheckWidth);
  addEventListener("pageshow", recheckWidth);
}

// ------------------------------------------------------------------ sign in
$("signin-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), btn = e.target.querySelector("button"), err = $("signin-error");
  btn.disabled = true; err.hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
  btn.disabled = false;
  if (error) {
    err.textContent = `${error.message}. Accounts are created in Supabase → Authentication → Users.`;
    err.hidden = false;
    return;
  }
  const live = await loadLive();
  if (live) DATA = normalize(live);
  else { isDemo = true; DATA = normalize(await demoData()); }
  render();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot().catch((e) => { show("loading"); document.querySelector("#loading .hint").textContent = e.message; });
