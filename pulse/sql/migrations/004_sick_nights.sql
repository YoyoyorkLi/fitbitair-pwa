-- Pulse migration 004 — sick nights
-- =============================================================================
-- Run ONCE:  Supabase dashboard → SQL Editor → New query → paste this whole
-- file → Run.
--
-- Safe to run NOW, before the code ships: nothing reads the table until the
-- new app and push.py go live, and both treat a missing table as "no sick
-- nights". Safe to re-run: every statement is idempotent. No existing row is
-- touched.
--
-- What it does:
--   1. creates public.sick_nights -- one row per evening you tapped "Sick
--      tonight" in the app
--   2. row-level security + grants, same shape as public.drinks
--
-- Why: Recovery Load had no labelled illness nights to be checked against,
-- only drinking nights. A sick tag gives it one, and push.py also leaves sick
-- nights (and drinking nights) out of the 30-night "normal" each marker is
-- compared to.
--
-- `night` is the EVENING, the same 4am convention as drinks.night: tapped at
-- 11pm Monday or 1am Tuesday, it is Monday's night, and it belongs to the
-- nights row dated Tuesday (night + 1), exactly like a drink.
-- =============================================================================


-- 1. table --------------------------------------------------------------------
create table if not exists public.sick_nights (
  night       date         primary key,
  created_at  timestamptz  not null default now()
);

comment on table public.sick_nights is
  'Evenings tagged "Sick tonight" in the app. night = the evening (4am rule, '
  'same as drinks.night); the morning it affects is night + 1.';


-- 2. RLS + grants (mirrors public.drinks) ---------------------------------------
alter table public.sick_nights enable row level security;

drop policy if exists "read sick"   on public.sick_nights;
drop policy if exists "add sick"    on public.sick_nights;
drop policy if exists "delete sick" on public.sick_nights;
create policy "read sick"   on public.sick_nights for select to authenticated using (true);
create policy "add sick"    on public.sick_nights for insert to authenticated with check (true);
create policy "delete sick" on public.sick_nights for delete to authenticated using (true);

revoke all on public.sick_nights from anon;
grant select, insert, delete on public.sick_nights to authenticated;


-- verify -------------------------------------------------------------------------
-- select * from public.sick_nights order by night desc;
--
-- rollback -----------------------------------------------------------------------
-- drop table public.sick_nights;
