/* =========================================================
   Ciclovia — service worker
   - ciclovia-shell-v1   : cache-first, precache app shell
   - ciclovia-tiles-v1   : stale-while-revalidate, max 200 LRU
   - ciclovia-routes-v1  : cache-first, max 10 LRU
   ========================================================= */

const SHELL_CACHE  = 'ciclovia-shell-v25';
const TILES_CACHE  = 'ciclovia-tiles-v1';
const ROUTES_CACHE = 'ciclovia-routes-v1';

const KNOWN_CACHES = [SHELL_CACHE, TILES_CACHE, ROUTES_CACHE];

const TILES_MAX  = 200;
const ROUTES_MAX = 10;

/* App shell precache list. Path relativi al SW (es. /ciclovia/sw.js → ./ = /ciclovia/).
   Funziona sia in root sia in sottocartella (GitHub Pages project site). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',

  /* core JS */
  './js/app.js',
  './js/state.js',
  './js/map.js',
  './js/ui.js',

  /* services */
  './js/services/brouter.js',
  './js/services/routePlanner.js',
  './js/services/routeHistory.js',
  './js/services/nominatim.js',
  './js/services/geolocation.js',
  './js/services/overpass.js',

  /* lib */
  './js/lib/gpx.js',
  './js/lib/share.js',
  './js/lib/stats.js',
  './js/lib/elevation-chart.js',

  /* vendor */
  './js/vendor/leaflet.js',
  './js/vendor/leaflet.css',
  './js/vendor/chart.umd.js',

  /* icons */
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ---------- helpers ---------- */

/**
 * LRU trim per cache: tiene solo gli ultimi `max` entry inseriti.
 * L'ordine usato è quello di keys() (FIFO di inserimento) e ad ogni put
 * spostiamo la chiave in coda (delete + put) per simulare un LRU.
 */
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  const toDelete = keys.length - max;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}

/** Cache-first: serve da cache, altrimenti rete; in caso di successo memorizza. */
async function cacheFirst(request, cacheName, opts = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    if (opts.touch) {
      // sposta in coda per LRU: rimuovi e re-inserisci
      try {
        await cache.delete(request);
        await cache.put(request, cached.clone());
      } catch (_) { /* noop */ }
    }
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      try {
        await cache.put(request, response.clone());
        if (opts.max) trimCache(cacheName, opts.max);
      } catch (_) { /* opaque o storage piena */ }
    }
    return response;
  } catch (err) {
    // se siamo offline e non in cache, restituisci risposta di fallback
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/** Stale-while-revalidate: ritorna subito la cache (se c'è) e aggiorna in background. */
async function staleWhileRevalidate(request, cacheName, opts = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache
          .put(request, response.clone())
          .then(() => {
            if (opts.max) trimCache(cacheName, opts.max);
          })
          .catch(() => { /* noop */ });
      }
      return response;
    })
    .catch(() => null);

  return cached || network || new Response('', { status: 504, statusText: 'Offline' });
}

/* ---------- install ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Aggiungi uno alla volta per non fallire l'intero install se manca un file.
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { cache: 'reload' });
            const res = await fetch(req);
            if (res && res.ok) await cache.put(url, res);
          } catch (err) {
            // ignora singoli asset mancanti (es. vendor scritti da altro agent)
            console.warn('[SW] precache fail:', url, err && err.message);
          }
        })
      );
      // skipWaiting: nuovo SW prende subito il controllo al primo refresh
      // (senza, l'utente deve ricaricare 2 volte per vedere i nuovi asset).
      self.skipWaiting();
    })()
  );
});

/* ---------- activate: pulizia versioni vecchie ---------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('ciclovia-') && !KNOWN_CACHES.includes(n))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------- fetch routing ---------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 1) Tile OSM — stale-while-revalidate, 200 LRU
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    event.respondWith(
      staleWhileRevalidate(req, TILES_CACHE, { max: TILES_MAX })
    );
    return;
  }

  // 2) BRouter — cache-first, 10 LRU
  if (url.hostname.endsWith('brouter.de') && url.pathname.startsWith('/brouter')) {
    event.respondWith(
      cacheFirst(req, ROUTES_CACHE, { max: ROUTES_MAX, touch: true })
    );
    return;
  }

  // 3) Same-origin app shell — cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(req, { ignoreSearch: false }) ||
                       await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        try {
          const res = await fetch(req);
          // Solo per navigazione: serve index.html offline come fallback
          if (req.mode === 'navigate' && (!res || !res.ok)) {
            const fallback = await cache.match('./index.html');
            if (fallback) return fallback;
          }
          return res;
        } catch (_) {
          if (req.mode === 'navigate') {
            const fallback = await cache.match('./index.html');
            if (fallback) return fallback;
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  // Altri host (es. Nominatim): network-only, no caching.
});

/* ---------- messaggi opzionali dal client ---------- */
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
