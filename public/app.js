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
// header's ‹ › controls. Everything the Day and Sleep tabs draw comes out of
// the arrays already loaded for the whole 45-night window, so stepping is a
// re-render and never a fetch.

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

// Module-level, not local to render(): renderTrendCharts() (the range-toggle
// handler) rebuilds part of the Trends tab independently of a full render(),
// and needs the same markup helpers -- one definition, not a second copy that
// could quietly drift from the first.
const kpi = (c, cap, sub) => `<div class="kpi">${c}<p class="cap">${cap}</p><p class="sub">${sub}</p></div>`;
const stat = (v, k, c) => `<div class="stat"><div class="v"${c ? ` style="color:${c}"` : ""}>${v}</div><div class="k">${k}</div></div>`;
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

let sb = null, DATA = null, isDemo = false;

// Which night the Day and Sleep tabs are showing. -1 until data lands, then
// pinned to the newest night; the ‹ › controls and the swipe gesture move it.
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
// values land in the card's readout row. This replaces hover on touch, where
// hover does not exist -- previously a phone could only tap one 3px mark at a
// time and got a bubble underneath its own thumb for the trouble.
//
// The contract with charts.js: the <svg> carries data-scrub, and every sample
// has a `rect[data-i]` hit band carrying data-x (centre, in user units),
// optional data-y (the mark, for the cursor dot) and data-tip (the text).
// Nothing here re-derives a scale, so the crosshair cannot drift from the marks.
// ---- touch diagnostics, behind ?debug ------------------------------------
// Two fixes for the same frozen-scrubber bug were built on reasoning a desktop
// browser could not falsify, and both were wrong. This prints what the phone
// actually does. Entirely inert without the query param.
// ?debug turns the overlay on in a browser tab. It cannot turn it on in the
// INSTALLED app, which is the context this bug is now suspected to live in:
// the home-screen app launches at start_url ("/") with no address bar, so the
// query string is unreachable, and its storage is a separate partition from
// Safari's (see the sign-in note in index.html), so a flag set in the browser
// does not carry across either. Five taps on the wordmark, then.
const DBG_KEY = "pulse-debug";
const stickyDbg = () => { try { return localStorage.getItem(DBG_KEY) === "1"; } catch { return false; } };
let DBG = new URLSearchParams(location.search).has("debug") || stickyDbg();
let brandTaps = 0, brandTimer = null;
addEventListener("click", (e) => {
  if (!e.target.closest?.(".brand")) return;
  clearTimeout(brandTimer);
  brandTimer = setTimeout(() => { brandTaps = 0; }, 2000);
  if (++brandTaps < 5) return;
  brandTaps = 0;
  DBG = !DBG;
  try { localStorage.setItem(DBG_KEY, DBG ? "1" : "0"); } catch { /* private mode */ }
  if (DBG) dbg(`debug ON ${CTX} | BUILD ${BUILD} | tap the wordmark 5x to stop`);
  else if (dbgBox) { dbgBox.remove(); dbgBox = null; }
});
// Bumped by hand whenever the scrubber changes. Compared against the commit
// /api/config reports, so a stale cached bundle is visible instead of inferred.
const BUILD = "steppers+pwadbg+bootline";
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
  box.textContent = "";
  String(tipText).split("|").forEach((s, i) => {
    const el = document.createElement(i ? "span" : "b");
    el.textContent = s;
    box.appendChild(el);
  });
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
  dbg(`scrubAt ux=${ux.toFixed(0)} -> band ${best}/${bands.length}`);
  setScrub(svgEl, best);
}

// Safari tab or installed home-screen app? iOS runs those in different
// contexts with different gesture recognizers, and every device log so far was
// taken without recording which one produced it. It is one string; print it.
const CTX = matchMedia("(display-mode: standalone)").matches ||
            navigator.standalone ? "[PWA]" : "[tab]";

