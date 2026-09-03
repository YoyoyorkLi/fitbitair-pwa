// Pulse PWA.
//
// Renders the dashboard from whichever source is available:
//   Supabase   once nights/drinks are populated and you are signed in
//   demo.json  otherwise, or with ?demo=1
//
// Both paths run the identical chart code in charts.js. That is deliberate:
// the preview and the app cannot drift, because there is only one renderer.

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
const card = (ttl, inner, note) =>
  `<div class="card"><h2>${ttl}</h2><div class="chartbox">${inner}</div>${note ? `<p class="note">${note}</p>` : ""}</div>`;

let sb = null, DATA = null, isDemo = false;

// The 4am night boundary and every clock label are computed in this zone. It
// comes from the server (PULSE_TZ) so the browser's own zone -- which is wrong
// the moment you travel -- never decides which night a drink belongs to.
let tz = "America/Chicago";

// ------------------------------------------------------------------ tooltip
// One delegated listener for every mark on the page. Charts opt in by putting
// data-tip on an element; nothing registers a handler of its own.
const tip = Object.assign(document.createElement("div"), { className: "tip" });
tip.hidden = true;
document.body.appendChild(tip);

function moveTip(e, el) {
  const lines = el.getAttribute("data-tip").split("|");
  tip.innerHTML = lines.map((l, i) => `<span class="${i ? "d" : "h"}">${l}</span>`).join("");
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - r.width / 2, 8), innerWidth - r.width - 8);
  const y = e.clientY - r.height - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y < 8 ? e.clientY + 18 : y}px`;
}
function bindTips(root) {
  root.addEventListener("pointermove", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) moveTip(e, el); else tip.hidden = true;
  });
  root.addEventListener("pointerleave", () => { tip.hidden = true; });
  // Touch: a tap shows the value, tapping elsewhere dismisses it.
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    const el = e.target.closest("[data-tip]");
    if (el) moveTip(e, el); else tip.hidden = true;
  });
}

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
        if (live) { DATA = live; return render(); }
      }
    } catch { /* fall through to demo */ }
  }

  isDemo = true;
  DATA = await demoData();
  render();
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
    curve: Array.isArray(last.hr_curve) ? last.hr_curve : [],
    // Same "most recent night that actually has data" fallback the Sleep tab
    // uses for its stats, resolved here against the raw rows rather than
    // last alone -- today has no stages until tonight's sleep syncs, and
    // hypnoFrom(last) would otherwise show "no stage data" even on a night
    // the Sleep tab's own banner says it's displaying.
    hypno: hypnoFrom(
      [...data].reverse().find((r) => Array.isArray(r.stages) && r.stages.length) || last
    ),
    drink_times: [],
  };

  const asleep = n1(last.total_sleep_min), inBed = n1(last.in_bed_min);
  const round = (v) => (ok(v) ? Math.round(v) : NaN);
  D.today = {
    night: last.night,
    strain: ok(n1(last.strain)) ? +n1(last.strain).toFixed(1) : NaN,
    recovery: round(n1(last.recovery)),
    score: round(n1(last.sleep_score)),
    hrv: n1(last.hrv_rmssd), hrvBaseline: n1(last.hrv_baseline), rhr: round(n1(last.rhr)),
    eff: ok(asleep) && inBed > 0 ? Math.round((asleep / inBed) * 100) : NaN,
    debt: n1(last.sleep_debt_min), asleep,
    need: n1(last.sleep_need_min),
    deep: n1(last.deep_min), light: n1(last.light_min),
    rem: n1(last.rem_min), awake: n1(last.waso_min),
    drinks: Number(last.drinks || 0), steps: n1(last.steps),
  };

  if (D.today.drinks) {
    const { data: rows } = await sb
      .from("drinks").select("logged_at").eq("night", last.night).order("logged_at");
    D.drink_times = (rows || []).map((r) =>
      new Date(r.logged_at).toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", timeZone: tz,
      }));
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

// The most recent night that has stage data, for days where you have not slept
// yet. Returns null on a genuinely empty dataset.
function lastSleptNight(D) {
  for (let i = D.dates.length - 1; i >= 0; i--) {
    if (ok(D.asleep[i]) && ok(D.deep[i])) {
      // eff/need must come from THIS night's own in_bed/need, not today's --
      // today is why this fallback exists in the first place (it has not
      // slept, so D.today.eff/need are NaN), and borrowing today's values
      // discarded real numbers Supabase already has for the night being shown.
      const inBed = D.inBed[i], need = D.need[i];
      return { night: D.dates[i], asleep: D.asleep[i], deep: D.deep[i], light: D.light[i],
               rem: D.rem[i], awake: D.awake[i], score: D.score[i],
               eff: ok(D.asleep[i]) && inBed > 0 ? Math.round((D.asleep[i] / inBed) * 100) : NaN,
               need };
    }
  }
  return null;
}

// ------------------------------------------------------------------- render
function render() {
  show("dash");
  const D = DATA, t = D.today;
  $("demo-banner").hidden = !isDemo;
  $("stamp").textContent = `night of ${t.night}`;

  const recCol = t.recovery >= 67 ? col("good") : t.recovery >= 34 ? col("awake") : col("warn");
  const sober = D.recovery.filter((_, i) => !D.drinks[i]);
  const recBase = Math.round(sober.reduce((a, b) => a + b, 0) / sober.length);
  const { m: perDrink } = ch.slope(D);
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
      <span class="txt">drinks last night · HRV <b>${hrvPct}%</b> of your sober average,
        recovery <b>${t.recovery}</b> against a usual <b>${recBase}</b></span></div>` : "";

  $("today").innerHTML = `
    <div class="kpis">
      ${kpi(ch.gauge(t.strain, 21, col("strain"), "Day strain", `Day strain ${t.strain} of 21|Banister TRIMP over every sample, log-compressed`), "Day strain", "target 12.6–15.6")}
      ${kpi(ch.ring(t.recovery, recCol, "Recovery", `Recovery ${t.recovery}|55% HRV · 25% resting HR · 20% sleep`), "Recovery", t.recovery >= 67 ? "well recovered" : t.recovery >= 34 ? "moderate" : "low")}
      ${kpi(ch.ring(t.score, ok(t.score) && t.score >= 80 ? col("good") : col("awake"), "Sleep score", ok(t.score) ? `Sleep score ${t.score}|${hm(t.asleep)} asleep of ${hm(t.need)} needed` : "No sleep recorded yet|last night has not been scored"), "Sleep score", ok(t.asleep) ? hm(t.asleep) : "not yet")}
    </div>
    ${strip}
    <div class="card"><div class="stats">
      ${stat(ok(t.hrv) ? t.hrv : "—", "HRV ms", recCol)}${stat(ok(t.rhr) ? t.rhr : "—", "RHR bpm")}
      ${stat(ok(t.steps) ? t.steps.toLocaleString() : "—", "Steps", col("steps"))}${stat(ok(t.debt) ? hm(t.debt) : "—", "Sleep debt")}
    </div><p class="note">Today is still in progress — strain, steps and time-in-zone are running
      totals and keep climbing until midnight.</p></div>
    ${card("Heart rate — full resolution", ch.hrIntraday(D, t),
      `Zone edges use heart-rate reserve (Karvonen) from RHR ${t.rhr} and HRmax ${D.hrmax}, not the
       220−age shortcut, so they move as your fitness moves.${t.drinks ? " <b>Amber markers are the drinks</b> — the floor never returns to where it started." : ""}`)}
    ${card("Time in zone", `<div class="stats" style="grid-template-columns:repeat(5,1fr)">
      ${[0, 1, 2, 3, 4].map((i) => stat(Math.round(D.z[i].at(-1) || 0) + "m", "Z" + (i + 1), i ? ZONE[i] : null)).join("")}</div>`,
      "The five buckets tile the whole day, so they sum to the time the band was recording.")}
    ${card("Steps — 30 days", ch.bars(D, D.steps, 30, col("steps"), (v) => (v / 1000).toFixed(0) + "k", "steps"),
      `<b>${ok(t.steps) ? t.steps.toLocaleString() + " today." : "None yet today."}</b> Already fetched and cached by the sync — the Python dashboard never drew it.`)}
    ${card("Strain vs target — 21 days", ch.strainHistory(D, 21),
      "Green band is the recovery-scaled target; red bars overshot it. Amber dots carry the drink count.")}`;

  // Today has no sleep until you have slept. Measured on live data: the current
  // day comes back with strain 0.68, ~900 heart-rate samples and every sleep
  // field NaN, which crashes hm() and the hypnogram. Fall back to the last
  // night that actually has stages.
  const slept = ok(t.asleep) && t.deep != null;
  const sn = slept ? t : lastSleptNight(D) ?? t;

  $("sleep").innerHTML = `
    ${slept ? "" : `<div class="banner">No sleep recorded yet for
      <b>${t.night}</b> — showing the night of <b>${sn.night ?? "the last full night"}</b>.</div>`}
    <div class="card"><div class="stats">
      ${stat(ok(sn.asleep) ? hm(sn.asleep) : "—", "Asleep")}${stat(ok(sn.eff) ? sn.eff + "%" : "—", "Efficiency")}
      ${stat(ok(sn.need) ? hm(sn.need) : "—", "Needed")}${stat(ok(sn.score) ? sn.score : "—", "Sleep score", sn.score >= 80 ? col("good") : col("awake"))}
    </div></div>
    ${card("Last night — hypnogram", ch.hypnogram(D.hypno),
      `One continuous ribbon rather than four totals: depth is vertical position, and the connectors
       make each descent visible. <b>C1, C2… mark completed cycles</b> at every REM exit.
       ${ok(D.hypno?.nadirBpm) ? `The teal marker is the <b>heart-rate floor</b> — ${D.hypno.nadirBpm} bpm,
         ${hm(D.hypno.nadirMin)} after falling asleep. On a sober night that floor usually lands within
         the first 90 minutes; alcohol pushes it later and keeps it higher.` : ""}
       ${t.drinks ? "Alcohol shows up as structure — deep sleep front-loaded, REM pushed late and short." : ""}`)}
    ${card("Stages vs your 30-night baseline", ch.stagesVsBaseline(D, sn),
      "Faded bar is your 30-night average, solid is last night. <b>REM is the stage alcohol takes first</b> — and deep sleep often goes <i>up</i>, which is why the score alone can flatter a wrecked night.")}
    ${card("Sleep consistency — last 14 nights", ch.sleepColumns(D, 14),
      "Each night stacked by stage on a shared duration axis. Amber dots mark drinking nights.")}
    ${card("Sleep debt — 30 days", ch.debtArea(D, 30),
      "Rolling shortfall against your nightly need. Three short nights is a week of catching up.")}`;

  // The dose-response chart pools every night the account has ever had --
  // more history is always better for a fit, so it stays outside the range
  // toggle below. The four trend charts are windowed reads of the *same*
  // day-count, though, and a fixed 30-day window on a 6-night-old account
  // draws 24 empty days before a single real point: not broken, just a
  // window sized for data that doesn't exist yet. RANGE_PRESETS lets the
  // window fit the account instead of the account fitting the window.
  $("trends").innerHTML = `
    ${card("Drinks vs next-morning HRV", ch.doseResponse(D),
      `<b>The chart this project exists for.</b> The fit currently reads
       <b>${perDrink.toFixed(1)}% of baseline HRV per drink</b>. One dot per night, amber where drinks
       were logged; the dashed line is your sober average. With ~20 drinking nights the slope becomes
       your personal dose–response — measured on you, not taken from a guideline.`)}
    <div class="range" role="tablist" aria-label="Trend window">
      ${RANGE_PRESETS.map((n) => `<button class="rbtn" role="tab" aria-selected="false" data-days="${n}">${n}d</button>`).join("")}
    </div>
    <div id="trend-cards"></div>`;

  renderTrendCharts(D, pickDefaultRange(D));

  $("trends").querySelectorAll(".rbtn").forEach((b) => {
    b.addEventListener("click", () => {
      $("trends").querySelectorAll(".rbtn").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      renderTrendCharts(D, Number(b.dataset.days));
    });
  });

  bindTips($("dash"));
}

