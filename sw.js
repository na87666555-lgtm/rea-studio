// Service worker: makes the app installable and lets it open offline.
// Only this app's own files are cached; API requests to providers are never
// touched or stored.

// The offline copy is refreshed on every successful request, so this name
// does NOT change with app releases; change it only when this file's logic
// changes. A new service worker waits until the app is closed before taking
// over (no skipWaiting/claim), so it never swaps in during a page load.
const CACHE = 'rea-studio-sw3';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/providers.js',
  './js/markdown.js',
  './js/queue.js',
  './js/tools.js',
  './js/run-worker.js',
  './js/py-worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  // Network first, revalidating with the server every time (cheap 304s), so a
  // new version is picked up as soon as it is published; cache is the
  // offline fallback. version.json is never cached.
  if (new URL(req.url).pathname.endsWith('/version.json')) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
