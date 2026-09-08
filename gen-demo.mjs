// Regenerate public/demo.json — the synthetic fixture the PWA falls back to
// when there is no /api/config (signed-out visitor, ?demo=1, the offline
// preview). Deterministic: same seed, same file.
//
//     node gen-demo.mjs
//
// The point is a fixture that is internally CONSISTENT. The old hand-made one
// had you asleep at 6:32pm while logging drinks at 11, and a heart-rate curve
// that sat at 60bpm through the drinking window and 82bpm through deep sleep.
// Here every night's sleep starts after its last drink, the curve is elevated
// while drinking and low while asleep, and the stage totals, the hypnogram and
// the zone minutes all come from the same numbers.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "public/demo.json");

// ---- deterministic RNG ----------------------------------------------------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260907);
const rand = (lo, hi) => lo + (hi - lo) * rng();
const randn = (m, s) => {                                  // Box-Muller
  const u = 1 - rng(), v = rng();
  return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const ri = (lo, hi) => Math.round(rand(lo, hi));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---- calendar -----------------------------------------------------------
const N = 40;
const END = new Date("2026-09-06T00:00:00Z");              // newest NIGHT (yesterday)
const dates = [];
for (let i = N - 1; i >= 0; i--) {
  const d = new Date(END); d.setUTCDate(d.getUTCDate() - i);
  dates.push(d.toISOString().slice(0, 10));
}
const iso = (day, hh, mm) => `${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
const hhmm = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// ---- which nights had what --------------------------------------------------
// Drinking nights: spread out, never back-to-back, a couple of heavy ones.
const DRINK = Array(N).fill(0);
const drinkPlan = [
  [3, 3], [6, 2], [10, 4], [13, 3], [17, 5], [21, 2], [24, 4],
  [28, 3], [31, 6], [35, 2], [37, 3], [39, 5],
];
for (const [i, n] of drinkPlan) DRINK[i] = n;

// Workout days: ~1 in 3, and the newest day (a short walk).
const HARD = Array(N).fill(false);
for (let i = 0; i < N; i++) HARD[i] = rng() < 0.34;
HARD[N - 1] = true;

// ---- per-night metrics ----------------------------------------------------
// Mirrors the rebuilt model in pulse/pulse/metrics.py + config.py:
//   need   = flat 7h baseline (+ up to 30 min after a hard day)
//   score  = quality (how well + how settled, 0-100) x fraction of need slept
//   strain = WAKING heart-rate load only -- an easy day sits ~3-5
//   debt   = rolling 14-night shortfall vs need, recent nights weighted more,
//            capped at 5h (computed after the loop)
//   target = recovery-scaled ceiling, 6 + 0.09*recovery -- a line to stay under
const NEED_MIN = 420, GOAL_MIN = 480, DEBT_WINDOW = 14, DEBT_CAP = 300;
let fitness = 0.5;
const S = {
  strain: [], recovery: [], score: [], asleep: [], debt: [], rhr: [], hrv: [],
  deep: [], light: [], rem: [], awake: [], inBed: [], need: [], hrvBaseline: [],
  steps: [], drinks: DRINK.slice(), target: [],
  z: [[], [], [], [], []],
  bed: [], wake: [],                                       // minutes-of-day, for the newest night's hypnogram
};
const remHist = [], deepHist = [];

for (let i = 0; i < N; i++) {
  const dn = DRINK[i], hard = HARD[i];
  fitness = clamp(0.92 * fitness + 0.08 * (hard ? 0.8 : 0.32) + randn(0, 0.02), 0.28, 0.72);

  const baseHrv = 60 - 26 * (fitness - 0.5) + 4 * Math.sin(i / 6) + randn(0, 2.2);
  const baseRhr = 52.5 + 12 * (fitness - 0.3) + randn(0, 0.9);

  // Alcohol: HRV down (steeper per drink), resting HR up, both next morning.
  const hrv = clamp(baseHrv * (1 - 0.05 * dn) + randn(0, 2.2), 24, 88);
  const rhr = clamp(baseRhr + 0.85 * dn + randn(0, 0.8), 47, 72);

  // Need: flat 7h baseline, plus a little the night after a hard day.
  const need = NEED_MIN + (hard ? ri(8, 26) : 0);
  const bed = (dn ? randn(24 * 60 + 22, 30) : randn(23 * 60 + 14, 26));   // minutes past midnight (can exceed 1440)
  const asleepTarget = clamp((dn ? randn(360, 26) : randn(452, 30)), 300, 520);
  const awake = clamp(Math.round(dn ? randn(46, 12) : randn(24, 9)), 8, 90);
  const remFrac = clamp((dn ? 0.16 - 0.008 * dn : 0.225) + randn(0, 0.015), 0.10, 0.27);
  const deepFrac = clamp((dn ? 0.215 : 0.205) + randn(0, 0.02), 0.14, 0.26);
  let rem = Math.round(asleepTarget * remFrac);
  let deep = Math.round(asleepTarget * deepFrac);
  let light = Math.round(asleepTarget) - rem - deep;
  const asleep = deep + light + rem;
  const inBed = asleep + awake + ri(6, 16);
  const wake = bed + inBed;
  const eff = asleep / inBed;

  // --- sleep score = quality x fraction-of-need ---------------------------
  // "how well": efficiency, REM/deep vs personal baseline, wake-ups. "how
  // settled": overnight HRV and resting HR vs their rolling base (alcohol
  // drives both). Then multiply by how much of `need` was actually slept.
  const remBase = remHist.length >= 7 ? median(remHist) : 100;
  const deepBase = deepHist.length >= 7 ? median(deepHist) : 78;
  const clip01 = (v) => clamp(v, 0, 1);
  const wellParts = [
    clip01((0.95 - clamp(eff, 0.75, 0.95)) / -0.2 + 1),          // efficiency
    clip01((rem / remBase - 0.5) / 0.5),                          // REM vs base
    clip01((deep / deepBase - 0.5) / 0.5),                        // deep vs base
    clip01((30 - clamp(dn ? randn(9, 3) : randn(14, 4), 2, 40)) / 20), // latency
    clip01((30 - clamp(awake, 0, 40)) / 30),                      // wake-ups
  ];
  const wWeights = [10, 13, 10, 8, 11];
  const well = wellParts.reduce((a, v, k) => a + v * wWeights[k], 0)
    / wWeights.reduce((a, b) => a + b, 0);
  const zHrv = (hrv - baseHrv) / Math.max(baseHrv * 0.09, 2);
  const zRhr = (rhr - baseRhr) / Math.max(baseRhr * 0.05, 1.5);
  const settled = i < 5 ? null
    : (21 * clip01(0.5 + zHrv / 3) + 14 * clip01(0.5 - zRhr / 3)) / 35;
  const quality = 100 * (settled === null ? well : 0.65 * well + 0.35 * settled);
  const durFactor = Math.min(1, asleep / need);
  const score = clamp(Math.round(quality * durFactor), 5, 100);

  remHist.push(rem); deepHist.push(deep);
  if (remHist.length > 30) { remHist.shift(); deepHist.shift(); }

  // Recovery: 55% HRV / 25% resting HR / 20% sleep, each vs the rolling base.
  const hrvSub = clamp(54 + (hrv - baseHrv) / baseHrv * 155, 12, 100);
  const rhrSub = clamp(54 + (baseRhr - rhr) / baseRhr * 210, 12, 100);
  const rec = clamp(Math.round(0.55 * hrvSub + 0.25 * rhrSub + 0.20 * score), 17, 95);

  // Strain: WAKING load only. An easy day sits ~3-5; a session adds ~4-9.
  // (A hungover morning no longer inflates this -- the overnight HR is out.)
  const strain = r1(clamp(3.6 + randn(0, 0.5) + (hard ? rand(4.0, 9.0) : rand(0, 1.6)), 2.2, 19));

  // Time in zone. Baseline is a whole day in Z1; a session pushes minutes up.
  let z = [0, 0, 0, 0, 0];
  if (hard) {
    z[1] = ri(12, 34); z[2] = ri(4, 16); z[3] = ri(3, 18); z[4] = ri(0, 7);
  }
  z[0] = 1440 - (z[1] + z[2] + z[3] + z[4]);

  const steps = ri(hard ? 8200 : 4600, hard ? 14200 : 9200);

  S.strain.push(strain); S.recovery.push(rec); S.score.push(score);
  S.asleep.push(asleep); S.rhr.push(r1(rhr)); S.hrv.push(r1(hrv));
  S.deep.push(deep); S.light.push(light); S.rem.push(rem); S.awake.push(awake);
  S.inBed.push(inBed); S.need.push(Math.round(need)); S.hrvBaseline.push(r1(baseHrv));
  S.steps.push(steps);
  S.target.push(r1(6 + 0.09 * rec));
  for (let k = 0; k < 5; k++) S.z[k].push(z[k]);
  S.bed.push(bed); S.wake.push(wake);
}

// ---- sleep debt: rolling 14-night weighted shortfall vs need, capped -----
// Same shape as _sleep_debt() in metrics.py: a night over need pays down at
// half rate; older shortfalls age out of the window rather than being repaid.
for (let i = 0; i < N; i++) {
  let acc = 0;
  for (let k = 0; k <= i && k < DEBT_WINDOW; k++) {
    const d = S.need[i - k] - S.asleep[i - k];
    acc += (d > 0 ? d : 0.5 * d) * ((DEBT_WINDOW - k) / DEBT_WINDOW);
  }
  S.debt.push(Math.round(clamp(acc, 0, DEBT_CAP)));
}

// ---- drinks + workouts, per night ----------------------------------------
const LAST = N - 1;
const day = dates[LAST];
const KINDS = ["beer", "wine", "cocktail", "shot"];
const KIND_STD = { beer: 1.0, wine: 1.0, cocktail: 1.5, shot: 1.0, double: 2.0, other: 1.0 };
const nextOf = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

// One evening of `count` drinks: first around 8-9pm, then 40-60 min apart, so
// the last one lands ~11pm-1am -- always well before any sane bedtime.
let drinkId = 9001;
function evening(dayStr, count) {
  const times = [], out = [];
  let m = clamp(randn(20 * 60 + 20, 24), 19 * 60, 21 * 60 + 40);
  for (let k = 0; k < count; k++) {
    const mm = Math.round(m);
    const kind = KINDS[k === 0 ? 0 : Math.floor(rng() * KINDS.length)];
    const abs = mm < 1440 ? [dayStr, mm] : [nextOf(dayStr), mm - 1440];
    times.push(hhmm(mm));
    out.push({ id: drinkId++, kind, std_drinks: KIND_STD[kind], logged_at: iso(abs[0], Math.floor(abs[1] / 60), abs[1] % 60) });
    m += rand(40, 62);
  }
  return { times, rows: out, lastMin: Math.round(m - rand(40, 62)) };
}

// A day's workouts, at daytime hours.
const W_KINDS = [
  ["WALKING", 26, 42, 4.0, 0.90, { light: 0.82, moderate: 0.15, vigorous: 0.03, peak: 0 }],
  ["RUNNING", 24, 44, 9.5, 0.37, { light: 0.10, moderate: 0.40, vigorous: 0.42, peak: 0.08 }],
  ["WEIGHTS", 38, 58, 3.0, null, { light: 0.55, moderate: 0.33, vigorous: 0.11, peak: 0.01 }],
  ["CYCLING", 30, 55, 7.0, null, { light: 0.25, moderate: 0.45, vigorous: 0.28, peak: 0.02 }],
];
function workoutFor(i) {
  const [type, loMin, hiMin, kcalPerMin, pace, zw] = W_KINDS[Math.floor(rng() * W_KINDS.length)];
  const min = ri(loMin, hiMin);
  const startMin = ri(7, 19) * 60 + ri(0, 55);
  const zm = ["light", "moderate", "vigorous", "peak"].map((z) => Math.round(min * zw[z]));
  const distM = pace ? Math.round(min * 60 / (pace / 0.001) * 1000) : null;   // rough
  return {
    type, start: hhmm(startMin), min, cal: Math.round(min * kcalPerMin + ri(-8, 8)),
    avg_hr: ri(95, type === "RUNNING" ? 158 : 130),
    steps: type === "WALKING" || type === "RUNNING" ? Math.round(min * ri(95, 150)) : null,
    dist_m: distM ? distM / 10 : null,
    pace_s_per_m: pace ? r1(pace * 1000) / 1000 : null,
    azm: zm[1] + zm[2] * 2 + zm[3] * 2,
    zones: { light: zm[0], moderate: zm[1], vigorous: zm[2], peak: zm[3] },
  };
}

const drink_times_nights = [], drink_rows_nights = [], workout_nights = [];
for (let i = 0; i < N; i++) {
  if (i === LAST) { drink_times_nights.push([]); drink_rows_nights.push([]); workout_nights.push([]); continue; }
  const e = DRINK[i] ? evening(dates[i], DRINK[i]) : { times: [], rows: [] };
  drink_times_nights.push(e.times);
  drink_rows_nights.push(e.rows);
  const w = [];
  if (HARD[i]) { w.push(workoutFor(i)); if (rng() < 0.18) w.push(workoutFor(i)); }
  workout_nights.push(w.sort((a, b) => a.start.localeCompare(b.start)));
}

// ---- the newest night, in detail ----------------------------------------
const nextDay = nextOf(day);

// Five drinks, 7:50pm to ~11pm; bedtime an hour after the last.
const drinkStart = 19 * 60 + 50;
const kinds = ["beer", "beer", "cocktail", "wine", "beer"];
const std = [1.0, 1.0, 1.5, 1.0, 1.0];
const drinkMin = [];
let t = drinkStart;
for (let k = 0; k < 5; k++) { drinkMin.push(Math.round(t)); t += rand(45, 56); }
const drink_times = drinkMin.map(hhmm);
const drink_rows = drinkMin.map((m, k) => ({
  id: drinkId++, kind: kinds[k],
  logged_at: iso(m < 1440 ? day : nextDay, Math.floor((m % 1440) / 60), m % 60),
  std_drinks: std[k],
}));
drink_times_nights[LAST] = drink_times;
drink_rows_nights[LAST] = drink_rows;
const first_drink = drink_rows[0].logged_at;
const last_drink = drink_rows[4].logged_at;

// Bedtime ~65 min after the last drink; wake ~7h later.
const bedMin = drinkMin[4] + 65;                            // ~00:10 next day
const hypSpan = S.inBed[LAST];
const wakeMin = bedMin + hypSpan;

// Hypnogram: five cycles, alcohol-shaped -- deep front-loaded, REM short and
// late, wake-ups clustered in the back half. Offsets are minutes from bedMin.
function buildHypno(span) {
  const segs = [];
  let at = 0;
  const push = (type, len) => { len = Math.max(1, Math.round(len)); segs.push({ t: type, a: at, b: at + len }); at += len; };
  push("AWAKE", randn(7, 2));
  const cycles = [
    { deep: randn(42, 5), rem: randn(9, 2), wake: randn(2, 1) },   // 1: huge deep, sliver of REM
    { deep: randn(33, 5), rem: randn(15, 3), wake: randn(3, 2) },
    { deep: randn(17, 4), rem: randn(21, 4), wake: randn(8, 4) },
    { deep: randn(7, 3), rem: randn(24, 5), wake: randn(12, 6) },  // back half: fragmented
    { deep: randn(3, 2), rem: randn(18, 5), wake: randn(9, 5) },
  ];
  for (const c of cycles) {
    if (at >= span - 12) break;
    push("LIGHT", randn(24, 5));
    push("DEEP", c.deep);
    push("LIGHT", randn(16, 4));
    push("REM", c.rem);
    if (rng() < 0.85) push("AWAKE", c.wake);
    for (let j = 0; j < Math.round(Math.abs(randn(1.4, 1))); j++) push("AWAKE", 1);
  }
  if (at < span) push("LIGHT", span - at);
  // tally
  const tot = { AWAKE: 0, REM: 0, LIGHT: 0, DEEP: 0 };
  for (const s of segs) tot[s.t] += s.b - s.a;
  return { segs, tot, span: at };
}
let H = buildHypno(hypSpan);
// re-scale the fixture's stage totals to what the hypnogram actually produced,
// so the Sleep tab's numbers and its ribbon can't disagree
S.deep[LAST] = H.tot.DEEP; S.light[LAST] = H.tot.LIGHT;
S.rem[LAST] = H.tot.REM; S.awake[LAST] = H.tot.AWAKE;
S.asleep[LAST] = H.tot.DEEP + H.tot.LIGHT + H.tot.REM;
S.inBed[LAST] = H.span;

const nadirMin = ri(150, 205);                              // alcohol pushes the floor late
const nadirBpm = ri(52, 58);                                //   and won't let it drop as far
const hypno = {
  start: hhmm(bedMin), end: hhmm(wakeMin), span: H.span, segs: H.segs,
  nadirMin, nadirBpm,
};

// The newest day: one easy evening walk before dinner.
const workout_list = [{
  type: "WALKING", start: "17:35", min: 34, cal: 150, avg_hr: 108,
  steps: 3400, dist_m: 2600.0, pace_s_per_m: 0.78, azm: 4,
  zones: { light: 28, moderate: 5, vigorous: 1, peak: 0 },
}];
workout_nights[LAST] = workout_list;
S.z[0][LAST] = 1440 - (22 + 6 + 5 + 1);
S.z[1][LAST] = 22; S.z[2][LAST] = 6; S.z[3][LAST] = 5; S.z[4][LAST] = 1;
S.steps[LAST] = 8600;
S.strain[LAST] = 5.6;                 // a 34-minute walk barely lifts off the floor
S.need[LAST] = 420;                   // flat 7h -- no hard day yesterday
S.target[LAST] = r1(6 + 0.09 * S.recovery[LAST]);
// The newest night is heavy drinking (5) + short sleep: recompute its debt and
// score off the now-final hypnogram totals so the fixture stays self-consistent.
S.debt[LAST] = Math.round(clamp(
  Array.from({ length: Math.min(DEBT_WINDOW, N) }, (_, k) => {
    const d = S.need[LAST - k] - S.asleep[LAST - k];
    return (d > 0 ? d : 0.5 * d) * ((DEBT_WINDOW - k) / DEBT_WINDOW);
  }).reduce((a, b) => a + b, 0), 0, DEBT_CAP));
{
  const a = S.asleep[LAST], ib = S.inBed[LAST], eff = a / ib;
  const remBase = median(S.rem.slice(0, LAST).slice(-30));
  const deepBase = median(S.deep.slice(0, LAST).slice(-30));
  const cl = (v) => clamp(v, 0, 1);
  const wp = [
    cl((0.95 - clamp(eff, 0.75, 0.95)) / -0.2 + 1),
    cl((S.rem[LAST] / remBase - 0.5) / 0.5),
    cl((S.deep[LAST] / deepBase - 0.5) / 0.5),
    cl((30 - 9) / 20),                                   // fast onset, alcohol
    cl((30 - clamp(S.awake[LAST], 0, 40)) / 30),
  ];
  const ww = [10, 13, 10, 8, 11];
  const well = wp.reduce((s, v, k) => s + v * ww[k], 0) / ww.reduce((s, v) => s + v, 0);
  const zHrv = (S.hrv[LAST] - S.hrvBaseline[LAST]) / Math.max(S.hrvBaseline[LAST] * 0.09, 2);
  const zRhr = (S.rhr[LAST] - median(S.rhr.slice(0, LAST).slice(-14))) / 2.5;
  const settled = (21 * cl(0.5 + zHrv / 3) + 14 * cl(0.5 - zRhr / 3)) / 35;
  const quality = 100 * (0.65 * well + 0.35 * settled);
  S.score[LAST] = clamp(Math.round(quality * Math.min(1, a / S.need[LAST])), 5, 100);
}

// ---- the newest night's civil-day heart-rate curve (00:00-24:00) ----------
// Phases across the day. bpm is a smooth base per phase plus small noise.
function bpmAt(min) {                                       // min 0..1440
  const jitter = () => randn(0, 2.1);
  // 00:00-07:00  sleep from the night before (sober, so a real low around 3am)
  if (min < 420) {
    const floor = 50 + 4 * Math.cos((min - 180) / 120);    // nadir ~03:00
    return floor + Math.max(0, (min - 360) / 60) * 10 + jitter();
  }
  if (min < 465) return 60 + (min - 420) / 45 * 16 + jitter();      // waking
  if (min < 540) return 74 + jitter();                              // breakfast/commute
  if (min < 720) return 70 + 5 * Math.sin(min / 40) + jitter();     // morning
  if (min < 780) return 82 + jitter();                              // lunch
  if (min < 1055) return 72 + 6 * Math.sin(min / 55) + jitter();    // afternoon
  if (min < 1089) {                                                 // 17:35-18:09 walk
    return 100 + 18 * Math.sin((min - 1055) / 34 * Math.PI) + jitter();
  }
  if (min < 1190) return 84 - (min - 1089) / 101 * 14 + jitter();   // cooldown + dinner
  // 19:50-23:05 drinking: HR lifts and keeps climbing through the session
  if (min < drinkMin[4]) {
    const p = (min - 1190) / (drinkMin[4] - 1190);
    return 74 + 26 * p + 4 * Math.sin(min / 12) + jitter();
  }
  // 23:05-24:00 winding down toward bed
  const p = (min - drinkMin[4]) / (1440 - drinkMin[4]);
  return 100 - 22 * p + jitter();
}
const curve = [];
for (let m = 0; m < 1440; m += 5) curve.push([hhmm(m), clamp(Math.round(bpmAt(m)), 44, 165)]);

// ---- assemble -----------------------------------------------------------
const today = {
  night: day,
  strain: S.strain[LAST], recovery: S.recovery[LAST], score: S.score[LAST],
  hrv: S.hrv[LAST], rhr: Math.round(S.rhr[LAST]),
  eff: Math.round(S.asleep[LAST] / S.inBed[LAST] * 100),
  debt: S.debt[LAST], asleep: S.asleep[LAST], need: S.need[LAST],
  deep: S.deep[LAST], light: S.light[LAST], rem: S.rem[LAST], awake: S.awake[LAST],
  drinks: 5, steps: S.steps[LAST],
};

const out = {
  today_is_drinking: false,
  night: day,
  dates,
  strain: S.strain, recovery: S.recovery, score: S.score, asleep: S.asleep,
  debt: S.debt, rhr: S.rhr, hrv: S.hrv,
  deep: S.deep, light: S.light, rem: S.rem, awake: S.awake,
  z: S.z, target: S.target,
  steps: S.steps, drinks: S.drinks, hrmax: 192,
  curve, hypno, today,
  // per-night detail so the calendars aren't a single lit cell
  drink_times_nights, drink_rows_nights, workout_nights,
  // newest-night singulars, kept for older code paths / self-documentation
  drink_times, workout_list, first_drink, last_drink, drink_rows,
  dates_labels: dates.map((d) => d.slice(5)),
};

writeFileSync(OUT, JSON.stringify(out));
console.log(`${OUT}  ${(JSON.stringify(out).length / 1024).toFixed(1)}kb`);
console.log(`  ${N} nights ${dates[0]}..${dates[LAST]}`);
console.log(`  drinking nights: ${S.drinks.map((n, i) => n ? `${dates[i].slice(5)}:${n}` : "").filter(Boolean).join("  ")}`);
console.log(`  newest night: 5 drinks ${drink_times[0]}-${drink_times[4]}, bed ${hypno.start}, wake ${hypno.end}`);
console.log(`    sleep ${S.asleep[LAST]}m (deep ${S.deep[LAST]} / light ${S.light[LAST]} / rem ${S.rem[LAST]} / awake ${S.awake[LAST]}), score ${S.score[LAST]}, recovery ${S.recovery[LAST]}, hrv ${S.hrv[LAST]} vs base ${S.hrvBaseline[LAST]}`);
