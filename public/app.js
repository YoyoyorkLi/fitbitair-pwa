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
const card = (ttl, inner, note, scrub = true) =>
  `<div class="card"><h2>${ttl}</h2>${scrub ? `<p class="readout" aria-live="polite"></p>` : ""}
   <div class="chartbox">${inner}</div>${note ? `<p class="note">${note}</p>` : ""}</div>`;

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
  if (!bands.length) return;
  const r = svgEl.getBoundingClientRect();
  if (!r.width) return;
  // Pointer x -> user units. viewBox width is the chart's own coordinate space,
  // which equals its CSS width by construction but is read rather than assumed
  // so a mid-resize render cannot put the crosshair somewhere else.
  const ux = ((clientX - r.left) / r.width) * svgEl.viewBox.baseVal.width;
  let best = 0, bd = Infinity;
  svgEl._xs.forEach((x, i) => { const d = Math.abs(x - ux); if (d < bd) { bd = d; best = i; } });
  setScrub(svgEl, best);
}

function bindScrub(root) {
  let drag = null;
  root.addEventListener("pointerdown", (e) => {
    const s = e.target.closest?.("svg[data-scrub]");
    if (!s) return;
    drag = s;
    // Capture on the svg so a finger that wanders off the chart vertically
    // keeps scrubbing instead of dropping the gesture mid-drag.
    try { s.setPointerCapture(e.pointerId); } catch { /* not all pointers */ }
    scrubAt(s, e.clientX);
  });
  root.addEventListener("pointermove", (e) => {
    if (drag) { scrubAt(drag, e.clientX); return; }
    if (e.pointerType !== "mouse") return;          // touch scrubs only while down
    const s = e.target.closest?.("svg[data-scrub]");
    if (s) scrubAt(s, e.clientX);
  });
  for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, () => { drag = null; });
}

// Every scrubbable chart starts showing its newest sample, so the readout row
// is never an empty band of space waiting to be earned. The crosshair stays
// hidden until touched -- the number is useful unprompted, a line across the
// chart is not.
function primeReadouts(root) {
  for (const s of root.querySelectorAll("svg[data-scrub]")) {
    const bands = bandsOf(s);
    if (bands.length) setScrub(s, bands.length - 1, false);
  }
}

