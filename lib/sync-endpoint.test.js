// api/sync.js — the auth boundary.
//
// Lives in lib/ rather than next to the thing it tests because Vercel turns
// every file under api/ into a deployed function: api/sync.test.js would ship
// as a public endpoint at /api/sync.test.
//
// The property that matters is narrow and absolute: NOTHING dispatches a
// workflow unless Supabase confirmed the caller's session. A bug here does not
// leak the token, but it does hand an anonymous internet stranger a button
// that runs GitHub Actions on the repo, over and over.
//
// Both fetch targets are stubbed, so this makes no network calls and needs no
// credentials.

import handler from "../api/sync.js";

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

function mockRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.send = (b) => { r.body = typeof b === "string" ? JSON.parse(b) : b; return r; };
  return r;
}

// Records every outbound call so a test can assert a dispatch did NOT happen.
function stubFetch({ userOk = true, runs = [], dispatchStatus = 204 }) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET" });
    if (String(url).includes("/auth/v1/user")) {
      return { ok: userOk, status: userOk ? 200 : 401, json: async () => ({}), text: async () => "" };
    }
    if (String(url).includes("/runs?")) {
      return { ok: true, status: 200, json: async () => ({ workflow_runs: runs }), text: async () => "" };
    }
    if (String(url).includes("/dispatches")) {
      return { ok: dispatchStatus < 300, status: dispatchStatus, json: async () => ({}), text: async () => "boom" };
    }
    throw new Error("unexpected fetch: " + url);
  };
  return calls;
}

const dispatched = (calls) => calls.some((c) => c.url.includes("/dispatches"));

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.GH_DISPATCH_TOKEN = "ghp_test";
process.env.GH_REPO = "owner/repo";

const post = { method: "POST", headers: { authorization: "Bearer good" } };

// --- the refusals -----------------------------------------------------------
{
  const calls = stubFetch({});
  const res = mockRes();
  await handler({ method: "GET", headers: {} }, res);
  ok(res.code === 405 && !dispatched(calls), "GET is refused, nothing dispatched");
}
{
  const calls = stubFetch({});
  const res = mockRes();
  await handler({ method: "POST", headers: {} }, res);
  ok(res.code === 401 && !dispatched(calls), "no Authorization header -> 401, nothing dispatched");
}
{
  const calls = stubFetch({});
  const res = mockRes();
  await handler({ method: "POST", headers: { authorization: "good" } }, res);
  ok(res.code === 401 && !dispatched(calls), "malformed header (no Bearer) -> 401, nothing dispatched");
}
{
  // The one that matters: Supabase says this session is not valid.
  const calls = stubFetch({ userOk: false });
  const res = mockRes();
  await handler(post, res);
  ok(res.code === 401 && !dispatched(calls), "rejected session -> 401, nothing dispatched");
}
{
  const saved = process.env.GH_DISPATCH_TOKEN;
  delete process.env.GH_DISPATCH_TOKEN;
  const calls = stubFetch({});
  const res = mockRes();
  await handler(post, res);
  ok(res.code === 500 && !dispatched(calls), "missing GH_DISPATCH_TOKEN -> 500, nothing dispatched");
  process.env.GH_DISPATCH_TOKEN = saved;
}

// --- the happy path ---------------------------------------------------------
{
  const calls = stubFetch({});
  const res = mockRes();
  await handler(post, res);
  const d = calls.find((c) => c.url.includes("/dispatches"));
  ok(res.code === 202 && res.body.ok === true, "signed in -> 202 accepted");
  ok(d && d.method === "POST" && d.url.includes("owner/repo") && d.url.includes("sync.yml"),
    "dispatch targets the configured repo and workflow");
}

// --- concurrency and failure reporting --------------------------------------
{
  const calls = stubFetch({ runs: [{ status: "in_progress" }] });
  const res = mockRes();
  await handler(post, res);
  ok(res.code === 409 && !dispatched(calls), "a run already in progress -> 409, no second dispatch");
}
{
  const calls = stubFetch({ runs: [{ status: "queued" }] });
  const res = mockRes();
  await handler(post, res);
  ok(res.code === 409 && !dispatched(calls), "a run already queued -> 409, no second dispatch");
}
{
  const calls = stubFetch({ runs: [{ status: "completed" }] });
  const res = mockRes();
  await handler(post, res);
  ok(dispatched(calls) && res.code === 202, "a completed run does not block a new one");
}
{
  // Fine-grained tokens expire. This must say so, not return a bare 502.
  stubFetch({ dispatchStatus: 401 });
  const res = mockRes();
  await handler(post, res);
  ok(res.code === 502 && /expired, revoked/.test(res.body.error), "expired token is reported as such");
}
{
  stubFetch({ dispatchStatus: 403 });
  const res = mockRes();
  await handler(post, res);
  ok(res.code === 502 && /Actions: Read and write/.test(res.body.error), "403 names the permission to check");
}

{
  // GitHub's real message must reach the caller -- guessing at the cause of a
  // 403 sent the user checking the wrong setting.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/auth/v1/user")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    if (String(url).includes("/runs?")) return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }), text: async () => "" };
    return { ok: false, status: 403, json: async () => ({}), text: async () => JSON.stringify({ message: "Resource not accessible by personal access token" }) };
  };
  const res = mockRes();
  await handler(post, res);
  ok(/Resource not accessible by personal access token/.test(res.body.error),
    "GitHub's own message is passed through, not swallowed");
  ok(res.body.status === 403, "the upstream status is reported alongside");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
