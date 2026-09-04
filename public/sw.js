// Service worker: shell caching only.
//
// Deliberately conservative. This app's whole value is showing you a number
// that is true right now -- a cached HRV reading from yesterday morning is
// worse than a spinner. So the shell is cached for offline launch, and every
// piece of data goes to the network.

// Bumped to v2: activate deletes every cache whose name is not SHELL, so
// renaming it is what actually evicts a stale shell. The fetch handler is
// network-first, so this should never have mattered -- but "should never" has
// been wrong three times on this bug, and the eviction is free.
const SHELL = "pulse-shell-v2";
const FILES = ["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never touch the API or Supabase. /api/tap must reach the network or a tap
  // is silently lost, and a cached session token is a bug with teeth.
  if (url.pathname.startsWith("/api/") || url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  // Network-first so a deploy takes effect on next launch rather than whenever
  // the cache happens to expire; cache is the offline fallback only.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
