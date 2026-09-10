# How every number is calculated

The single source of truth for the derived metrics. Every formula here lives in
[`pulse/pulse/metrics.py`](pulse/metrics.py) and its constants in
[`pulse/pulse/config.py`](pulse/config.py) — **change one, change the other, and
re-run `python -m pulse test`.**

Nothing here reproduces a vendor's private formula. The numbers track WHOOP /
Oura / Bevel *directionally* and will disagree by design. Where a threshold is
our own calibration it says so.

The pipeline: [`ingest.py`](pulse/ingest.py) pulls the Google Health API into
SQLite → [`metrics.py`](pulse/metrics.py) derives everything below →
[`render.py`](pulse/render.py) assembles it → [`push.py`](pulse/push.py) writes
one row per night to Supabase → the PWA reads that and does **no math** except
recomputing the strain ceiling (a pure function of recovery).

---

## Sleep need

`cfg.SLEEP_NEED_MIN = 420` (7 h), plus up to `cfg.SLEEP_NEED_HARDDAY_MAX` (30
min) the night after a hard day:

```
need = 420 + min(30, 3 · max(0, yesterday_strain − 10))
```

- **Flat personal baseline, not the population 8 h.** Set `SLEEP_NEED_MIN` to
  what you actually run well on. Chronic short sleep makes you *feel* adapted
  while staying measurably impaired, but for a personal tool "I feel good on 7"
  is a reasonable call — and anchoring `need` an hour too high makes every sleep
  score look worse than the night was and pins sleep debt at its ceiling
  forever.
- **Debt is not folded in.** The old formula added up to 90 min of accumulated
  debt to `need`; that made the two reinforce each other and the number ran
  away. Debt is now tracked and shown entirely on its own (below).
- **Sleep goal** (`cfg.SLEEP_GOAL_MIN = 480`, 8 h) is aspirational only — a
  reference line and a "nights hit" idea in the UI. It never enters the score
  or the debt.

## Sleep debt

`_sleep_debt()` — a rolling shortfall vs `need` over the last
`cfg.SLEEP_DEBT_WINDOW` (14) nights, recent nights weighted heaviest, capped at
`cfg.SLEEP_DEBT_CAP_MIN` (5 h):

```
for each night i:
    deficit_k  = need_k − asleep_k           for k in the last 14 nights
    contrib_k  = deficit_k            if deficit_k > 0
               = 0.5 · deficit_k      otherwise      (a night over need pays
                                                      down at half rate)
    weight_k   = (14 − age_k) / 14           1.0 for last night … 1/14 for the
                                             14th-oldest
    debt_i     = clip( Σ weight_k · contrib_k , 0 , 300 )
```

