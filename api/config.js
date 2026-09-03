// Public runtime config for the PWA.
//
// The anon key is public by design -- it ships in client JavaScript and is
// fenced by RLS, so it is a username, not a password. Serving it from here
// rather than hardcoding it in public/app.js keeps every key out of the repo,
// so rotating one is a dashboard change and not a commit.
//
// Note what is NOT here: SERVICE_ROLE and TAG_TOKEN. If either ever appears in
// this response, the whole security model is gone.

export default function handler(req, res) {
  const url = (process.env.SUPABASE_URL || "")
    .replace(/\/rest\/v1\/?$/, "")
    .replace(/\/$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY || "";

  if (!url || !anonKey) {
    return res.status(500).json({ error: "missing SUPABASE_URL or SUPABASE_ANON_KEY" });
  }

  // Short cache: the PWA reads this once per launch, and a rotated key should
  // take effect within the hour rather than whenever a service worker feels
  // like revalidating.
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).json({ url, anonKey, tz: process.env.PULSE_TZ || "America/Chicago" });
}