function bindScrub(root) {
  let drag = null, sx = 0, sy = 0, axis = null;
  let nPointer = 0, nTouch = 0;          // per-gesture, reset on every start

  // Consume BOTH event streams instead of betting on one.
  //
  // The device has now shown pointermove and touchmove each failing to arrive
  // on different charts -- the heart-rate chart got 46 touchmoves and no
  // usable pointermoves, the 14-band charts got neither. Rather than keep
  // guessing which stream iOS will honour for a given element, take whichever
  // shows up; scrubAt is idempotent, so being driven twice for one movement
  // costs a redundant index lookup and nothing else.
  const CLAIM_X = 10;
  const RELEASE_Y = 24;

  const begin = (svgEl, x, y) => {
    drag = svgEl; sx = x; sy = y; axis = null;
    nPointer = 0; nTouch = 0;            // reset HERE, not at the end -- the
    scrubAt(svgEl, x);                   // previous version counted the moves
  };                                     // of the gesture before this one

  const move = (x, y) => {
    if (!drag) return;
    const dx = Math.abs(x - sx), dy = Math.abs(y - sy);
    if (!axis) {
      if (dx >= CLAIM_X) { axis = "x"; dbg(`axis=x (dx=${dx | 0} dy=${dy | 0})`); }
      else if (dy >= RELEASE_Y) { dbg(`axis=y, releasing (dx=${dx | 0} dy=${dy | 0})`); drag = null; return; }
    }
    scrubAt(drag, x);
  };

  const end = (why) => {
    if (drag) dbg(`${why}: pointermoves=${nPointer} touchmoves=${nTouch} axis=${axis} ${CTX}`);
    drag = null; axis = null;
  };

  root.addEventListener("pointerdown", (e) => {
    const s = e.target.closest?.("svg[data-scrub]");
    dbg(`pointerdown(${e.pointerType}) -> ${s ? s.dataset.scrub + ", " + s.querySelectorAll("rect[data-i]").length + " bands" : "no chart"}`);
    if (s) begin(s, e.clientX, e.clientY);
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
    nTouch++;                             // count BEFORE any guard: the old
    const t = e.touches[0];               // order could report 0 touchmoves
    if (!t) return;                       // while touchmoves were arriving
    if (e.cancelable) e.preventDefault();
    move(t.clientX, t.clientY);
  }, { passive: false });

  // Claim the gesture at touchstart, non-passively.
  //
  // This is the one thing eight attempts never actually did. Attempt #2 was
  // "claim the gesture with preventDefault", but it put the call in the move
  // handler -- which is the handler that never runs, so no preventDefault in
  // the touch path has ever executed. Attempts #6-#10 all tried to say the
  // same thing declaratively with touch-action, which WebKit applies to
  // scrolling and zooming; it is not what arms the selection, callout and
  // drag recognizers.
  //
  // preventDefault() on a NON-PASSIVE touchstart is the imperative version,
  // and it is the documented way to tell WebKit a touch sequence belongs to
  // the page. The old listener was registered { passive: true }, where
  // preventDefault is a no-op the browser ignores, so this could not have
  // worked even if it had been called.
  //
  // Cost: the synthesized click on a chart is suppressed. Nothing binds click
  // on a chart -- scrubbing runs off pointerdown -- and page scrolling from a
  // chart was already given up to touch-action:none, so there is nothing left
  // here to lose. Steppers are outside .chartbox and keep their clicks.
  root.addEventListener("touchstart", (e) => {
    const s = e.target.closest?.("svg[data-scrub]");
    if (!s) return;
    if (e.cancelable) e.preventDefault();
    if (drag) return;                     // pointerdown already handled it
    const t = e.changedTouches[0];
    dbg(`touchstart (no pointerdown) -> ${s.dataset.scrub}`);
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
function bindSwipe(root) {
  let sx = 0, sy = 0, sTop = 0, live = false;
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    if (e.target.closest?.("svg[data-scrub], button, a, input")) return;
    sx = e.clientX; sy = e.clientY; sTop = scrollY; live = true;
  });
  // iOS hands a gesture to its own scroller and CANCELS our pointer rather than
  // ending it. Without this the flag stayed set, and a later, unrelated
  // pointerup got measured against a stale start point -- which silently
  // stepped the day. That is how you end up reading yesterday without having
  // touched the date control.
  root.addEventListener("pointercancel", () => { live = false; });
  root.addEventListener("pointerup", (e) => {
    if (!live) return;
    live = false;
    // If the page moved under the finger, that was a scroll, whatever the net
    // horizontal distance ended up being. Cheaper and far more reliable than
    // trying to out-guess the gesture from dx/dy alone.
    if (Math.abs(scrollY - sTop) > 8) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 2) return;
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
// holds one `curve` and one `hypno`, for its newest night only. Rather than
// invent 39 more, the older nights get an empty curve and the chart says so.
// Everything else in the fixture is already a full 40-night array.
function normalize(D) {
  const n = D.dates.length, last = n - 1;
  const only = (v) => Array.from({ length: n }, (_, i) => (i === last ? v : null));
  D.curves ??= only(D.curve || []).map((v) => v || []);
  D.hypnos ??= only(D.hypno || null);
  D.drinkTimes ??= only(D.drink_times || []).map((v) => v || []);
  for (const k of ["inBed", "need", "hrvBaseline"]) D[k] ??= [];
  return D;
}

// Pull the last 45 nights out of night_summary and shape them exactly like
// demo.json, so render() and every chart stay source-agnostic. Returns null
// when the sync has not populated anything yet.
//
// Two queries, not one: night_summary aggregates drinks to a count, but the
// heart-rate chart needs each drink's clock time to place its marker.
async function loadLive() {
  const { data, error } = await sb
    .from("night_summary").select("*").order("night", { ascending: true }).limit(45);
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

  // Target strain is Bevel's idea, recomputed here rather than stored: it is a
  // pure function of recovery (metrics.optimal_strain), so storing it would be
  // a second copy of the same number that could drift.
  const rec = num("recovery");
  const target_lo = rec.map((v) => (ok(v) ? +(8 + 0.1 * v - 1.5).toFixed(1) : NaN));
  const target_hi = rec.map((v) => (ok(v) ? +(8 + 0.1 * v + 1.5).toFixed(1) : NaN));

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
    z, target_lo, target_hi,
    hrmax: Number(last.hrmax) || 192,
    // Per night, not just the newest one: hr_curve and stages are columns on
    // every row of night_summary and are already in this response (select "*"),
    // so browsing back through nights costs nothing beyond the render.
    curves: data.map((r) => (Array.isArray(r.hr_curve) ? r.hr_curve : [])),
    hypnos: data.map(hypnoFrom),
    drinkTimes: data.map(() => []),
  };

  // One query for every drink in the window rather than one per night visited.
  // A heavy night is ~8 rows, so 45 nights is a couple of hundred at worst --
  // cheaper in one round trip than in a fetch each time you press ‹.
  // Grouped by the CIVIL DAY each drink happened on, not by its drinking-night
  // key. hr_curve is now one midnight-to-midnight day, so a session that runs
  // 9pm to 1am has its markers split across two consecutive charts -- which is
  // what the day stepper is for. Night keys still drive the dose-response
  // count; they just no longer decide what gets drawn on a day's curve.
  //
  // One day earlier than the first row: a drink at 1am on dates[0] carries the
  // night key of the day before, so a gte on dates[0] would miss it.
  if (D.drinks.some(Boolean)) {
    const from = new Date(`${D.dates[0]}T12:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const { data: rows } = await sb
      .from("drinks").select("night,logged_at")
      .gte("night", from.toISOString().slice(0, 10)).order("logged_at");
    const byDay = {};
    for (const r of rows || []) {
      const at = new Date(r.logged_at);
      const day = at.toLocaleDateString("en-CA", { timeZone: tz });   // YYYY-MM-DD
      (byDay[day] ||= []).push(at.toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", timeZone: tz,
      }));
    }
    D.drinkTimes = D.dates.map((d) => byDay[d] || []);
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
  return {
    i, night: D.dates[i],
    strain: ok(strain) ? +strain.toFixed(1) : NaN,
    recovery: round(at(D.recovery)),
    score: round(at(D.score)),
    hrv: at(D.hrv), hrvBaseline: at(D.hrvBaseline), rhr: round(at(D.rhr)),
    eff: ok(asleep) && inBed > 0 ? Math.round((asleep / inBed) * 100) : NaN,
    debt: at(D.debt), asleep, need: at(D.need),
    deep: at(D.deep), light: at(D.light), rem: at(D.rem), awake: at(D.awake),
    drinks: Number(D.drinks[i] || 0), steps: at(D.steps),
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
let reported = false;
function render() {
  show("dash");
  W = chartWidth();
  const D = DATA;
  if (dayIdx < 0 || dayIdx >= D.dates.length) dayIdx = D.dates.length - 1;
  $("demo-banner").hidden = !isDemo;
  renderTrends(D);
  renderDay();
  if (!bound) {
    bound = true;
    bindTips($("dash"));
    bindScrub($("dash"));
    bindSwipe($("dash"));
    watchWidth();
  }
  // The visible proof that the new bundle is the one running: old code renders
  // no steppers at all, so "0" here and "BUILD ..." above disagree only if the
  // HTML and the JS came from different deploys.
  if (DBG && !reported) {
    reported = true;
    dbg(`rendered: ${document.querySelectorAll(".step").length} stepper buttons, ` +
        `${document.querySelectorAll("svg[data-scrub]").length} scrub charts`);
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
    const live = await loadLive();
    if (live) {
      DATA = normalize(live);
      // Hold the night you were reading, by DATE not index -- a sync can add a
      // row and shift every index under you.
      const i = wasOn ? DATA.dates.indexOf(wasOn) : -1;
      dayIdx = i >= 0 ? i : DATA.dates.length - 1;
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

  $("stamp").textContent = suffix ? `${label} · ${suffix}` : label;
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

function renderDay() {
  const D = DATA, i = dayIdx, t = viewFor(D, i);
  const latest = i === D.dates.length - 1;
  updateDayNav(D, i);

  const recCol = t.recovery >= 67 ? col("good") : t.recovery >= 34 ? col("awake") : col("warn");
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
      ${kpi(ch.gauge(t.strain, 21, col("strain"), "Day strain", `Day strain ${t.strain} of 21|Banister TRIMP over every sample, log-compressed`), "Day strain", "target 12.6–15.6")}
      ${kpi(ch.ring(t.recovery, recCol, "Recovery", `Recovery ${t.recovery}|55% HRV · 25% resting HR · 20% sleep`), "Recovery", t.recovery >= 67 ? "well recovered" : t.recovery >= 34 ? "moderate" : "low")}
      ${kpi(ch.ring(t.score, ok(t.score) && t.score >= 80 ? col("good") : col("awake"), "Sleep score", ok(t.score) ? `Sleep score ${t.score}|${hm(t.asleep)} asleep of ${hm(t.need)} needed` : "No sleep recorded|this night has not been scored"), "Sleep score", ok(t.asleep) ? hm(t.asleep) : "not yet")}
    </div>
    ${strip}
    <div class="card"><div class="stats">
      ${stat(ok(t.hrv) ? t.hrv : "—", "HRV ms", recCol)}${stat(ok(t.rhr) ? t.rhr : "—", "RHR bpm")}
      ${stat(ok(t.steps) ? t.steps.toLocaleString() : "—", "Steps", col("steps"))}${stat(ok(t.debt) ? hm(t.debt) : "—", "Sleep debt")}
    </div>${latest ? `<p class="note">Today is still in progress — strain, steps and time-in-zone are running
      totals and keep climbing until midnight.</p>` : ""}</div>
    ${card("Heart rate", ch.hrIntraday(W, {
        curve: D.curves[i], drinks: D.drinkTimes[i], hrmax: D.hrmax, rhr: t.rhr,
      }))}
    ${card("Time in zone", `<div class="stats" style="grid-template-columns:repeat(5,1fr)">
      ${[0, 1, 2, 3, 4].map((k) => stat(Math.round(D.z[k]?.[i] || 0) + "m", "Z" + (k + 1), k ? ZONE[k] : null)).join("")}</div>`,
      "", false)}
    ${card(`Steps — ${stepsDays} days`, ch.bars(W, D, D.steps, stepsDays, col("steps"), kfmt, "steps"))}
    ${card(`Strain vs target — ${strainDays} days`, ch.strainHistory(W, D, strainDays))}`;

  // A night has no sleep until you have slept it. Measured on live data: the
  // current day comes back with strain 0.68, ~900 heart-rate samples and every
  // sleep field NaN, which crashes hm() and the hypnogram. Fall back to the
  // most recent night at or before this one that actually has stages.
  const slept = ok(t.asleep) && ok(t.deep);
  const sn = slept ? t : lastSleptNight(D, i) ?? t;
  const hyp = D.hypnos[slept ? i : sn.i ?? i];
  const colDays = win(D, 14, 7), debtDays = win(D, 30, 14);

  $("sleep").innerHTML = `
    ${slept ? "" : `<div class="banner">No sleep recorded for
      <b>${t.night}</b> — showing the night of <b>${sn.night ?? "the last full night"}</b>.</div>`}
    <div class="card"><div class="stats">
      ${stat(ok(sn.asleep) ? hm(sn.asleep) : "—", "Asleep")}${stat(ok(sn.eff) ? sn.eff + "%" : "—", "Efficiency")}
      ${stat(ok(sn.need) ? hm(sn.need) : "—", "Needed")}${stat(ok(sn.score) ? sn.score : "—", "Sleep score", sn.score >= 80 ? col("good") : col("awake"))}
    </div></div>
    ${card("Hypnogram", ch.hypnogram(W, hyp))}
    ${card("Stages vs your 30-night baseline", ch.stagesVsBaseline(W, D, sn), "", false)}
    ${card(`Sleep consistency — last ${colDays} nights`, ch.sleepColumns(W, D, colDays))}
    ${card(`Sleep debt — ${debtDays} days`, ch.debtArea(W, D, debtDays))}`;

  primeReadouts($("dash"));
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
      <p class="readout live"><b>${perDrink.toFixed(1)}% of baseline HRV per drink</b><span>${nights} drinking night${nights === 1 ? "" : "s"}</span></p>
      <div class="chartbox">${ch.doseResponse(W, D)}</div></div>
    <div class="range" role="tablist" aria-label="Trend window">
      ${RANGE_PRESETS.map((n) => `<button class="rbtn" role="tab" aria-selected="false" data-days="${n}" type="button">${n}d</button>`).join("")}
    </div>
    <div id="trend-cards"></div>`;
  renderTrendCharts(D, pickDefaultRange(D));
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
  $("trends").querySelectorAll(".rbtn").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.days) === days)));
  $("trend-cards").innerHTML = `
    ${card(`HRV (rMSSD) — ${days} days`, ch.sparkline(W, D, D.hrv, col("accent"), days, "ms"))}
    ${card(`Resting heart rate — ${days} days`, ch.sparkline(W, D, D.rhr, col("warn"), days, "bpm"))}
    ${card(`Steps — ${days} days`, ch.bars(W, D, D.steps, days, col("steps"), kfmt, "steps"))}
    ${card(`Sleep score — ${days} nights`, ch.sparkline(W, D, D.score, col("rem"), days, ""))}`;
  primeReadouts($("trend-cards"));
}

// --------------------------------------------------------------------- tabs
for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b === btn));
    for (const id of ["today", "sleep", "trends"]) $(id).hidden = id !== btn.dataset.tab;
    // Trends pools every night the account has; a night selector on top of it
    // would be a control that changes nothing.
    $("daynav").hidden = btn.dataset.tab === "trends";
    tip.hidden = true;
  });
}

// Delegated: the range buttons are rebuilt by every render(), so a handler per
// button would have to be reattached each time (and was).
$("trends").addEventListener("click", (e) => {
  const b = e.target.closest(".rbtn");
  if (b && DATA) renderTrendCharts(DATA, Number(b.dataset.days));
});

// ------------------------------------------------------------------ day nav
$("day-prev").addEventListener("click", () => setDay(dayIdx - 1));
$("day-next").addEventListener("click", () => setDay(dayIdx + 1));
$("stamp").addEventListener("click", () => DATA && setDay(DATA.dates.length - 1));
$("pastbar").addEventListener("click", () => DATA && setDay(DATA.dates.length - 1));
addEventListener("keydown", (e) => {
  if (!DATA || $("dash").hidden || currentTab() === "trends") return;
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