Why this shape (RISE's model + the chronic-sleep-restriction literature):

- **It can reach zero.** Sleep at `need` for two weeks and the debt is gone —
  so a non-zero number actually means something. The old leaky-bucket
  accumulator (`0.88 · yesterday + (need − asleep)`, cap 10 h) never emptied and
  sat near its ceiling for anyone who wasn't hitting 8 h.
- **It builds over ~2 weeks and fades over ~2 weeks.** Debt accrues fast (a
  short night lands immediately at full weight) and clears slowly (the shortfall
  ages out of the window rather than being "repaid"), which matches that
  subjective sleepiness adapts to chronic restriction even as the deficit
  persists.
- **Chronically 1 h short → a stable ~5 h, not an ever-growing number.** Old
  shortfalls roll off as fast as new ones arrive.
- Advisory only. It drives "aim for 7.5 h tonight" nudges; it does **not** dock
  the sleep score.

### Naps

`main_sleeps()` keeps one session per day (the longest) so a nap can't render
as "last night" and wreck the stage numbers. But `nap_minutes()` collects every
session it rejected — keyed to the civil day it started — and those minutes
**do** count:

- added to `asleep_total`, which is what **sleep debt** and **`perf`** (the
  recovery sleep term) are computed from. A 90-min nap offsets 90 min of that
  day's shortfall.
- **not** added to the sleep **score** — that's one main night's architecture,
  which a nap can't retroactively change.

Sessions under 10 min are dropped (a "21 min, 8 asleep" wake-up blip is noise).
The Fitbit Air only logs a nap it detects — roughly 45 min+ of sustained
stillness — so short couch naps are invisible to this and simply don't get
credited.

## Sleep score

`sleep_score()` — **quality × how much of `need` you actually slept:**

```
score = round( quality · min(1, asleep / need) )        clamped 0–100
```

The length multiplier is the whole point: a flawless 5 h night against a 7 h
need is capped at `5/7 ≈ 0.71` of its quality, no matter how clean it was. A
7 h night (== `need`) is not docked at all.

### quality (0–100)

```
quality = 100 · ( 0.65 · well  +  0.35 · settled )      when a baseline exists
        = 100 ·   well                                  first ~5 nights
```

**`well` — "how well you slept"** (weights out of 100, summing to 65):

| Component | Weight | Full credit … 0 credit |
|---|--:|---|
| Efficiency | 10 | `asleep/in_bed` ≥ 0.95 … ≤ 0.75 |
| REM sleep | 13 | ≥ your 30-night median REM minutes … ≤ half of it† |
| Deep sleep | 10 | ≥ your 30-night median deep minutes … ≤ half of it† |
| Time to sleep | 8 | ≤ 10 min … ≥ 30 min |
| Restlessness | 6 | ≤ 2 min in <5-min wake blocks … ≥ 25 min |
| Interruptions | 6 | 0 min in ≥5-min wake blocks … ≥ 30 min |
| Full awakenings | 6 | 0 wakes ≥ 5 min … ≥ 3 |
| Sleep timing | 7 | bed/wake within 20 min of your 14-night mean … ≥ 90 min off |

† Graded against **your own recent normal**, not a textbook percentage, and
**capped at full credit** — sleeping *more* REM/deep than usual never earns a
bonus, so alcohol's first-half deep-sleep spike can't inflate the score. Before
7 nights of history exist, these fall back to fixed healthy ranges
(REM 18–28 % of sleep, deep 13–23 %).

**`settled` — "how settled your body got overnight"** (`_sleep_settled()`,
weights out of the 35):

| Component | Weight | Scored from |
|---|--:|---|
| HRV overnight | 21 | `clip(0.5 + z/3, 0, 1)` — z of the daily overnight HRV vs your 30-day baseline |
| Resting HR overnight | 14 | `clip(0.5 − z/3, 0, 1)` — z of the daily overnight RHR vs your 30-day baseline |

This is the part the old score was missing entirely, and it is where alcohol,
illness and stress land: overnight HRV falls and overnight RHR rises, both
dose-dependently ([research](#research)). The `z` divisor is **3**, not
`recovery()`'s 4, so a heavy night's ~1.5-sigma HRV drop carries this most of
the way to zero on its own. Inactive until ≥ 5 nights of HRV or RHR history
exist; before that the score is `well` alone.

### What alcohol is *not*

There is no explicit "−N points per drink". The drink log is used to explain
(HRV %, expected REM drop) but the penalty is entirely the body's own signal —
`settled` down, REM-vs-baseline down, and the length multiplier if the night
ran short. A separate deduction would double-count it and break the day you
forget to tap.

---

## Strain

`day_strain()` — Banister TRIMP-exp over the day's **waking** heart rate,
log-compressed to 0–21:

```
x_i    = clip( (bpm_i − rhr) / (hrmax − rhr) , 0 , 1.4 )      HR-reserve fraction
trimp  = Σ  dt_i · x_i · k · exp(b · x_i)      over AWAKE samples only
                                              dt_i = seconds to next sample,
                                              capped at 300 s, in minutes
k, b   = (0.64, 1.92) male   |   (0.86, 1.67) female
strain = min( 7.886 · ln(1 + trimp/45.5) , 21 )
```

- **Sleep is excluded** (`asleep` mask, built in `render.compute()` from the
  night's sleep interval — naps too). An elevated *resting* heart rate
  overnight — from alcohol, illness, a hot room — is your body spending energy
  to **recover**, not training load. Counting it as strain made strain and
  recovery move together after a rough night and stop meaning anything; that
  cost now lands on the recovery side, where the overnight HRV/RHR it depresses
  already live. This is the single change from the old "passive time included,
  as Bevel does" model — the log curve itself is unchanged.
- Rough calibration on waking-only TRIMP: a genuinely sedentary day ≈ 5, a day
  on your feet ≈ 8, a moderate session ≈ 13, a hard one ≈ 17.
- `rhr` is the day's Google daily resting HR, or the 5th percentile of the
  day's bpm before that exists. `hrmax` is `cfg.HR_MAX` or Tanaka
  `208 − 0.7·age`.
- `cfg.STRAIN_SCALE` rescales the axis: 21 = WHOOP, 100 = Bevel percent.

### Known limitation

"Awake" is the only filter. An awake-but-sedentary morning with an
alcohol-elevated heart rate still accumulates some strain (less than before,
since the overnight hours are gone). Gating on per-minute movement/step data —
so "sitting still with a high heart rate" contributes nothing — is deferred
until we see whether excluding sleep is enough on real data.

### Time in zone

`zmin` still spans the **whole 24 h**, sleep included — it is a description of
where your heart rate sat (five Karvonen HR-reserve buckets at 50/60/70/80/90 %
that tile the day), not a load figure.

## Strain ceiling

`strain_ceiling(recovery, load_state)` — a single number to stay **under** today,
scaled to recovery. Not a band to fill: undershooting on a low-recovery day is
the correct call, so there is no lower bound.

```
ceiling = 6.0 + 0.09 · recovery              # recovery 100 → 15.0   50 → 10.5   25 → 8.3
ceiling = min(ceiling, cap[load_state])      # cap = {1: 11.0, 2: 8.0}, from Recovery Load
ceiling = round(ceiling, 1)
```

The load cap exists because `recovery` reads only HRV / RHR / sleep — an early
illness that shows in skin temp + breathing but not yet in HRV would otherwise
leave the ceiling high. An **elevated** Recovery Load caps it at 11, a **high**
one at 8.

Recomputed in the browser (`app.js` `ceilingWithLoad` + `normalize()`) rather
than stored — a pure function of recovery and load state, so a stored copy could
only drift.

---

## Recovery Load

`recovery_load(...)` — one overnight number: **is your body working harder than
usual to recover?** Fighting a bug, clearing alcohol, recovering from a hard day,
stressed, bad sleep environment. Stored as `body_load`; the reader (`app.js`,
`load_state()`) bands it **settled / elevated / high** at 0.5 and 1.0.

### Inputs — 4 overnight markers, each vs *your own* normal

| marker | value | baseline · spread | bad direction |
|---|---|---|---|
| HRV | deep-sleep RMSSD, else all-night average (see below) | trailing 30-night median · 1.4826·MAD | ↓ down |
| resting HR | `daily_resting_heart_rate.beatsPerMinute` | trailing median · 1.4826·MAD | ↑ up |
| respiratory rate | `daily_respiratory_rate.breathsPerMinute` | trailing median · 1.4826·MAD | ↑ up |
| skin temp | `nightlyTemperatureCelsius` | **Google's** `baselineTemperatureCelsius` · `relativeNightlyStddev30dCelsius` | ↑ up |

**HRV marker.** The API returns a true RMSSD scoped to deep sleep
(`deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds`) alongside the
all-night average. Probed across 42 nights it has 100 % coverage and tracks the
average at r ≈ 0.85 — but on the (small sample of) logged drinking nights it fell
~44 % below personal baseline vs the average's ~23 %, and on one night the
average had already recovered to normal by wake while the deep value had not.
`recovery_load` uses the deep RMSSD once it has its own trailing baseline
(`hrv_deep_baseline`), with a **wider floor** (5 ms vs 3) because its sober-night
spread runs ~1.5× the average's. It falls back to the all-night average when the
deep baseline isn't there yet. `recovery()` and the sleep *settled* score still
use the average only — this lens is Recovery-Load-only until it has more drinking
nights behind it. First-backfill caveat: this person's deep-RMSSD series is on a
strong upward trend right now, which inflates its 30-night MAD and makes the
marker conservative until the baseline catches up.

Skin temp uses Google's own baseline + SD (computed from the intra-night samples
we don't get); the rest use a robust median + MAD from `push._hist`.

### The math

```
per marker m:
    σ_m = 1.4826 · MAD(hist_m)               # None with < 5 clean nights
    z_m = (value − median) / σ_m             # temp: delta / google_sd
    d_m = clip( bad-direction part of z_m , 0, 3 )
    d_m = 0  if |value − baseline| < floor_m     # floor: hrv 3ms (deep 5), rhr 2bpm,
                                                 #        temp 0.15°C, rr 0.5

weights w = { hrv 0.35, rhr 0.25, temp 0.25, rr 0.15 }   # sum = 1
body_load = Σ w_m · d_m                       # present-but-normal (d_m = 0) contributes nothing,
                                              #   same as a missing marker — a reading the watch
                                              #   didn't get is not evidence of anything
body_load = max( body_load , d_temp / 2 )     # fever override: a ~2σ skin-temp rise alone
                                              #   reaches "high". SKIN TEMP ONLY — an
                                              #   unrestricted max(d)/2 flagged ordinary
                                              #   nights off a lone +1 br/min breathing blip
```

Returns `None` when no marker has ≥ 5 nights of history. Weights: HRV highest (the
specific autonomic-stress marker), breathing lowest (wrist RR is the least
accurate). **One marker off is noise; two or three together is real.**

### It doesn't tell you *why*

Illness, alcohol, stress, a hot room all look similar. Paired with the drink log
the PWA reconciles: *"3 drinks — expected"* vs *"nothing logged — check in."*

### Degrades gracefully

Skin temp only started syncing after the data type was added, so most history
computes from 3–4 markers. A night with no main sleep, or the first ~5 nights,
get `body_load = null`.

---

## HR nadir timing — *parked*

`hr_nadir_at` / `min_to_nadir` (stored, and drawn as a dot on the hypnogram):
the lowest smoothed heart rate during sleep, and how long after sleep onset it
landed. The direction of interest is real — Oura's Recovery Index is literally
*hours of sleep after the HR low*, and a late nadir means "took longer to
settle."

`hr_nadir_min_baseline` (trailing median) and the view's `nadir_delay_min` are
computed and stored, **but nothing reads them yet.** The first backfill showed
the smoothed *global* minimum's timing has a ~83 min personal σ and a ~120 min
mean night-to-night swing on real data — the `argmin` of a near-flat overnight
trough is dominated by noise. It was pulled from Recovery Load. A proper
settling-time detector (first sustained minimum, or the low-HR period's
centroid) is the follow-up; the column is kept for it.

---

## SpO₂ bounds

`daily-oxygen-saturation` returns a nightly low and a spread next to the average
Pulse already stores as `spo2`:

| column | source | meaning |
|---|---|---|
| `spo2_min` | `lowerBoundPercentage` | the night's O₂ floor |
| `spo2_sd` | `standardDeviationPercentage` | overnight O₂ variability |

The view computes `spo2_drop = spo2 − spo2_min` — how far below the night's own
average the floor sank, so it needs no historical baseline. A large drop or a
wide `spo2_sd` is a breathing-disturbance / congestion / altitude signal. Not in
Recovery Load (yet) — surfaced on the Recovery detail as its own line.

---

## non-REM resting HR

`nonRemHeartRateBeatsPerMinute` rides the same HRV payload: a resting HR measured
in stable non-REM sleep — the RHR analogue of the deep-sleep RMSSD lens, a
cleaner state than the all-day `rhr`. Stored as `non_rem_hr` with its own
trailing baseline; the view exposes `non_rem_hr_delta` (up = bad, like
`rhr_delta`). Display-only for now.

---

## Recovery

`recovery()` — unchanged. 0–100, HRV-dominant:

```
hrv_c   = clip(0.5 + z(hrv) / 4, 0, 1)          z vs your 30-day baseline
rhr_c   = clip(0.5 − z(rhr) / 4, 0, 1)
slp_c   = clip(perf, 0, 1)                       perf = asleep / need, or 0.75
recovery = round( 100 · (0.55·hrv_c + 0.25·rhr_c + 0.20·slp_c) )
```

`perf` shifts slightly under the rebuild because `need` is now a flat 7 h rather
than the old debt-inflated figure — a 7 h night reads as `perf = 1.0` where it
used to be penalised.

## Sleep timing / consistency

`consistency()` — unchanged. Circular SD of bedtime over 14 nights → 0–100.
Circular statistics are required because bedtimes wrap midnight.

## ACWR

`m["load"].tail(7).mean() / m["load"].tail(28).mean()` — 7-day TRIMP over
28-day TRIMP. Now waking-only TRIMP, consistent with strain. 0.8–1.3 is the
conventional safe window.

---

## Tests

```
cd pulse && python -m pulse test
```

[`pulse/pulse/metrics_test.py`](pulse/metrics_test.py) pins the *behaviour* the
rebuild was for, not exact digits:

- a short night cannot score high however clean it was (the length multiplier)
- the ~5 h drinking night that scored ~76 under the old model now lands well
  below it
- strain ignores sleep — a hungover morning in bed is not training load
- sleep debt rolls: it reaches zero at `need`, and never exceeds its cap
- Recovery Load: the deep-sleep RMSSD drives the HRV marker once it has a
  baseline (falls back to the average otherwise); above-baseline deep RMSSD
  never adds; the fever override is skin-temp only, so a lone breathing blip
  can't reach "elevated"

If you retune a constant, update the loose bounds in the test to match the new
*intent*, not the other way round.

---

## Research

Sourced Sept 2026. All findings are dose-dependent and appear **without a
hangover**.

**Alcohol & sleep architecture** — 2024 meta-analysis, 27 studies
([ScienceDirect](https://www.sciencedirect.com/science/article/pii/S1087079224001345)):
REM starts ~18 min later and is ~11 min shorter on average; ~40 min less REM per
1 g/kg. Deep/slow-wave sleep rises in the first part of the night and falls
later — net roughly flat. The second half fragments as blood alcohol clears.
Sleep onset is *faster* — which is why efficiency and latency look better after
drinking.

**Alcohol & overnight autonomics** — 42,086-person real-world wearable study
([JMIR 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC5878366/)): HRV-based
recovery down 9.3 % / 24.0 % / 39.2 % for low (≤ 0.25 g/kg, ~1 drink) /
moderate (~3 drinks) / high (~7 drinks) intake; nocturnal heart rate up
+1.4 / +4.0 / +8.7 bpm. Younger people are hit harder. WHOOP's own data: next-day
recovery is 8 % lower after *any* logged drink; HRV can take 1–5 days to return.

**Sleep debt** — RISE
([method](https://www.risescience.com/blog/how-much-sleep-debt-do-i-have)):
rolling 14-night window vs a fixed personal need, recent nights weighted
heaviest, and they tell users to aim for **≤ 5 h** — zero is unrealistic.
Chronic-restriction studies: recovery is far slower than accrual (~4 days per
lost hour), and subjective sleepiness adapts while cognitive deficits do not.

**Strain** — WHOOP day strain is waking cardiovascular + muscular load on a
non-linear 0–21 scale, with only "a few points" accruing overnight; the
recovery-scaled recommendation is a target to approach, not a hard number.

**Deep-sleep HRV** — RMSSD is the standard short-term parasympathetic marker, and
higher overnight RMSSD tracks better self-reported sleep, lower fatigue and lower
stress in 14-day real-world data
([daily HRV & wellness, 2025](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12300306/)).
Measuring it inside slow-wave sleep — a controlled, low-arousal, stable-breathing
state — is why Oura reports a ~15.6 % post-drinking HRV drop
([Oura alcohol data](https://ouraring.com/blog/how-does-alcohol-impact-oura-members/))
where an all-night average, which folds in REM's sympathetic surges and
awakenings, is muddier. Pulse's own 42-night probe: deep RMSSD fell ~44 % vs
baseline on drinking nights against the average's ~23 %.

**HR nadir timing** *(parked — see the section above)* — Oura's Recovery Index is
literally *hours of sleep after the heart-rate low*, and they say it "is
beneficial for your RHR to reach its lowest point within the first half of the
night… If it drops late, your body may have taken longer to settle," and to fix a
late nadir "avoid late-night meals, caffeine, alcohol, or exercise before bed"
([Oura Readiness Contributors](https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors)).
Lab work agrees alcohol reshapes the overnight HR trajectory — a steeper early
drop but a significant rise across the second half, plus suppressed vagal HRV and
increased sympathetic drive
([Pietilä et al., JMIR 2018](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5878366/);
[evening-alcohol dose–response, SLEEP 2021](https://academic.oup.com/sleep/article/44/1/zsaa135/5871424)).
The direction is sound; the raw-`argmin` implementation is not (first-backfill σ
≈ 83 min), so it is stored but unused pending a real settling-time detector.

**Overnight SpO₂** — the oxygen-desaturation index correlates strongly with the
apnea–hypopnea index (r ≈ 0.73–0.94), and inter-night SpO₂ variability rises as
values leave the normal range
([ODI vs AHI](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11576076/);
[inter-night oximetry variability](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11196338/)).
But a real ODI needs ≥ 1 Hz sampling; Google returns only a nightly average /
low / SD, so `spo2_min` and `spo2_sd` are a coarse "worth a look" flag —
congestion, altitude, a bad night — not a screen.
