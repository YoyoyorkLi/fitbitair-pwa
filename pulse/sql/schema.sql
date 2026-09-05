-- Pulse · schema (Supabase / Postgres 15+)
--
-- Paste the whole file into Supabase -> SQL Editor -> New query -> Run.
-- Written for a fresh project; it creates, it does not migrate. If the tables
-- already exist, drop them first (Table Editor, or `drop table if exists
-- public.drinks, public.nights, public.sync_state cascade;`) and re-run.
--
-- Why a database at all, when the whole point of `pulse` was no hosting: an
-- NFC tap on iOS lands in Safari, and iOS gives home-screen web apps a storage
-- partition separate from Safari's. A localStorage write from the tap would be
-- invisible to the installed PWA. The log has to live somewhere both can reach.
--
-- Two writers, and they never overlap:
--   tap endpoint (Vercel, service_role key)  -> drinks
--   hourly sync  (GitHub Actions, push.py)   -> nights, sync_state
-- One reader: the PWA, on the anon key, fenced by RLS at the bottom of this file.


-- ---------------------------------------------------------------- night key
-- Every query in this project buckets by *drinking night*, not calendar day.
-- A drink at 1:15a belongs to the night before, and its cost shows up in that
-- same morning's recovery. 4am is the cut.
--
-- Not a generated column on drinks: `at time zone <name>` is STABLE, not
-- IMMUTABLE (the tz database can be updated under you), and Postgres refuses
-- STABLE expressions in generated columns. So the tap endpoint computes the
-- bucket and stores it. This function exists for backfills and for the
-- Fix-up screen, where a human is moving a row to a different night.
--
-- Mirrors the civil-time reasoning in metrics.py:30 -- same trap, same fix:
-- aggregate in a real IANA zone with DST rules, never a fixed offset.
--
-- The order of operations is load-bearing, and it is off by a day exactly once
-- a year. Convert to wall clock FIRST, then subtract 4 hours:
--       ((ts at time zone tz) - interval '4 hours')::date     <- this file
-- The obvious-looking alternative subtracts in real time first:
--       ((ts - interval '4 hours') at time zone tz)::date     <- wrong
-- They agree on every instant except the morning after the spring-forward,
-- where the wall clock skips an hour. Verified against Postgres 16:
--       2026-03-08 04:30 CDT  ->  wall-clock: Mar 8   real-time: Mar 7
-- A drink at 4:30am that Sunday would be filed under the night before, giving
-- one night of the year a phantom drink and its neighbour a missing one.
--
-- >>> CHANGE THE ZONE if you are not in Chicago. It is also the default in
-- >>> config.py:52 and web/public/app.js, so a wrong guess is wrong in three places.
create or replace function drink_night(ts timestamptz, tz text default 'America/Chicago')
returns date language sql stable as $$
  select ((ts at time zone tz) - interval '4 hours')::date;
$$;


-- ------------------------------------------------------------------- drinks
-- Append-mostly. A heavy night is ~8 rows, so this table stays small forever
-- and needs no partitioning, no retention policy, no thought.
create table public.drinks (
  id          bigint generated always as identity primary key,

  -- when the tap happened. Server clock, not the phone's -- Shortcuts fires
  -- the request immediately, and a phone with a skewed clock would misfile
  -- drinks across the 4am boundary.
  logged_at   timestamptz  not null default now(),

  -- the 4am-bucketed night. Denormalised from logged_at on purpose: every
  -- read groups by it, and recomputing the zone conversion per query is both
  -- slower and un-indexable.
  night       date         not null,

  -- what it was. Matters less than std_drinks -- see below -- but earns its
  -- place: bar pours run 1.5-2x a home pour, and beer volume drives overnight
  -- fragmentation independent of the alcohol.
  kind        text         not null
              check (kind in ('beer','wine','cocktail','shot','double','other')),

  -- THIS is the science. The dose-response x-axis is ethanol, not tap count.
  -- Counting taps puts a shot and a double on the same point and flattens the
  -- curve into noise. 1.0 std = 14g pure ethanol = 12oz beer @5% = 5oz wine
  -- @12% = 1.5oz spirits @40%.
  std_drinks  numeric(3,1) not null check (std_drinks > 0 and std_drinks <= 10),

  -- 'nfc'    the tag
  -- 'manual' added later from the Fix-up screen (a forgotten tap)
  -- 'edit'   a row whose kind/size you corrected after the fact
  -- Kept so you can ask later whether hand-entered nights are less reliable.
  --
  -- Defaults to 'manual', not 'nfc', on purpose. The tap endpoint is one
  -- function that always sets this explicitly; the PWA has several insert
  -- paths that might not. Defaulting to the value the *less* controlled
  -- writer needs means a forgotten field mislabels nothing.
  source      text         not null default 'manual'
              check (source in ('nfc','manual','edit')),

  note        text
);

