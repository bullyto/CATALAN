/* Apéro PWA Service Worker
   Goals:
   - Fast load (app shell precache)
   - Offline-friendly navigation (index.html fallback)
   - Reliable stock freshness: network-first for snapshot with timeout + cache fallback
   - Fast product images: stale-while-revalidate for GitHub raw images
   - Cache external CDNs (Tailwind, fonts) safely as runtime
*/
'use strict';

const VERSION = 'v2026-01-03-sw1';

const CACHE_APP_SHELL = `ac-app-${VERSION}`;
const CACHE_PAGES     = `ac-pages-${VERSION}`;
const CACHE_IMG       = `ac-img-${VERSION}`;
const CACHE_API       = `ac-api-${VERSION}`;
const CACHE_CDN       = `ac-cdn-${VERSION}`;

const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest?v=20251223',
  './favicon.ico?v=20251223',
  './icon-32.png?v=20251223',
  './icon-192.png?v=20251223',
  './icon-512.png?v=20251223',
  './apple-touch-icon.png?v=20251223'
];

// --- helpers ---
async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const extra = keys.length - maxEntries;
    if (extra > 0) {
      // Delete oldest entries first
      for (let i = 0; i < extra; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (e) {}
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
         (request.method === 'GET' && request.headers.get('accept') && request.headers.get('accept').includes('text/html'));
}

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isGitHubRawImage(url) {
  return url.hostname === 'raw.githubusercontent.com'
    && url.pathname.includes('/bullyto/stock/main/img/')
    && (url.pathname.endsWith('.png') || url.pathname.endsWith('.webp') || url.pathname.endsWith('.jpg') || url.pathname.endsWith('.jpeg'));
}

function isStockSnapshot(url) {
  return url.hostname === 'raw.githubusercontent.com'
    && url.pathname.includes('/bullyto/stock/main/stock/_snapshot.json');
}

function isCDN(url) {
  return [
    'cdn.tailwindcss.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdn.jsdelivr.net',
    'unpkg.com'
  ].includes(url.hostname);
}

function isBackgroundImageHost(url) {
  // Your current background uses readdy.ai; cache it but keep bounded
  return url.hostname === 'readdy.ai' || url.hostname.endsWith('.readdy.ai');
}

async function cacheFirst(request, cacheName, {maxEntries} = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;

  const response = await fetch(request);
  // Cache only successful or opaque (CDN cross-origin) GET responses
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone()).catch(()=>{});
    if (maxEntries) trimCache(cacheName, maxEntries);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName, {maxEntries} = {}) {
  const cache = await caches.open(cacheName);
  const cachedPromise = cache.match(request, { ignoreSearch: false });
  const networkPromise = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(()=>{});
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return res;
  }).catch(()=>null);

  const cached = await cachedPromise;
  if (cached) {
    // Update in background
    networkPromise.catch(()=>{});
    return cached;
  }
  const net = await networkPromise;
  if (net) return net;
  // Last resort: try matching ignoring search
  const cachedLoose = await cache.match(request, { ignoreSearch: true });
  if (cachedLoose) return cachedLoose;
  throw new Error('No response');
}

async function networkFirst(request, cacheName, {timeoutMs = 2500, maxEntries} = {}) {
  const cache = await caches.open(cacheName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(()=>{});
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return response;
  } catch (e) {
    clearTimeout(timer);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}

// --- lifecycle ---
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP_SHELL);
    await cache.addAll(APP_SHELL_URLS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (!k.includes(VERSION) && (k.startsWith('ac-'))) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

// Allow page to force activate new SW
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// --- fetch routing ---
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigations: try network, fallback to cached index.html for offline
  if (isNavigationRequest(req) && sameOrigin(url)) {
    event.respondWith((async () => {
      try {
        const res = await networkFirst(req, CACHE_PAGES, { timeoutMs: 3500, maxEntries: 20 });
        return res;
      } catch (e) {
        const cache = await caches.open(CACHE_APP_SHELL);
        const fallback = await cache.match('./index.html') || await cache.match('./');
        return fallback || new Response('Offline', { status: 503, headers: {'Content-Type':'text/plain'} });
      }
    })());
    return;
  }

  // App shell assets (same origin): stale-while-revalidate keeps it snappy
  if (sameOrigin(url)) {
    // Cache-busted assets still cache fine (we don't ignoreSearch)
    event.respondWith(staleWhileRevalidate(req, CACHE_APP_SHELL, { maxEntries: 80 }));
    return;
  }

  // Stock snapshot: network-first (fresh) with quick timeout, fallback cache
  if (isStockSnapshot(url)) {
    event.respondWith(networkFirst(req, CACHE_API, { timeoutMs: 2000, maxEntries: 10 }));
    return;
  }

  // Product images (GitHub raw): stale-while-revalidate for speed + freshness
  if (isGitHubRawImage(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_IMG, { maxEntries: 120 }));
    return;
  }

  // Background images (readdy.ai etc.): cache-first to reduce repeated downloads
  if (isBackgroundImageHost(url)) {
    event.respondWith(cacheFirst(req, CACHE_IMG, { maxEntries: 30 }));
    return;
  }

  // CDNs: stale-while-revalidate (opaque responses allowed)
  if (isCDN(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_CDN, { maxEntries: 60 }));
    return;
  }

  // Default: try cache-first (safe), fallback network
  event.respondWith((async () => {
    try {
      return await cacheFirst(req, CACHE_CDN, { maxEntries: 80 });
    } catch (e) {
      return fetch(req);
    }
  })());
});
