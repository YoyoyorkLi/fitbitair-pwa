-- Pulse migration 003 — naps
-- =============================================================================
-- Run ONCE:  Supabase dashboard → SQL Editor → New query → paste this whole
-- file → Run.
--
-- Safe to run NOW, before the code ships: the new column just sits NULL until
-- push.py starts filling it, and nothing that exists today reads it. Safe to
-- re-run: every statement is idempotent. No existing row is rewritten; no
-- downtime.
--
-- What it does:
--   1. adds one nullable jsonb column, naps, to public.nights
--   2. appends it to the public.night_summary view the PWA selects "*" from
--
-- Why: the Google Health API returns a nap as its own sleep session, flagged
-- metadata.nap, complete with stages. Pulse already ingested it and credited its
-- minutes to sleep debt and recovery (METRICS.md, "Naps") -- but main_sleeps()
-- discards it, so nothing was stored and the app could not show it.
--
-- ORDER MATTERS when deploying: run this BEFORE the push.py that writes `naps`
-- goes live. PostgREST rejects an upsert that names a column the table does not
-- have, and the hourly sync would fail until this had run.
-- =============================================================================


-- 1. new column ---------------------------------------------------------------
alter table public.nights
  add column if not exists naps jsonb;

comment on column public.nights.naps is
  'Naps that started this civil day -- every sleep session that is not the '
  'day''s main sleep and is at least 10 min asleep: '
  '[{"start":"13:31","end":"16:21","min":146,"in_bed":170,'
  '"stages":[{"t":"LIGHT","a":9,"b":30}, ...]}, ...]. '
  'stages are minute offsets from the nap''s own start, same shape as '
  '`stages`. Null on a day with none.';


-- 2. rebuild the read view ----------------------------------------------------
-- CREATE OR REPLACE keeps the grants and only APPENDS columns, so the block
-- below is the migration-002 view verbatim with `n.naps` added at the end.
-- security_invoker MUST stay on the statement or the view hands every row to
-- anon.
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
  n.spo2_sd,

  -- Naps (migration 003): every session that is not the day's main sleep.
  n.naps
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
-- where table_name = 'night_summary' and column_name = 'naps';
--
-- rollback ---------------------------------------------------------------------
-- alter table public.nights drop column naps;
-- then re-run the migration-002 night_summary block (or schema.sql's).
