// The tap endpoint. Phase 1, and the only path that has to work.
//
// Two callers, one behaviour:
//
//   POST  from the iOS Shortcut. Body {"kind":"beer"}. Returns plain text,
//         which Shortcuts renders as the notification: "Drink 3 · 11:42p".
//
//   GET   from the URL written on the tag, when the Shortcut is unavailable
//         (new phone, reset automation, someone else's hand). iOS opens it in
//         Safari, so this returns an HTML page with the correction controls.
//
// Latency budget is one second. That is why this is a Vercel function and not
// the hourly GitHub Actions job: Actions needs 30-60s just to start.

import { db } from "../lib/db.js";
import { checkTag } from "../lib/tag-auth.js";
import { drinkNight, localClock, DEFAULT_TZ } from "../lib/night.js";

// Standard drinks per kind. Lives on the server so the Shortcut's menu stays
// dumb -- it sends a word, not a number, and the science is defined in one
// place. 1.0 std = 14g ethanol.
const STD = { beer: 1.0, wine: 1.0, cocktail: 1.5, shot: 1.0, double: 2.0, other: 1.0 };

// A double-tap, or Safari re-requesting the URL on a back-navigation, must not
// log twice. Short on purpose: on a real night the second round is a genuine
// drink minutes later, not seconds.
const DEDUPE_SECONDS = 15;

export default async function handler(req, res) {
  const wantsHtml = req.method === "GET";

  if (req.method !== "GET" && req.method !== "POST") {
    return send(res, wantsHtml, 405, "method not allowed");
  }

  let authed;
  try {
    authed = checkTag(req);
  } catch (err) {
    // Misconfiguration, not a bad token. Worth distinguishing in the logs;
    // not worth distinguishing to the caller.
    console.error("tap: config error:", err.message);
    return send(res, wantsHtml, 500, "server misconfigured");
  }
  if (!authed) return send(res, wantsHtml, 401, "nope");

  const kind = readKind(req);
  if (!kind) return send(res, wantsHtml, 400, "unknown drink");

  // One instant for everything. logged_at and night must derive from the same
  // clock reading or a tap at 03:59:59.9 can be filed under a night its own
  // timestamp contradicts.
  const now = new Date();
  const night = drinkNight(now, DEFAULT_TZ);

  try {
    const sb = db();

    const since = new Date(now.getTime() - DEDUPE_SECONDS * 1000).toISOString();
    // Scoped by night as well as kind and time: within 15s of the 4am cut, a
    // tap can fall on either side of the boundary. Without the night filter
    // the second tap would match the first as a "duplicate" that actually
    // belongs to a different night, get silently skipped, and never appear
    // in either night's count.
    const { data: recent, error: dupErr } = await sb
      .from("drinks")
      .select("id")
      .eq("kind", kind)
      .eq("night", night)
      .gte("logged_at", since)
      .limit(1);
    if (dupErr) throw dupErr;

    if (!recent?.length) {
      const { error } = await sb.from("drinks").insert({
        logged_at: now.toISOString(),
        night,
        kind,
        std_drinks: STD[kind],
        source: "nfc",
      });
      if (error) throw error;
    }

    // Count after the write so the number shown is the number stored, whether
    // or not this particular tap was deduped.
    const { count, error: cErr } = await sb
      .from("drinks")
      .select("id", { count: "exact", head: true })
      .eq("night", night);
    if (cErr) throw cErr;

    const line = `Drink ${count} · ${localClock(now, DEFAULT_TZ)}`;
    return wantsHtml
      ? sendPage(res, 200, line, count, night)
      : send(res, false, 200, line);
  } catch (err) {
    console.error("tap: write failed:", err.message || err);
    // A tap that silently does nothing is worse than one that says so -- you
    // would keep drinking and never know the night was not being recorded.
    return send(res, wantsHtml, 503, "not logged — check the dashboard");
  }
}

function readKind(req) {
  let raw;
  if (req.method === "POST") {
    const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
    raw = body?.kind;
  } else {
    raw = new URL(req.url, "http://x").searchParams.get("kind");
  }
  // The tag URL carries no kind at all -- one sticker cannot ask a question.
  // Beer is the modal drink; the confirmation page lets you change it.
  const kind = (raw || "beer").toString().toLowerCase().trim();
  return Object.hasOwn(STD, kind) ? kind : null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function send(res, html, status, text) {
  if (!html) {
    res.status(status).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(text);
  }
  return sendPage(res, status, text, null, null);
}

// The fallback confirmation page. Deliberately one file, no framework, no
// network beyond the form posts -- it renders on a bad connection in a loud
// room, and it is read by someone who has been drinking. Big targets, high
// contrast, nothing to scroll.
function sendPage(res, status, line, count, night) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const controls = count == null ? "" : `
    <form method="GET" class="row">
      <input type="hidden" name="t" value="">
      <p class="hint">tap again to correct — the count above is what's stored</p>
    </form>`;

  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pulse</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:flex;align-items:center;justify-content:center;
 background:#0B0E14;color:#E6EAF2;font:600 17px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif;
 padding:24px;text-align:center}
.big{font-size:clamp(30px,9vw,44px);letter-spacing:-.02em;margin:0 0 10px}
.sub{color:#7E8AA3;font-weight:400;font-size:15px;margin:0}
.hint{color:#5A6478;font-weight:400;font-size:13px;margin:26px 0 0}
</style></head><body><main>
<p class="big">${esc(line)}</p>
${night ? `<p class="sub">${esc(night)}</p>` : ""}
${controls}
</main></body></html>`);
}
