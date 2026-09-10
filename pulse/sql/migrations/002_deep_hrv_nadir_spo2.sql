-- Pulse migration 002 — deep-sleep HRV + non-REM HR + HR-nadir timing + SpO2 bounds
-- =============================================================================
-- Run ONCE:  Supabase dashboard → SQL Editor → New query → paste this whole
-- file → Run.
--
-- Safe to run NOW, before the code ships: the six new columns just sit NULL
-- until push.py starts filling them, and nothing that exists today reads them.
-- Safe to re-run: every statement is idempotent. No existing row is rewritten;
-- no downtime.
--
-- What it does:
--   1. adds 6 nullable columns to public.nights
--   2. appends them (+ 4 computed reads) to the public.night_summary view the
--      PWA selects "*" from
--
-- Four features, all pulled from data the API already returns and Pulse
-- already half-stores:
--
--   deep-sleep HRV lens
--     hrv_deep_rmssd (already stored) is a true RMSSD measured in deep sleep
--     only. Probed across 42 nights it has 100% coverage and tracks the
--     all-night average at r≈0.85 -- close, but on the two logged drinking
--     nights it fell 44% below personal baseline vs the average's 23%, and on
--     one of them the average had already snapped back to normal by wake.
--     hrv_deep_baseline gives it the same trailing-median reference hrv_rmssd
--     has, so the PWA can show "deep HRV 69% of normal" next to the average.
--
--   non-REM resting HR
--     nonRemHeartRateBeatsPerMinute rides the same HRV payload -- a resting HR
--     measured in stable non-REM sleep, the RHR analogue of the deep-sleep
--     RMSSD lens. On the 6-drink night it read 86 vs a ~66 norm. non_rem_hr
--     + non_rem_hr_baseline; the view exposes non_rem_hr_delta (bad direction
--     is up, like rhr_delta).
--
--   HR-nadir timing  (PARKED after the first backfill -- kept, not read)
--     hr_nadir_at / min_to_nadir are already stored and drawn as a dot on the
--     hypnogram. hr_nadir_min_baseline is the personal normal for when your
--     heart rate bottoms out after sleep onset; nadir_delay_min in the view is
--     tonight minus that normal. The direction is real (Oura's Recovery Index),
--     but the raw-argmin timing proved too noisy on real data (~83 min sigma)
--     to weight in Recovery Load -- these two columns are stored for a future
--     proper settling-time detector, nothing reads them today. See METRICS.md.
--
--   SpO2 bounds
--     daily-oxygen-saturation returns lowerBoundPercentage and
--     standardDeviationPercentage alongside the average Pulse keeps today. A
--     low floor or a wide spread is a breathing-disturbance / congestion /
--     altitude signal. spo2_drop in the view is (average − floor) for that
--     same night, so it needs no historical baseline.
--
-- After this: deploy the code, then run the sync workflow with full:true once
-- to backfill the three baselines and the SpO2 bounds across your history.
-- (Same backfill that migration 001's body_load still needs -- one run covers
-- both.)
-- =============================================================================


-- 1. new columns --------------------------------------------------------------
alter table public.nights
  add column if not exists hrv_deep_baseline     numeric,   -- trailing median of hrv_deep_rmssd, like hrv_baseline
  add column if not exists non_rem_hr            numeric,   -- nonRemHeartRateBeatsPerMinute (RHR measured in non-REM)
  add column if not exists non_rem_hr_baseline   numeric,   -- our trailing median, like rhr_baseline
  add column if not exists hr_nadir_min_baseline numeric,   -- trailing median of minutes: sleep onset → HR nadir
  add column if not exists spo2_min              numeric,   -- lowerBoundPercentage (nightly O2 floor)
  add column if not exists spo2_sd               numeric;   -- standardDeviationPercentage (overnight O2 spread)


-- 2. rebuild the read view --------------------------------------------------
-- CREATE OR REPLACE keeps the grants and only APPENDS columns, so the block
-- below is the migration-001 view verbatim with a "migration 002" section
-- added before FROM. security_invoker MUST stay on the statement or the view
-- hands every row to anon.
create or replace view public.night_summary with (security_invoker = true) as
select
  coalesce(n.night, d.night + 1) as night,
  coalesce(d.drinks, 0)      as drinks,
  coalesce(d.std_drinks, 0)  as std_drinks,
  d.first_drink,
  d.last_drink,

  n.hrv_rmssd, n.hrv_baseline, n.hrv_deep_rmssd,
  case when n.hrv_baseline > 0
       then round(100.0 * n.hrv_rmssd / n.hrv_baseline, 1) end as hrv_pct_baseline,

  n.rhr, n.rhr_baseline,
  n.rhr - n.rhr_baseline as rhr_delta,
  n.resp_rate, n.spo2, n.steps,

  n.sleep_start, n.sleep_end,
  n.total_sleep_min, n.rem_min, n.deep_min, n.light_min, n.waso_min,
  n.in_bed_min, n.sleep_need_min, n.sleep_debt_min, n.sleep_score,

  n.recovery, n.strain, n.hrmax, n.zone_min, n.stages,

  n.hr_nadir_bpm, n.hr_nadir_at,
  case when n.sleep_start is not null and n.hr_nadir_at is not null
       then round(extract(epoch from (n.hr_nadir_at - n.sleep_start)) / 60)::int end
       as min_to_nadir,

  n.hr_curve,
  n.workouts,

  -- Recovery Load (migration 001) -----------------------------------------
  n.skin_temp_c, n.skin_temp_baseline_c,
  case when n.skin_temp_c is not null and n.skin_temp_baseline_c is not null
       then round((n.skin_temp_c - n.skin_temp_baseline_c)::numeric, 2) end as skin_temp_delta,
  n.resp_rate_baseline,
  case when n.resp_rate is not null and n.resp_rate_baseline is not null
       then round((n.resp_rate - n.resp_rate_baseline)::numeric, 2) end as resp_rate_delta,
  n.body_load,

  -- deep-sleep HRV lens + non-REM HR + nadir timing + SpO2 bounds (migration 002)
  n.hrv_deep_baseline,
  case when n.hrv_deep_baseline > 0
       then round(100.0 * n.hrv_deep_rmssd / n.hrv_deep_baseline, 1) end as hrv_deep_pct_baseline,

  n.non_rem_hr, n.non_rem_hr_baseline,
  case when n.non_rem_hr is not null and n.non_rem_hr_baseline is not null
       then round((n.non_rem_hr - n.non_rem_hr_baseline)::numeric, 1) end as non_rem_hr_delta,

  n.hr_nadir_min_baseline,
  case when n.sleep_start is not null and n.hr_nadir_at is not null
            and n.hr_nadir_min_baseline is not null
       then round(extract(epoch from (n.hr_nadir_at - n.sleep_start)) / 60
                  - n.hr_nadir_min_baseline)::int end as nadir_delay_min,

  n.spo2_min,
  case when n.spo2 is not null and n.spo2_min is not null
       then round((n.spo2 - n.spo2_min)::numeric, 1) end as spo2_drop,
  n.spo2_sd
from public.nights n
full outer join (
  select night,
         count(*)        as drinks,
         sum(std_drinks) as std_drinks,
         min(logged_at)  as first_drink,
         max(logged_at)  as last_drink
  from public.drinks
  group by night
) d on d.night = n.night - 1;   -- drinks the evening before this row's morning


-- 3. grants (belt and suspenders -- CREATE OR REPLACE already keeps these) ----
revoke all on public.night_summary from anon;
grant select on public.night_summary to authenticated;


-- verify -------------------------------------------------------------------
-- select column_name from information_schema.columns
-- where table_name = 'night_summary'
--   and column_name in ('hrv_deep_baseline','hrv_deep_pct_baseline',
--                       'non_rem_hr','non_rem_hr_baseline','non_rem_hr_delta',
--                       'hr_nadir_min_baseline','nadir_delay_min',
--                       'spo2_min','spo2_drop','spo2_sd');
--
-- rollback ---------------------------------------------------------------------
-- alter table public.nights
--   drop column hrv_deep_baseline, drop column non_rem_hr,
--   drop column non_rem_hr_baseline, drop column hr_nadir_min_baseline,
--   drop column spo2_min, drop column spo2_sd;
-- then re-run the migration-001 night_summary block (or schema.sql's).
