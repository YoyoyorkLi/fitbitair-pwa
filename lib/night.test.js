// Parity fixtures for drinkNight().
//
//     node lib/night.test.js
//
// Every expected value below was produced by Postgres 16 running
// drink_night() from sql/schema.sql, not by reading this implementation. If
// the two ever drift, drinks land on the wrong night and the dose-response
// join quietly corrupts.

import { drinkNight, localClock } from "./night.js";

const TZ = "America/Chicago";

const CASES = [
  // instant                      expected night   what it is
  ["2026-03-14T23:30:00-05:00",   "2026-03-14",    "ordinary evening"],
  ["2026-03-15T01:15:00-05:00",   "2026-03-14",    "past midnight, same night"],
  ["2026-03-15T03:59:00-05:00",   "2026-03-14",    "last minute of the night"],
  ["2026-03-15T04:00:00-05:00",   "2026-03-15",    "the cut"],

  // Spring forward: 02:00 CST -> 03:00 CDT on 2026-03-08. A 23-hour night.
  ["2026-03-08T01:30:00-06:00",   "2026-03-07",    "before the jump"],
  ["2026-03-08T03:30:00-05:00",   "2026-03-07",    "after the jump"],
  ["2026-03-08T04:30:00-05:00",   "2026-03-08",    "past the cut on DST morning"],

  // Fall back: 02:00 CDT -> 01:00 CST on 2026-11-01. 01:30 happens twice;
  // two distinct instants, one drinking night.
  ["2026-11-01T01:30:00-05:00",   "2026-10-31",    "repeated hour, first pass"],
  ["2026-11-01T01:30:00-06:00",   "2026-10-31",    "repeated hour, second pass"],
  ["2026-11-01T04:30:00-06:00",   "2026-11-01",    "past the cut, after fall back"],

  ["2026-06-15T23:30:00-05:00",   "2026-06-15",    "midsummer"],
  ["2026-12-31T23:59:00-06:00",   "2026-12-31",    "new year's eve"],
  ["2027-01-01T02:00:00-06:00",   "2026-12-31",    "new year's morning is still NYE"],
];

const CLOCKS = [
  ["2026-03-14T23:42:00-05:00", "11:42p"],
  ["2026-03-15T00:05:00-05:00", "12:05a"],
  ["2026-03-15T12:30:00-05:00", "12:30p"],
  ["2026-03-15T09:07:00-05:00", "9:07a"],
];

let failed = 0;

for (const [iso, expected, label] of CASES) {
  const got = drinkNight(new Date(iso), TZ);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${iso}  ->  ${got}${ok ? "" : `  (expected ${expected})`}   ${label}`);
}

console.log("");

for (const [iso, expected] of CLOCKS) {
  const got = localClock(new Date(iso), TZ);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  clock ${iso}  ->  ${got}${ok ? "" : `  (expected ${expected})`}`);
}

console.log("");
if (failed) {
  console.error(`${failed} failure(s) -- JS and Postgres disagree about what night it is`);
  process.exit(1);
}
console.log(`all ${CASES.length + CLOCKS.length} fixtures match Postgres`);
