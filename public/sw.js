// Shadow Bomber Service Worker
// Network-first for everything: the client must always match the server
// protocol, so cached files are only a fallback for offline/flaky moments.
const CACHE = 'shadow-bomber-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/game.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