// -------------------------------------------------------------------- swipe
// Secondary to the ‹ › buttons, never the only way to do anything. Deliberately
// strict: 64px of travel and twice as much horizontal as vertical, or a thumb
// drifting during a normal scroll would throw you onto another night.
function bindSwipe(root) {
  let sx = 0, sy = 0, live = false;
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    if (e.target.closest?.("svg[data-scrub], button, a, input")) return;
    sx = e.clientX; sy = e.clientY; live = true;
  });
  root.addEventListener("pointerup", (e) => {
    if (!live) return;
    live = false;
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

  if (!params.has("demo")) {
    try {
      const cfg = await fetch("/api/config").then((r) => r.json());
      if (!cfg.error) {
        if (cfg.tz) tz = cfg.tz;
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
  if (D.drinks.some(Boolean)) {
    const { data: rows } = await sb
      .from("drinks").select("night,logged_at").gte("night", D.dates[0]).order("logged_at");
    const byNight = {};
    for (const r of rows || []) {
      (byNight[r.night] ||= []).push(new Date(r.logged_at).toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", timeZone: tz,
      }));
    }
    D.drinkTimes = D.dates.map((d) => byNight[d] || []);
  }
  return D;
}

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
}

function setDay(i) {
  const next = Math.max(0, Math.min(DATA.dates.length - 1, i));
  if (next === dayIdx) return;
  dayIdx = next;
  tip.hidden = true;
  renderDay();
}

function updateDayNav(D, i) {
  const latest = i === D.dates.length - 1;
  const d = new Date(D.dates[i] + "T12:00:00");   // noon: no zone can roll it
  const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  $("stamp").textContent = latest ? `${label} · latest` : label;
  $("stamp").title = latest ? "" : "Back to the latest night";
  $("day-prev").disabled = i <= 0;
  $("day-next").disabled = latest;
  $("daynav").classList.toggle("stepped", !latest);
}

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
      <span class="txt">drinks this night${ok(hrvPct) ? ` · HRV <b>${hrvPct}%</b> of your sober average` : ""}${
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
    ${card("Heart rate — overnight", ch.hrIntraday(W, {
        curve: D.curves[i], drinks: D.drinkTimes[i],
        sleepStart: D.hypnos[i]?.start ?? null, hrmax: D.hrmax, rhr: t.rhr,
      }),
      `Drag across the chart to read any point. The window starts two hours before sleep${t.drinks ? " or at the first drink, whichever came first" : ""} —
       the six hours of evening either side of it were flattening the part that matters.
       Zone edges use heart-rate reserve (Karvonen) from RHR ${ok(t.rhr) ? t.rhr : "—"} and HRmax ${D.hrmax}, not the
       220−age shortcut, so they move as your fitness moves.${t.drinks ? " <b>Amber markers are the drinks</b> — the floor never returns to where it started." : ""}`)}
    ${card("Time in zone", `<div class="stats" style="grid-template-columns:repeat(5,1fr)">
      ${[0, 1, 2, 3, 4].map((k) => stat(Math.round(D.z[k]?.[i] || 0) + "m", "Z" + (k + 1), k ? ZONE[k] : null)).join("")}</div>`,
      "The five buckets tile the whole day, so they sum to the time the band was recording.", false)}
    ${card(`Steps — ${stepsDays} days`, ch.bars(W, D, D.steps, stepsDays, col("steps"), kfmt, "steps"),
      `<b>${ok(t.steps) ? t.steps.toLocaleString() + " on this night's day." : "None recorded."}</b> Already fetched and cached by the sync — the Python dashboard never drew it.`)}
    ${card(`Strain vs target — ${strainDays} days`, ch.strainHistory(W, D, strainDays),
      "Green band is the recovery-scaled target; red bars overshot it. Amber dots carry the drink count.")}`;

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
    ${card("Hypnogram", ch.hypnogram(W, hyp),
      `One continuous ribbon rather than four totals: depth is vertical position, and the connectors
       make each descent visible. <b>C1, C2… mark completed cycles</b> at every REM exit.
       ${ok(hyp?.nadirBpm) ? `The teal marker is the <b>heart-rate floor</b> — ${hyp.nadirBpm} bpm,
         ${hm(hyp.nadirMin)} after falling asleep. On a sober night that floor usually lands within
         the first 90 minutes; alcohol pushes it later and keeps it higher.` : ""}
       ${t.drinks ? "Alcohol shows up as structure — deep sleep front-loaded, REM pushed late and short." : ""}`, false)}
    ${card("Stages vs your 30-night baseline", ch.stagesVsBaseline(W, D, sn),
      "Faded bar is your 30-night average, solid is this night. <b>REM is the stage alcohol takes first</b> — and deep sleep often goes <i>up</i>, which is why the score alone can flatter a wrecked night.", false)}
    ${card(`Sleep consistency — last ${colDays} nights`, ch.sleepColumns(W, D, colDays),
      "Each night stacked by stage on a shared duration axis. Amber dots mark drinking nights.")}
    ${card(`Sleep debt — ${debtDays} days`, ch.debtArea(W, D, debtDays),
      "Rolling shortfall against your nightly need. Three short nights is a week of catching up.")}`;

  primeReadouts($("dash"));
}

// The dose-response chart pools every night the account has ever had -- more
// history is always better for a fit, so it stays outside the range toggle
// below. The four trend charts are windowed reads of the *same* day-count.
function renderTrends(D) {
  const { m: perDrink } = ch.slope(D);
  $("trends").innerHTML = `
    ${card("Drinks vs next-morning HRV", ch.doseResponse(W, D),
      `<b>The chart this project exists for.</b> The fit currently reads
       <b>${perDrink.toFixed(1)}% of baseline HRV per drink</b>. One dot per night, amber where drinks
       were logged; the dashed line is your sober average. With ~20 drinking nights the slope becomes
       your personal dose–response — measured on you, not taken from a guideline.`, false)}
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
    ${card(`HRV (rMSSD) — ${days} days`, ch.sparkline(W, D, D.hrv, col("accent"), days, "ms"),
      "Amber dots are mornings after drinking. The most responsive alcohol marker on a wearable, and the noisiest night to night.")}
    ${card(`Resting heart rate — ${days} days`, ch.sparkline(W, D, D.rhr, col("warn"), days, "bpm"),
      "Less responsive than HRV but far steadier — a +5bpm morning is hard to explain any other way.")}
    ${card(`Steps — ${days} days`, ch.bars(W, D, D.steps, days, col("steps"), kfmt, "steps"),
      "Worth reading against strain: high steps with low strain is a long walk; the reverse is a hard session.")}
    ${card(`Sleep score — ${days} nights`, ch.sparkline(W, D, D.score, col("rem"), days, ""),
      "Treat with suspicion on drinking nights: front-loaded slow-wave sleep holds the score up while REM collapses.")}`;
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
