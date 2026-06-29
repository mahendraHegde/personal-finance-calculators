// Minimal, conservative service worker: enables install/offline without risking
// stale app code. Navigations are network-first (so new deploys win); other
// same-origin GETs are stale-while-revalidate. Non-GET and cross-origin (Google
// APIs, FX endpoint) always go straight to the network.

const CACHE = "pf-shell-v1";

// Precache the app shell on install: fetch index.html and the hashed JS/CSS it
// references, so the app can start offline even if the user goes offline (or
// installs the PWA) before a second reload. We parse the shell HTML because the
// asset filenames are content-hashed and unknown to this static worker.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const res = await fetch("./", { cache: "no-cache" });
        await cache.put("./", res.clone());
        const html = await res.text();
        const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
        await cache.addAll(urls);
      } catch {
        /* offline or shell fetch failed — fetch handler still caches at runtime */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./"))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