create index drinks_night_idx  on public.drinks (night desc);
create index drinks_logged_idx on public.drinks (logged_at desc);


-- ------------------------------------------------------------------- nights
-- One row per night, written by the hourly sync (pulse/push.py). This is
-- metrics.py output flattened for reading -- the PWA does no math, and every
-- column here is something a chart actually draws.
create table public.nights (
  night           date primary key,

  -- Baselines are trailing 30-day medians (cfg.BASELINE_DAYS), computed in
  -- Python and stored here rather than as a window function at read time.
  -- "HRV 68% of baseline" then costs one row read instead of a 30-row scan,
  -- and the number the PWA shows is exactly the number the sync computed --
  -- no drift between what you saw this morning and what you see next month.
  hrv_rmssd       numeric,   -- averageHeartRateVariabilityMilliseconds

  hrv_baseline    numeric,

  -- The API also returns a true RMSSD scoped to deep sleep
  -- (deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds). Measured in
  -- a controlled state, so plausibly the steadier alcohol marker of the two.
  -- Stored alongside rather than instead of: the average is what the Google
  -- Health app shows, so it is the one whose numbers you can cross-check.
  hrv_deep_rmssd  numeric,
  rhr             numeric,
  rhr_baseline    numeric,
  resp_rate       numeric,
  spo2            numeric,   -- averagePercentage

  -- Steps arrive as per-minute intervals with a string `count`; the sync sums
  -- them into a daily total.
  steps           int,

  sleep_start     timestamptz,
  sleep_end       timestamptz,
  total_sleep_min int,
  rem_min         int,
  deep_min        int,
  light_min       int,

  -- Wake after sleep onset. More honest than sleep_score on a drinking night:
  -- alcohol front-loads slow-wave sleep, so a bad night can score well.
  waso_min        int,

  -- in_bed_min / sleep_need_min feed efficiency (asleep / in_bed) and the
  -- sleep-score panel's "needed" tile -- both computed by metrics.py and
  -- otherwise unrecoverable from total_sleep_min alone.
  in_bed_min      int,
  sleep_need_min  int,

  sleep_debt_min  int,       -- rolling shortfall vs need; drives its own chart
  sleep_score     numeric,
  recovery        numeric,
  strain          numeric,

  -- HRmax (Tanaka, from age) is constant per person and drawn from the server
  -- rather than recomputed in the browser, which has no business knowing your
  -- birthday. Used to draw the Karvonen zone bands on the heart-rate chart.
  hrmax           numeric,

  -- Five buckets of time-in-zone that tile the whole day: [z1..z5], minutes.
  zone_min        jsonb,

  -- Hypnogram segments, minute offsets from sleep_start:
  --   [{"t":"DEEP","a":0,"b":41}, {"t":"LIGHT","a":41,"b":78}, ...]
  -- The ribbon is drawn from transitions, not from the per-stage totals above.
  stages          jsonb,

  -- Time-to-nadir is the sleeper metric of this whole project. On a sober
  -- night HR bottoms out ~90 min after sleep onset; alcohol pushes it by
  -- hours and never lets it go as low. Less night-to-night noise than HRV.
  hr_nadir_bpm    smallint,
  hr_nadir_at     timestamptz,

  -- The overnight curve for the Night screen. As jsonb rather than a samples
  -- table because the access pattern is always "give me this one night, whole"
  -- -- one row, one fetch, no join.
  --
  -- MUST be downsampled to 1-minute buckets by the sync. The Air returns
  -- heart rate every ~2 seconds (measured: 36,000 samples/day, median gap 2s),
  -- so one raw night is 9,800 points and 146KB -- 52MB/year, a tenth of the
  -- free tier for a line nobody can see the detail in. At 1 minute it is 328
  -- points, 4.9KB/night, 1.7MB/year, and pixel-identical at chart width.
  hr_curve        jsonb,

  -- Passively-detected workout sessions that started this civil day, from the
  -- Google Health "exercise" data type -- not logged by hand:
  --   [{"type":"WALKING","start":"16:41","min":21,"cal":146,"avg_hr":116}, ...]
  -- Null on a day with none, same convention as steps for "nothing yet".
  workouts        jsonb,

  updated_at      timestamptz not null default now()
);


