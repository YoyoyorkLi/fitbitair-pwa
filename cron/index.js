// Every cron tick: ask /api/sync to dispatch the GitHub sync workflow.
// 202 = dispatched, 409 = a sync is already running -- both fine. Anything
// else throws, so it shows as a failed invocation in the Workers dashboard.
export default {
  async scheduled(_event, env) {
    if (!env.SYNC_KEY) throw new Error("SYNC_KEY secret is not set");
    const res = await fetch(env.SYNC_URL, { method: "POST", headers: { "x-sync-key": env.SYNC_KEY } });
    if (res.status === 202 || res.status === 409) return;
    throw new Error(`sync ${res.status}: ${(await res.text()).slice(0, 300)}`);
  },
};
