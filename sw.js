/* Haze Tracker service worker: offline app shell, background alert checks, notification clicks. */
importScripts('haze.js');

const CACHE = 'haze-tracker-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'haze.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/badge-96.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs: serve from cache, refresh the cache in the background.
// The NEA API is cross-origin and is deliberately not cached here.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    })
  );
});

// Chrome on Android: periodic background sync for installed apps.
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'haze-check') event.waitUntil(Haze.checkAndNotify().catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
