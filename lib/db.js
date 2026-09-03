// Server-side Supabase client, service_role.
//
// service_role bypasses RLS entirely. It exists only inside serverless
// functions and must never reach the browser -- if it does, every policy in
// sql/schema.sql becomes decoration. The frontend uses the anon key, handed
// out by api/config.js, and is fenced by RLS.

import { createClient } from "@supabase/supabase-js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} -- see .env.example`);
  return v;
}

let client;

export function db() {
  if (client) return client;

  // Accept a pasted REST URL and trim it back to the project origin.
  // The dashboard shows ".../rest/v1/", supabase-js wants the bare host, and
  // the mismatch fails as a confusing 404 rather than a clear error.
  const url = required("SUPABASE_URL").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

  client = createClient(url, required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
