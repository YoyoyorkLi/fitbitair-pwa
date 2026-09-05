// The 4am night bucket, in JavaScript.
//
// This MUST agree with drink_night() in sql/schema.sql on every instant. Two
// implementations of the same rule is a liability, but the alternative is a
// round trip to Postgres on the hot path of a tap, and the tap has a one-second
// budget. lib/night.test.js pins both against the same fixtures.
//
// The order of operations is the whole game -- convert to wall clock FIRST,
// then subtract. Subtracting real time first is off by a day on the morning
// after the spring-forward. See the comment on drink_night() for the case.

export const DEFAULT_TZ = process.env.PULSE_TZ || "America/Chicago";
const CUTOFF_HOURS = 4;

/**
 * Wall-clock parts for an instant in a named zone.
 * Intl is the only thing in the platform that knows the tz database.
 */
function wallParts(instant, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // hour12:false legitimately emits "24" for midnight in some ICU versions.
  // Left unhandled it throws the date forward a full day.
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

/**
 * Which drinking night does this instant belong to?
 * Returns a plain YYYY-MM-DD string -- Postgres `date`, no zone, no time.
 */
export function drinkNight(instant, tz = DEFAULT_TZ) {
  const p = wallParts(instant, tz);
  // Anchor the wall clock to UTC so the subtraction is pure arithmetic with no
  // DST rules applied a second time. This is the JS equivalent of Postgres
  // handing back a `timestamp without time zone`.
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(wall - CUTOFF_HOURS * 3600_000).toISOString().slice(0, 10);
}

/** "11:42 PM" -- what the tap notification shows. */
export function localClock(instant, tz = DEFAULT_TZ) {
  const p = wallParts(instant, tz);
  const h24 = +p.hour;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${p.minute} ${h24 < 12 ? "AM" : "PM"}`;
}
