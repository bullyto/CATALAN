/* Apéro PWA Service Worker
   - App shell precache
   - Offline navigation fallback
   - Stock snapshot: network-first with timeout + cache fallback
   - GitHub raw images: stale-while-revalidate
   - CDN assets: stale-while-revalidate (opaque allowed)
*/
'use strict';

const VERSION = 'v2026-01-04-sw';

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
  return url.hostname === 'readdy.ai' || url.hostname.endsWith('.readdy.ai');
}

async function cacheFirst(request, cacheName, {maxEntries} = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;

  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) {
    cache.put(request, res.clone()).catch(()=>{});
    if (maxEntries) trimCache(cacheName, maxEntries);
  }
  return res;
}

async function staleWhileRevalidate(request, cacheName, {maxEntries} = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });

  const networkPromise = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(()=>{});
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return res;
  }).catch(()=>null);

  if (cached) {
    networkPromise.catch(()=>{});
    return cached;
  }

  const net = await networkPromise;
  if (net) return net;

  const cachedLoose = await cache.match(request, { ignoreSearch: true });
  if (cachedLoose) return cachedLoose;

  throw new Error('No response');
}

async function networkFirst(request, cacheName, {timeoutMs = 2500, maxEntries} = {}) {
  const cache = await caches.open(cacheName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(()=>{});
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return res;
  } catch (e) {
    clearTimeout(timer);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}

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
      if (k.startsWith('ac-') && !k.includes(VERSION)) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigation: network-first, offline fallback to cached index.html
  if (isNavigationRequest(req) && sameOrigin(url)) {
    event.respondWith((async () => {
      try {
        return await networkFirst(req, CACHE_PAGES, { timeoutMs: 3500, maxEntries: 20 });
      } catch (e) {
        const cache = await caches.open(CACHE_APP_SHELL);
        const fallback = await cache.match('./index.html') || await cache.match('./');
        return fallback || new Response('Offline', { status: 503, headers: {'Content-Type':'text/plain'} });
      }
    })());
    return;
  }

  // Same-origin assets: stale-while-revalidate for speed
  if (sameOrigin(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_APP_SHELL, { maxEntries: 80 }));
    return;
  }

  // Stock snapshot: network-first with short timeout
  if (isStockSnapshot(url)) {
    event.respondWith(networkFirst(req, CACHE_API, { timeoutMs: 2000, maxEntries: 10 }));
    return;
  }

  // Product images: stale-while-revalidate
  if (isGitHubRawImage(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_IMG, { maxEntries: 150 }));
    return;
  }

  // Background images (readdy): cache-first
  if (isBackgroundImageHost(url)) {
    event.respondWith(cacheFirst(req, CACHE_IMG, { maxEntries: 40 }));
    return;
  }

  // CDNs: stale-while-revalidate
  if (isCDN(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_CDN, { maxEntries: 80 }));
    return;
  }

  // Default
  event.respondWith((async () => {
    try {
      return await cacheFirst(req, CACHE_CDN, { maxEntries: 120 });
    } catch (e) {
      return fetch(req);
    }
  })());
});
