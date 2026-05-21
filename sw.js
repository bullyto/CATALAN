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


/* ================================
   🔔 WEB PUSH ADN66 — APÉRO CATALAN
   Cible : target=catalan
   ================================ */

const ADN_PUSH_WORKER_URL = "https://adn66-push.apero-nuit-du-66.workers.dev";
const ADN_PUSH_LATEST_URL = `${ADN_PUSH_WORKER_URL}/push/latest?target=catalan`;

const DEFAULT_SITE_URL = "https://catalan.aperos.net/";
const DEFAULT_ICON_URL = "https://bullyto.github.io/outil/apps/PUSH/icons/icon-catalan-192.png";
const DEFAULT_BADGE_URL = "https://bullyto.github.io/outil/apps/PUSH/icons/badge-catalan-96.png";

self.addEventListener("push", (event) => {
  event.waitUntil(showCatalanPushNotification());
});

async function showCatalanPushNotification() {
  const payload = await getLatestCatalanNotificationPayload();

  const title = cleanPushText(payload.title) || "Apéro Catalan";
  const body = cleanPushText(payload.body) || "Livraison disponible ce soir de 19h à 6h.";

  const siteUrl = cleanPushSiteUrl(payload.site_url || payload.url) || DEFAULT_SITE_URL;
  const iconUrl = cleanPushHttpsUrl(payload.icon_url) || DEFAULT_ICON_URL;
  const badgeUrl = cleanPushHttpsUrl(payload.badge_url) || DEFAULT_BADGE_URL;
  const imageUrl = cleanPushLargeImageUrl(payload.image_url || payload.image || payload.imageUrl || "");

  const options = {
    body,
    icon: iconUrl,
    badge: badgeUrl,
    data: {
      url: siteUrl,
      site_url: siteUrl
    },
    tag: cleanPushTag(payload.tag) || "adn66-catalan-alerte",
    renotify: toPushBoolean(payload.renotify, true),
    requireInteraction: toPushBoolean(payload.require_interaction, true),
    silent: toPushBoolean(payload.silent, false),
    vibrate: cleanPushVibrate(payload.vibrate),
    // Version volontairement sûre : tous les boutons ouvrent le site Catalan.
    actions: [
      { action: "open_site", title: "Voir le site" },
      { action: "open_site_2", title: "Ouvrir" }
    ]
  };

  if (imageUrl) {
    options.image = imageUrl;
  }

  return self.registration.showNotification(title, options);
}

async function getLatestCatalanNotificationPayload() {
  try {
    const response = await fetch(ADN_PUSH_LATEST_URL, { cache: "no-store" });

    if (!response.ok) {
      return getFallbackCatalanNotificationPayload();
    }

    const data = await response.json();

    if (data && data.notification) {
      return {
        ...getFallbackCatalanNotificationPayload(),
        ...data.notification
      };
    }
  } catch (error) {
    // Fallback silencieux.
  }

  return getFallbackCatalanNotificationPayload();
}

function getFallbackCatalanNotificationPayload() {
  return {
    title: "Apéro Catalan",
    body: "Livraison disponible ce soir de 19h à 6h.",
    url: DEFAULT_SITE_URL,
    site_url: DEFAULT_SITE_URL,
    icon_url: DEFAULT_ICON_URL,
    badge_url: DEFAULT_BADGE_URL,
    image_url: "",
    tag: "adn66-catalan-alerte",
    renotify: true,
    require_interaction: true,
    silent: false,
    vibrate: [500, 150, 500, 150, 800]
  };
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = cleanPushSiteUrl(data.site_url || data.url) || DEFAULT_SITE_URL;

  // Tous les clics de notification Apéro Catalan ouvrent le site Catalan.
  event.waitUntil(openOrFocusCatalanSite(targetUrl));
});

async function openOrFocusCatalanSite(url) {
  const finalUrl = cleanPushSiteUrl(url) || DEFAULT_SITE_URL;

  const clientList = await clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  for (const client of clientList) {
    try {
      const clientUrl = new URL(client.url);

      if (clientUrl.hostname === "catalan.aperos.net") {
        if ("navigate" in client) {
          await client.navigate(finalUrl);
        }
        if ("focus" in client) {
          return client.focus();
        }
      }
    } catch {
      // ignore
    }
  }

  if (clients.openWindow) {
    return clients.openWindow(finalUrl);
  }

  return undefined;
}

function cleanPushText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanPushTag(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
}

function cleanPushHttpsUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw, self.location.href);

    if (url.protocol !== "https:") {
      return "";
    }

    return url.toString();
  } catch {
    return "";
  }
}

function cleanPushSiteUrl(value) {
  const url = cleanPushHttpsUrl(value);

  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);

    // Sécurité : ce service worker Catalan ne doit jamais ouvrir Google Play.
    if (parsed.hostname.includes("play.google.com")) {
      return DEFAULT_SITE_URL;
    }

    return parsed.toString();
  } catch {
    return "";
  }
}

function cleanPushLargeImageUrl(value) {
  const imageUrl = cleanPushHttpsUrl(value);

  if (!imageUrl) {
    return "";
  }

  const normalized = imageUrl.toLowerCase();

  // Ne pas afficher une icône ou un badge comme grande image.
  if (
    normalized.includes("/apps/push/icons/icon-") ||
    normalized.includes("/apps/push/icons/badge-") ||
    normalized.includes("apple-touch-icon") ||
    normalized.includes("favicon")
  ) {
    return "";
  }

  return imageUrl;
}

function toPushBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return Boolean(fallback);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "yes", "oui"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "non"].includes(normalized)) {
      return false;
    }
  }

  return Boolean(fallback);
}

function cleanPushVibrate(value) {
  const fallback = [500, 150, 500, 150, 800];

  if (!Array.isArray(value)) {
    return fallback;
  }

  const cleaned = value
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v >= 0 && v <= 2000)
    .slice(0, 10);

  return cleaned.length ? cleaned : fallback;
}

