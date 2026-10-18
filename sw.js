// Radar Eden – service worker: fast open + works offline with the last loaded data
const CACHE = 'radar-eden-v5';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// network first (always fresh when online), fall back to cache when offline
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const key = req.url.split('?')[0];
  e.respondWith(
    fetch(req, { cache: 'no-store' }).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); return res; })
      .catch(() => caches.match(key).then((r) => r || caches.match('./index.html')))
  );
});
