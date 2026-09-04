// Trigger the hourly sync on demand.
//
//   POST /api/sync
//     Authorization: Bearer <supabase access token>
//     -> 202 {"ok":true,"run":"dispatched"}
//
// Why this endpoint exists at all: GitHub's schedule is best-effort. The cron
// asks for hourly and observed gaps are 2.5-4h, so the number on screen can be
// hours old with nothing wrong. This is the "no, now" button.
//
// Why it cannot live in the browser: dispatching a workflow needs a GitHub
// token with Actions:write. The PWA runs on the anon key, which is public by
// definition -- shipping a dispatch token next to it would hand anyone who
// views source the ability to run workflows on the repo. So the token stays
// here, server-side, and the browser proves who it is instead.
//
// The work itself does NOT happen here. This returns as soon as GitHub accepts
// the dispatch; the ~4 minutes of syncing runs on GitHub's infrastructure. The
// phone can lock, the app can close, the tab can die -- the data still lands.

const GH = "https://api.github.com";
const UA = "pulse-pwa";                 // GitHub rejects requests without one
const WORKFLOW = process.env.GH_WORKFLOW || "sync.yml";

// Vercel injects the git owner/slug for repo-linked projects, so the common
// case needs no configuration. GH_REPO overrides for anything else.
function repo() {
  const explicit = process.env.GH_REPO;
  if (explicit) return explicit.trim().replace(/^\/+|\/+$/g, "");
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  return owner && slug ? `${owner}/${slug}` : "";
}

/**
 * Who is calling? Verified against Supabase rather than trusted.
 *
 * The token is checked by asking Supabase to resolve it, not by decoding it
 * here: signature verification needs the JWT secret, and this function has no
 * business holding that. A 200 from /auth/v1/user is proof enough, and it also
 * catches a revoked session, which a local signature check would not.
 */
async function callerIsSignedIn(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return false;

  const base = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  const anon = process.env.SUPABASE_ANON_KEY || "";
  if (!base || !anon) throw new Error("missing SUPABASE_URL or SUPABASE_ANON_KEY");

  const r = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  return r.ok;
}

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": UA,
});

/** Is a run already going? Dispatching a second is pure waste -- both would
 *  fetch the same 30 days and race to upsert identical rows. */
async function runInFlight(slug, token) {
  const r = await fetch(`${GH}/repos/${slug}/actions/workflows/${WORKFLOW}/runs?per_page=5`, {
    headers: ghHeaders(token),
  });
  if (!r.ok) return null;                       // not fatal; fall through to dispatch
  const body = await r.json();
  return (body.workflow_runs || []).some((w) => w.status === "queued" || w.status === "in_progress");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") return json(res, 405, { error: "POST only" });

  const token = process.env.GH_DISPATCH_TOKEN;
  const slug = repo();
  if (!token || !slug) {
    console.error("sync: missing GH_DISPATCH_TOKEN or repo slug");
    return json(res, 500, { error: "server misconfigured" });
  }

  let signedIn;
  try {
    signedIn = await callerIsSignedIn(req);
  } catch (err) {
    console.error("sync: auth check failed:", err.message);
    return json(res, 500, { error: "server misconfigured" });
  }
  // Sign-ups are disabled in Supabase (see sql/schema.sql), so "authenticated"
  // is the account holder and nobody else. No per-user check needed here.
  if (!signedIn) return json(res, 401, { error: "sign in first" });

  try {
    if (await runInFlight(slug, token)) {
      return json(res, 409, { error: "a sync is already running", run: "in_progress" });
    }

    const r = await fetch(`${GH}/repos/${slug}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: process.env.GH_REF || "main" }),
    });

    if (r.status === 204) return json(res, 202, { ok: true, run: "dispatched" });

    // A fine-grained token carries an expiry, so this WILL happen one day.
    // Saying which failure it was beats a generic 502 that sends you reading
    // workflow logs for a token that simply aged out.
    const detail = (await r.text()).slice(0, 300);
    console.error(`sync: dispatch failed ${r.status}: ${detail}`);
    // Pass GitHub's own message through. Guessing at the cause was actively
    // unhelpful: a 403 here can mean the permission is missing, OR the repo
    // was never selected on the token, OR a fine-grained token is awaiting
    // owner approval -- three different fixes behind one sentence. Only a
    // verified caller reaches this line, and GitHub's errors never echo the
    // credential, so the detail is safe to return.
    let why = "";
    try { why = JSON.parse(detail).message || ""; } catch { why = ""; }
    const hint =
      r.status === 401 ? "GitHub rejected the token — expired, revoked, or mistyped"
      : r.status === 403 ? "GitHub refused: check the token has Actions: Read and write AND lists this repo"
      : r.status === 404 ? `Not found: ${slug} / ${WORKFLOW} — also what GitHub returns when the token cannot see the repo at all`
      : `GitHub said ${r.status}`;
    return json(res, 502, { error: why ? `${hint} — GitHub: ${why}` : hint, status: r.status });
  } catch (err) {
    console.error("sync: dispatch threw:", err.message || err);
    return json(res, 502, { error: "could not reach GitHub" });
  }
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.send(JSON.stringify(body));
}
