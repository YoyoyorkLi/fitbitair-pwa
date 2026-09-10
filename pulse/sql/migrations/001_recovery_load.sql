-- Pulse migration 001 — Recovery Load (skin temperature + overnight anomaly flag)
-- =============================================================================
-- Run ONCE:  Supabase dashboard → SQL Editor → New query → paste this whole
-- file → Run.
--
-- Safe to run NOW, before the Recovery Load code ships: the four new columns
-- just sit NULL until push.py starts filling them, and nothing that exists
-- today reads them. Safe to re-run: every statement is idempotent. No existing
-- row is rewritten; no downtime.
--
-- What it does:
--   1. adds 4 nullable columns to public.nights
--   2. appends them (+ 2 computed deltas, matching the existing rhr_delta) to
--      the public.night_summary view the PWA reads
--
-- After this, deploy the code, then run the sync workflow with full:true once
-- to backfill body_load across your history.
-- =============================================================================


-- 1. new columns --------------------------------------------------------------
alter table public.nights
  add column if not exists skin_temp_c          numeric,   -- nightlyTemperatureCelsius (absolute °C)
  add column if not exists skin_temp_baseline_c numeric,   -- Google's baselineTemperatureCelsius
  add column if not exists resp_rate_baseline   numeric,   -- our trailing-30-night median, like hrv_baseline
  add column if not exists body_load            numeric;   -- composite anomaly score; NULL until the baseline exists


-- 2. rebuild the read view --------------------------------------------------
-- CREATE OR REPLACE keeps the grants and only APPENDS the new columns, so the
-- block below is the current view definition verbatim with a Recovery Load
-- section added before FROM. security_invoker MUST stay on the statement or the
-- view hands every row to anon.
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

  -- Recovery Load (migration 001) -------------------------------------------
  n.skin_temp_c, n.skin_temp_baseline_c,
  case when n.skin_temp_c is not null and n.skin_temp_baseline_c is not null
       then round((n.skin_temp_c - n.skin_temp_baseline_c)::numeric, 2) end as skin_temp_delta,
  n.resp_rate_baseline,
  case when n.resp_rate is not null and n.resp_rate_baseline is not null
       then round((n.resp_rate - n.resp_rate_baseline)::numeric, 2) end as resp_rate_delta,
  n.body_load
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
-- where table_name = 'night_summary' and column_name like '%temp%' or column_name = 'body_load';
--
-- rollback ---------------------------------------------------------------------
-- alter table public.nights
--   drop column skin_temp_c, drop column skin_temp_baseline_c,
--   drop column resp_rate_baseline, drop column body_load;
-- then re-run the pre-001 night_summary block from schema.sql.
