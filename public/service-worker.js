// PWA service worker for installability and a small offline shell fallback.
// It intentionally keeps live API, export, and Turso-backed data requests network-only.
const CACHE_NAME = "production-planning-pwa-v6";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js?v=20260706-formula-save-all",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

function isLiveDataRequest(url) {
  return url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/exports/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin || isLiveDataRequest(url)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
