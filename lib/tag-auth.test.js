// The tag token is the only thing standing between a passing stranger and a
// write to your database. These are the cases that matter.
//
//     node lib/tag-auth.test.js

import { checkTag } from "./tag-auth.js";

const GOOD = "a".repeat(64);
const req = (headers = {}, url = "/api/tap") => ({ headers, url });

let failed = 0;
function is(label, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `  (got ${got}, want ${want})`}`);
}
function throws(label, fn) {
  try { fn(); is(label, false, true); }
  catch { console.log(`ok    ${label}`); }
}

process.env.TAG_TOKEN = GOOD;

is("header, correct token",   checkTag(req({ "x-tag-token": GOOD })), true);
is("header, wrong token",     checkTag(req({ "x-tag-token": "b".repeat(64) })), false);
is("header, truncated token", checkTag(req({ "x-tag-token": GOOD.slice(0, 32) })), false);
is("header, token + suffix",  checkTag(req({ "x-tag-token": GOOD + "x" })), false);
is("no token at all",         checkTag(req()), false);
is("empty header",            checkTag(req({ "x-tag-token": "" })), false);

is("query, correct token",    checkTag(req({}, `/api/tap?t=${GOOD}`)), true);
is("query, wrong token",      checkTag(req({}, "/api/tap?t=nope")), false);
is("query, empty",            checkTag(req({}, "/api/tap?t=")), false);
is("query alongside kind",    checkTag(req({}, `/api/tap?kind=beer&t=${GOOD}`)), true);

// A header that is present but wrong must NOT fall through to the query
// string -- otherwise a bad header plus a good query is a way in, and the
// header is the path we actually trust.
is("bad header wins over good query",
   checkTag(req({ "x-tag-token": "wrong" }, `/api/tap?t=${GOOD}`)), false);

// Misconfiguration must be loud. A missing or weak token that quietly
// evaluated to "deny" would look identical to a wrong token in the logs; one
// is an attack, the other is a broken deploy.
process.env.TAG_TOKEN = "";
throws("missing TAG_TOKEN throws", () => checkTag(req({ "x-tag-token": GOOD })));

process.env.TAG_TOKEN = "short";
throws("short TAG_TOKEN throws", () => checkTag(req({ "x-tag-token": "short" })));

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log("tag auth ok");
