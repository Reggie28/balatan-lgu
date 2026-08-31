/* Service worker for the Balatan LGU PWA.
   Caches the app shell + vendored libraries for offline / fast loading.
   API calls (/api/*, /uploads/*) always go to the network. */
const CACHE = "balatan-lgu-v25";
const SHELL = [
  "/",
  "/portal",
  "/landing.html",
  "/index.html",
  "/login.html",
  "/css/styles.css",
  "/js/common.js",
  "/js/app.js",
  "/js/auth.js",
  "/js/landing.js",
  "/manifest.webmanifest",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet-heat.js",
  "/vendor/chart.umd.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/Balatan-Logo.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API or uploaded media — always fresh.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) {
    return; // default network handling
  }
  // Cache-first for the app shell / static assets.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return (
        cached ||
        fetch(e.request)
          .then((resp) => {
            if (resp.ok && e.request.method === "GET") {
              const copy = resp.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return resp;
          })
          .catch(() => cached)
      );
    })
  );
});
