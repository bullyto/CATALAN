/* Apéro PWA Service Worker (SEO-safe + perf)
   - App shell precache
   - Offline navigation fallback (offline.html si présent, sinon index)
   - Stock snapshot: network-first with timeout + cache fallback
   - GitHub raw images: stale-while-revalidate (opaque allowed)
   - CDN assets: stale-while-revalidate (opaque allowed)
   - Cache trim to avoid bloat
   - Navigation Preload enabled (when supported)
*/
'use strict';

const VERSION = 'v2026-01-22-sw';

const CACHE_APP_SHELL = `ac-app-${VERSION}`;
const CACHE_PAGES     = `ac-pages-${VERSION}`;
const CACHE_IMG       = `ac-img-${VERSION}`;
const CACHE_API       = `ac-api-${VERSION}`;
const CACHE_CDN       = `ac-cdn-${VERSION}`;

const MAX_PAGES = 40;
const MAX_IMG   = 180;
const MAX_API   = 40;
const MAX_CDN   = 60;

// IMPORTANT:
// - Ne surcharge pas l'app-shell (évite de precacher trop lourd inutilement).
// - Les pages essentielles ok.
// - Les screenshots: garde si tu en as besoin pour install prompt / PWA builder,
//   sinon tu peux les retirer pour réduire le precache.
const APP_SHELL_URLS = [
  './',
  './index.html',
  './livraison_alcool_66.html',
  './privacy.html',
  './offline.html',
  './manifest.webmanifest',
  './favicon.png',
  './favicon-96.png',
  './favicon.ico',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/shortcut-call-96.png',
  './icons/shortcut-catalogue-96.png',
  './icons/shortcut-install-96.png',
  './screenshots/narrow-1080x1920.png',
  './screenshots/wide-1920x1080.png',
];

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const extra = keys.length - maxEntries;
    if (extra > 0) {
      for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
    }
  } catch (e) {}
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' &&
     (request.headers.get('accept') || '').includes('text/html'));
}

function sameOrigin(url) { return url.origin === self.location.origin; }

function isGitHubRawImage(url) {
  return url.hostname === 'raw.githubusercontent.com'
    && url.pathname.includes('/bullyto/stock/main/img/')
    && (url.pathname.endsWith('.png') || url.pathname.endsWith('.webp') || url.pathname.endsWith('.jpg') || url.pathname.endsWith('.jpeg'));
}

function isStockSnapshot(url) {
  return url.hostname === 'raw.githubusercontent.com'
    && url.pathname.includes('/bullyto/stock/main/stock/_snapshot.json');
}

function isCdnAsset(url) {
  return (url.hostname.includes('cdnjs') ||
          url.hostname.includes('jsdelivr') ||
          url.hostname.includes('unpkg') ||
          url.hostname.includes('fonts.googleapis.com') ||
          url.hostname.includes('fonts.gstatic.com') ||
          url.hostname.includes('cdn.jsdelivr.net'));
}

// Livraison d'alcool la nuit à perpignan
function isRobotsOrSitemap(url) {
  if (!sameOrigin(url)) return false;
  return (
    url.pathname === '/robots.txt' ||
    url.pathname === '/sitemap.xml' ||
    url.pathname.endsWith('.xml')
  );
}

async function cacheFirst(request, cacheName, allowOpaque = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const res = await fetch(request);
  if (res && (res.ok || (allowOpaque && res.type === 'opaque'))) {
    cache.put(request, res.clone());
  }
  return res;
}

async function staleWhileRevalidate(request, cacheName, allowOpaque = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(res => {
    if (res && (res.ok || (allowOpaque && res.type === 'opaque'))) {
      cache.put(request, res.clone());
    }
    return res;
  }).catch(() => null);

  return cached || (await fetchPromise) || cached;
}

