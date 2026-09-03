// The tag token.
//
// This is a capability, not an identity. It authorises exactly one thing --
// append a drink -- and nothing else. That scoping is the entire security
// model, because the token is physically readable by anyone who taps the
// sticker on your wrist. Worst case is a stranger logging a phantom drink.
//
// It must never be able to READ. A token that can read is a token that hands
// your drinking history to whoever brushes past you on a train.

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare. Overkill for a wrist sticker, but a plain ===
 * leaks the token prefix byte by byte to anyone who can time the endpoint,
 * and the fix is one line.
 */
function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which is itself a leak of
  // length -- unavoidable and harmless, since the length is fixed and public.
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Pull the token from wherever the caller could put it.
 *
 *   POST from the Shortcut  -> x-tag-token header (never logged by proxies)
 *   GET from the tag URL    -> ?t= query string, because a tag holds a URL and
 *                              a URL cannot carry a header
 *
 * The query form is strictly worse -- it lands in browser history and any
 * intermediary's access log -- which is why the Shortcut path is the primary
 * one and this is the fallback.
 */
export function checkTag(req) {
  const expected = process.env.TAG_TOKEN;
  if (!expected) throw new Error("missing env TAG_TOKEN -- see .env.example");
  if (expected.length < 32) throw new Error("TAG_TOKEN too short; use 32+ random chars");

  const header = req.headers["x-tag-token"];
  if (header) return sameToken(header, expected);

  const url = new URL(req.url, "http://x");
  const q = url.searchParams.get("t");
  return q ? sameToken(q, expected) : false;
}
