/* ===== sw.js : AUTO UPDATE + HTML NETWORK-FIRST + ASSETS CACHE-FIRST ===== */

const CACHE_VERSION = "catalan-v2"; // incrémente si besoin (v2, v3...)
const CACHE_NAME = `pwa-${CACHE_VERSION}`;

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

// ✅ reçoit l'ordre de passer direct en actif
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ✅ install : precache
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // cache "reload" = évite certains caches CDN/navigateurs
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })));

    self.skipWaiting();
  })());
});

// ✅ activate : nettoyage + claim
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    await self.clients.claim();
  })());
});

// Helpers
function isHTMLRequest(req) {
  const url = new URL(req.url);
  const accept = req.headers.get("accept") || "";
  return (
    confirmingNavigate(req) ||
    accept.includes("text/html") ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/")
  );
}

function confirmingNavigate(req) {
  return req.mode === "navigate";
}

// ✅ fetch : HTML network-first, assets cache-first
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // hors scope => laisser passer
  if (url.origin !== self.location.origin) return;

  // 1) HTML = NETWORK FIRST (toujours à jour)
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match("./index.html");
      }
    })());
    return;
  }

  // 2) Assets = CACHE FIRST
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
