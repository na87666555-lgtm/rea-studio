// Service worker: makes the app installable and lets it open offline.
// Only this app's own files are cached; API requests to providers are never
// touched or stored.

// The offline copy is refreshed on every successful request, so this name
// does NOT change with app releases; change it only when this file's logic
// changes. A new service worker waits until the app is closed before taking
// over (no skipWaiting/claim), so it never swaps in during a page load.
const CACHE = 'rea-studio-sw15';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './css/animation.css',
  './css/call.css',
  './call.html',
  './js/call.js',
  './js/animation.js',
  './js/vendor/three.module.min.js',
  './js/research.js',
  './js/direct-python.js',
  './js/blender.js',
  './media/blender-example.py',
  './js/app.js',
  './js/app.js?ui=8',
  './js/team.js?ui=2',
  './css/app.css?ui=5',
  './js/store.js',
  './js/providers.js',
  './js/markdown.js',
  './js/queue.js',
  './js/team.js',
  './js/project.js',
  './js/official-bridge.js',
  './project-preview.html',
  './js/project-preview.js',
  './js/tools.js',
  './js/files.js',
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
      .then(keys => Promise.all(keys.filter(k => /^rea-studio-sw\d+$/.test(k) && k !== CACHE).map(k => caches.delete(k)))),
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
    fetch(req, { cache: req.cache === 'reload' ? 'reload' : 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
