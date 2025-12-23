/* sw.js — L'apéro catalan
   Objectif :
   - Pré-cache des fichiers essentiels (offline)
   - Mise à jour propre : SKIP_WAITING + reload auto
   - HTML en Network First (pour chopper les modifs vite)
*/

const VERSION = "v2.5"; // ⬅️ incrémente à chaque grosse modif (v8, v9, etc.)
const CACHE_NAME = `catalan-${VERSION}`;

// ✅ Mets ici EXACTEMENT les fichiers qui existent dans ton repo
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",

  // Icônes / favicons (Android + iPhone)
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

// -------- INSTALL: pré-cache + skip waiting --------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// -------- ACTIVATE: purge anciens caches + claim --------
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))
    );
    await self.clients.claim();
  })());
});

// -------- MESSAGE: SKIP_WAITING depuis la page --------
self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// -------- FETCH STRATEGY --------
// - Navigations (HTML) : Network First (pour être à jour)
// - Autres assets (png, css, js) : Cache First (rapide) + mise en cache
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // ✅ Toujours Network First pour les pages HTML (navigations)
  const isNavigation = req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // ✅ Pour le reste (icônes, images, css, js) : cache first (si même origin)
  if (isSameOrigin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // sinon laisse passer
});

// ---------- Helpers ----------
async function networkFirstHTML(req) {
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    const cache = await caches.open(CACHE_NAME);

    // on met en cache uniquement si OK + same-origin (souvent basic)
    if (fresh && fresh.status === 200) {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    // fallback cache
    const cached = await caches.match(req);
    return cached || caches.match("./index.html");
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const fresh = await fetch(req);
    // Cache uniquement réponses ok et même origin
    const url = new URL(req.url);
    if (fresh && fresh.status === 200 && fresh.type === "basic" && url.origin === self.location.origin) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    // fallback icône si jamais
    return caches.match("./icon-192.png");
  }
}