const RANGE_PRESETS = [7, 14, 30, 90];

// Smallest preset that covers everything the account actually has, so a
// fresh account's first look at Trends isn't 24 blank days out of 30.
function pickDefaultRange(D) {
  const have = D.dates.length;
  return RANGE_PRESETS.find((n) => n >= have) ?? RANGE_PRESETS[RANGE_PRESETS.length - 1];
}

function renderTrendCharts(D, days) {
  $("trends").querySelectorAll(".rbtn").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.days) === days)));
  $("trend-cards").innerHTML = `
    ${card(`HRV (rMSSD) — ${days} days`, ch.sparkline(D, D.hrv, col("accent"), days, "ms"),
      "Amber dots are mornings after drinking. The most responsive alcohol marker on a wearable, and the noisiest night to night.")}
    ${card(`Resting heart rate — ${days} days`, ch.sparkline(D, D.rhr, col("warn"), days, "bpm"),
      "Less responsive than HRV but far steadier — a +5bpm morning is hard to explain any other way.")}
    ${card(`Steps — ${days} days`, ch.bars(D, D.steps, days, col("steps"), (v) => (v / 1000).toFixed(0) + "k", "steps"),
      "Worth reading against strain: high steps with low strain is a long walk; the reverse is a hard session.")}
    ${card(`Sleep score — ${days} nights`, ch.sparkline(D, D.score, col("rem"), days, ""),
      "Treat with suspicion on drinking nights: front-loaded slow-wave sleep holds the score up while REM collapses.")}`;
}

// --------------------------------------------------------------------- tabs
for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b === btn));
    for (const id of ["today", "sleep", "trends"]) $(id).hidden = id !== btn.dataset.tab;
    tip.hidden = true;
  });
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
  DATA = await loadLive();
  if (!DATA) { isDemo = true; DATA = await demoData(); }
  render();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot().catch((e) => { show("loading"); document.querySelector("#loading .hint").textContent = e.message; });
