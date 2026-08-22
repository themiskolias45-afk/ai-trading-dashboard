/* SmartEntry Pro service worker.
 *
 * THE ONE RULE THAT MATTERS HERE: /api/ IS NEVER CACHED, EVER.
 *
 * A service worker's whole trick is serving something it already has. On a trading
 * dashboard that is a hazard, not a feature: a cached /api/signals shows a setup that
 * expired, a cached /api/risk-status shows "not halted" after the breaker tripped, and a
 * cached /api/journal hides a fill. The page would look alive and be lying, which is
 * strictly worse than a page that plainly fails to load. So every request whose path
 * contains /api/ goes to the network and is NEVER written to the cache — offline, those
 * requests fail, and the page's own error handling shows it.
 *
 * What IS cached is the shell: the HTML, the stylesheet and the icons. That is what makes
 * the installed app open instantly instead of showing a white screen while the network
 * wakes up. The shell is served network-first so a deploy is picked up on the next launch,
 * falling back to cache only when the network genuinely fails.
 */

// Bump this when the shell changes. Old caches under the same prefix are removed on
// activate; nothing outside this prefix is ever touched.
const CACHE = "smartentry-shell-v1";
const SHELL = [
  "./index.html",
  "./theme.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", event => {
  // A missing shell entry must not abort the whole install, or one renamed file leaves
  // the app uninstallable with no obvious cause.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(name => name.startsWith("smartentry-shell-") && name !== CACHE)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  // Only GET is ever considered. A POST is an action - queueing a manual trade, writing
  // settings - and replaying one from a worker is the kind of "helpful" behaviour that
  // places a trade nobody asked for.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only. A cross-origin request is somebody else's business.
  if (url.origin !== self.location.origin) return;

  // THE RULE. Live data goes to the network or it fails honestly.
  if (url.pathname.includes("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Shell: network first, cache as a fallback, and refresh the cached copy on success so
  // the next cold start opens on the current build.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || Response.error()))
  );
});