-- --------------------------------------------------------------- sync_state
-- Dead man's check. Supabase sleeps a project after 7 days of database
-- inactivity, and the hourly sync is what keeps this one awake -- so if the
-- sync dies, the database follows it down about a week later and the tap path
-- fails second. That failure is silent unless something watches for it.
-- GitHub also disables scheduled workflows after ~60 days of repo inactivity,
-- which is exactly the usage pattern this project has.
--
-- The PWA reads last_sync_at and shows it. Stale means go look.
create table public.sync_state (
  id           int primary key default 1 check (id = 1),   -- single row, enforced
  last_sync_at timestamptz,
  last_ok      boolean,
  message      text
);
insert into public.sync_state (id) values (1) on conflict do nothing;


-- ------------------------------------------------------------------- the join
-- Drinks against next-morning physiology. This view *is* the dose-response
-- dataset -- the payoff chart is:
--     select std_drinks, hrv_pct_baseline from night_summary where std_drinks > 0
--
-- ---------------------------------------------------------------------------
-- THE JOIN IS OFFSET BY A DAY, and it has to be. The two tables key their
-- "night" from opposite ends of the same sleep:
--
--   drinks.night   the EVENING you drank. drink_night() subtracts 4 hours, so
--                  9pm Sep 2 and 1am Sep 3 both bucket to Sep 2.
--   nights.night   the MORNING the sleep ended. metrics.py:272 and :387 key
--                  every row by n["end"].normalize(), and steps / strain /
--                  zone_min on that row are that calendar day's totals.
--
-- So the sleep that answers "what did Sep 2's drinking do to me" is the row
-- dated Sep 3, not Sep 2. Verified against real cached data: sleep sessions
-- run 01:19-03:13 to ~08:20, so a night's drinking (which ends before the 4am
-- cut) always buckets to the day BEFORE the row holding the sleep it wrecked.
--
-- Joining d.night = n.night instead -- which is what this view did until this
-- was caught -- pairs each drinking night with the morning roughly twenty
-- hours BEFORE the first drink. The dose-response chart still drew a slope;
-- it was just measuring the wrong pair, and the sign of a real effect is
-- easily mistaken for the noise of a fake one.
--
-- The `night` this view exposes stays the nights-row date (the morning), NOT
-- the drinking evening. Relabelling to the evening would line the drinks up
-- with the label but silently misdate steps, strain and zone_min, which are
-- day totals for the row's own date.
--
-- FULL OUTER JOIN, and both halves are load-bearing:
--
--   nights with no drinks  -- sober nights. Not padding: they define the
--     baseline the drinking nights are measured against, and dropping them
--     would bias the dose-response fit upward.
--
--   drinks with no night   -- TONIGHT. You start drinking at 9pm; the sync
--     writes the nights row the next morning, after the Air has uploaded and
--     Google has processed it. A LEFT JOIN from nights would make the night in
--     progress invisible until the following day, which is exactly when you
--     most want to see "3 so far".
--
-- Hence coalesce on the join key -- either side can be the one that exists.
-- security_invoker rides on the CREATE, not a follow-up ALTER. A view runs with
-- its OWNER's rights by default, which would hand every row to anon and
-- quietly route around every policy below. Declared here, the property cannot
-- be separated from the view -- copy the statement anywhere and it stays safe.
--
-- This view is the entire read contract with the PWA: web/public/app.js's
-- loadLive() selects "*" from it and expects exactly these column names.
create or replace view public.night_summary with (security_invoker = true) as
select
  -- d.night + 1 on the drinks-only side: a night in progress has no nights row
  -- yet, and the morning it belongs to is the next day.
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
) d on d.night = n.night - 1;   -- drinks the evening before this row's morning


