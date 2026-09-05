-- Pulse · add workout sessions
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
--
-- Safe on the existing production database: adds one column to public.nights
-- and replaces public.night_summary to expose it. Touches nothing else --
-- no data is dropped, no other column changes, RLS and grants are untouched
-- (both are table/view-level, not column-level, and already cover this view).
-- Re-running it is a no-op (add column if not exists).
--
-- This mirrors the same two objects in schema.sql -- if you ever rebuild from
-- scratch there, this file becomes unnecessary; it exists only to bring an
-- already-running project up to date without a drop/recreate.

alter table public.nights
  add column if not exists workouts jsonb;

comment on column public.nights.workouts is
  'Passively-detected workout sessions that started this civil day: '
  '[{"type":"WALKING","start":"16:41","min":21,"cal":146,"avg_hr":116}, ...]. '
  'From the Google Health "exercise" data type, not logged by hand. '
  'Null on a day with none.';

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
  n.workouts
from public.nights n
full outer join (
  select night,
         count(*)        as drinks,
         sum(std_drinks) as std_drinks,
         min(logged_at)  as first_drink,
         max(logged_at)  as last_drink
  from public.drinks
  group by night
) d on d.night = n.night - 1;
