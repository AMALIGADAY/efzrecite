/* Bump this value for every published release to install a complete new snapshot. */
const VERSION = 'efzrecite-ab714c07c22182da9869';
const CACHE_PREFIX = `efz-offline-${encodeURIComponent(new URL(self.registration.scope).pathname)}-`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const ASSETS = [
  './index.html', './styles.css', './app.js', './core.js', './session.js', './storage.js',
  './data/catalog.json', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
].map(relative => new URL(relative, self.registration.scope).href);
const INDEX_URL = new URL('./index.html', self.registration.scope).href;
const ASSET_SET = new Set(ASSETS);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const existed = await caches.has(CACHE_NAME);
    const cache = await caches.open(CACHE_NAME);
    try {
      // addAll commits only if the entire list was fetched successfully.
      await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
    } catch (error) {
      if (!existed) await caches.delete(CACHE_NAME);
      throw error;
    }
    // Do not skipWaiting: an in-progress round keeps its current app version.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const withoutQuery = new URL(url.pathname, url.origin).href;
  if (ASSET_SET.has(withoutQuery) || request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = request.mode === 'navigate' ? INDEX_URL : withoutQuery;
      const response = await cache.match(key);
      if (response) return response;
      return fetch(request);
    })());
  }
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_OFFLINE' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    let ready = false;
    try {
      const cache = await caches.open(CACHE_NAME);
      let responses = await Promise.all(ASSETS.map(url => cache.match(url)));
      if (responses.some(response => !response || !response.ok)) {
        // A browser may evict caches while retaining the worker. Repair the whole
        // snapshot atomically when online; a failed repair never means "ready".
        await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
        responses = await Promise.all(ASSETS.map(url => cache.match(url)));
      }
      ready = responses.every(response => response && response.ok);
    } catch { /* Storage denial must not be reported as ready. */ }
    event.ports[0].postMessage({ ready, version: VERSION });
  })());
});