-- ---------------------------------------------------------------------- RLS
-- The anon key ships inside the PWA's JavaScript. It is public by definition;
-- treat it as a username, not a password. RLS is the only thing standing
-- between a curious visitor and a log of your drinking.
--
-- Authenticated = you, and only you, which takes two dashboard steps in order:
--   1. Authentication -> Users -> Add user. Email + password, auto-confirm.
--      No front end is involved; the account exists before any code does.
--   2. Authentication -> Sign In / Providers -> "Allow new users to sign up" OFF
-- That order matters. Reverse it and you lock yourself out; skip step 2 and
-- anyone can become `authenticated` and every policy below hands them
-- everything.
--
-- There is no users table here because Supabase owns it: `auth.users`, in the
-- auth schema, invisible from the public Table Editor. Nothing to create.
--
-- Sign the PWA in with a PASSWORD, not a magic link. A magic link opens in
-- Safari and sets the session in Safari's storage -- which on iOS is a
-- different partition from the home-screen web app, the same quirk that forced
-- this whole database to exist. The link would authenticate the wrong browser.
-- An emailed OTP code works too, because you type it inside the app.
alter table public.drinks     enable row level security;
alter table public.nights     enable row level security;
alter table public.sync_state enable row level security;

create policy "read drinks"   on public.drinks     for select to authenticated using (true);
create policy "read nights"   on public.nights     for select to authenticated using (true);
create policy "read sync"     on public.sync_state for select to authenticated using (true);

-- The Fix-up screen writes straight to the table rather than through an
-- endpoint. That is the whole reason Supabase won over Neon here: the auto
-- REST layer means the read/edit path needs no serverless functions at all.
create policy "add drinks"    on public.drinks for insert to authenticated with check (true);
create policy "edit drinks"   on public.drinks for update to authenticated using (true) with check (true);
create policy "delete drinks" on public.drinks for delete to authenticated using (true);

-- Deliberately no policy for `anon`, and none for writing nights/sync_state.
-- The tap endpoint and the sync both use the service_role key server-side,
-- which bypasses RLS entirely -- so nothing here needs to grant them anything.
-- If the service_role key ever appears in client code, all of the above is
-- decoration.


-- ------------------------------------------------------------------- grants
-- RLS only fences a role that was granted something in the first place, and
-- Supabase's default privileges silently hand `anon` and `authenticated` full
-- table rights on everything new in `public`. Two reasons to be explicit:
--
--   1. The file stops depending on an invisible project-level default. Paste
--      it into a project configured differently and it still behaves.
--   2. Revoking anon is a second lock. RLS is the real one -- but if it ever
--      gets switched off during debugging and left off, the grant layer still
--      returns "permission denied" instead of your drinking history.
revoke all on public.drinks, public.nights, public.sync_state, public.night_summary from anon;

grant usage  on schema public to authenticated;
grant select, insert, update, delete on public.drinks to authenticated;
grant select on public.nights, public.sync_state, public.night_summary to authenticated;