async function networkFirst(request, cacheName, timeoutMs = 4500) {
  const cache = await caches.open(cacheName);
  let timer;

  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);

    // Navigation Preload: si dispo, on l’utilise
    // (ne s’applique réellement que sur navigations, mais safe partout)
    const preloadResponse = request.mode === 'navigate' && self.registration.navigationPreload
      ? await eventPreloadMaybe()
      : null;

    if (preloadResponse) {
      clearTimeout(timer);
      if (preloadResponse.ok) cache.put(request, preloadResponse.clone());
      return preloadResponse;
    }

    const res = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);

    // On ne cache que les 200 OK (évite de “mémoriser” des 404)
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    clearTimeout(timer);
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

// Petite astuce: navigationPreload response récupérable via event.preloadResponse,
// mais on ne l’a pas hors scope. On utilise une variable temporaire.
let __currentEvent = null;
async function eventPreloadMaybe() {
  try {
    if (!__currentEvent) return null;
    const pr = await __currentEvent.preloadResponse;
    return pr || null;
  } catch (e) {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP_SHELL);
    await cache.addAll(APP_SHELL_URLS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Enable navigation preload (perf)
    try {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
    } catch (e) {}

    // Cleanup old caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('ac-') && !k.includes(VERSION)) return caches.delete(k);
      return null;
    }));

    // Trim current caches
    await trimCache(CACHE_PAGES, MAX_PAGES);
    await trimCache(CACHE_IMG, MAX_IMG);
    await trimCache(CACHE_API, MAX_API);
    await trimCache(CACHE_CDN, MAX_CDN);

    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  __currentEvent = event;

  const request = event.request;
  const url = new URL(request.url);

  // ignore non-GET
  if (request.method !== 'GET') return;

  // robots / sitemap : network-first court (SEO-safe) + fallback cache
  if (isRobotsOrSitemap(url)) {
    event.respondWith((async () => {
      try {
        const res = await networkFirst(request, CACHE_PAGES, 2500);
        return res;
      } catch (e) {
        const cache = await caches.open(CACHE_PAGES);
        const cached = await cache.match(request);
        return cached || fetch(request);
      }
    })());
    return;
  }

  // stock snapshot (json) : network-first + fallback cache
  if (isStockSnapshot(url)) {
    event.respondWith((async () => {
      try {
        const res = await networkFirst(request, CACHE_API, 4500);
        // trim après usage
        trimCache(CACHE_API, MAX_API);
        return res;
      } catch (e) {
        const cache = await caches.open(CACHE_API);
        const cached = await cache.match(request);
        return cached || new Response('{"ok":false,"error":"offline"}', {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // GitHub raw images: SWR
  if (isGitHubRawImage(url)) {
    event.respondWith((async () => {
      const res = await staleWhileRevalidate(request, CACHE_IMG, true);
      trimCache(CACHE_IMG, MAX_IMG);
      return res;
    })());
    return;
  }

  // CDN assets: SWR (opaque allowed)
  if (isCdnAsset(url)) {
    event.respondWith((async () => {
      const res = await staleWhileRevalidate(request, CACHE_CDN, true);
      trimCache(CACHE_CDN, MAX_CDN);
      return res;
    })());
    return;
  }

  // Same-origin navigations: network-first with offline fallback
  if (sameOrigin(url) && isNavigationRequest(request)) {
    event.respondWith((async () => {
      try {
        const res = await networkFirst(request, CACHE_PAGES, 4500);
        trimCache(CACHE_PAGES, MAX_PAGES);
        return res;
      } catch (e) {
        // Offline fallback: préfère offline.html si présent
        const cache = await caches.open(CACHE_APP_SHELL);
        const offlinePage = (await cache.match('./offline.html')) || (await cache.match('./index.html'));
        return offlinePage || new Response('Offline', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Same-origin static files: cache-first (app-shell)
  if (sameOrigin(url)) {
    event.respondWith(cacheFirst(request, CACHE_APP_SHELL));
    return;
  }

  // default: try network then cache
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
