// Every static JSON file under public/ must be strict, spec-compliant JSON --
// the same failure this once caught in production: Python's json.dump()
// emits bare NaN by default (legal in Python's own dialect, illegal per
// RFC 8259), and app.js loads these files with `fetch(...).then(r => r.json())`,
// which is a strict parser. A bare NaN throws there, silently, for every path
// that falls back to a fixture -- ?demo=1, a fresh account before the first
// sync, or Supabase returning nothing.
//
// This was invisible for weeks because every manual test in this repo's
// history used the offline preview builder, which inlines JSON as raw
// JavaScript source (window.__PULSE_DEMO__ = <text>) -- a context where bare
// NaN is legal, so it never exercised the real fetch().json() path at all.
//
//     node lib/json-fixtures.test.js

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

let failed = 0;
const files = readdirSync(publicDir).filter((f) => f.endsWith(".json"));

if (!files.length) {
  console.error("FAIL  no .json files found under public/ -- did the fixture move?");
  process.exit(1);
}

for (const f of files) {
  const path = join(publicDir, f);
  const text = readFileSync(path, "utf8");
  try {
    JSON.parse(text);
    console.log(`ok    ${f}  is strict JSON`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${f}  ${e.message}`);
  }
}

console.log("");
if (failed) {
  console.error(`${failed} fixture(s) are not valid JSON -- the real app's fetch().json() would throw on these`);
  process.exit(1);
}
console.log(`all ${files.length} JSON fixture(s) parse under strict JSON.parse`);
