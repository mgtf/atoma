const CACHE_NAME = 'atoma-viz-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icons/atoma-192.png',
  '/icons/atoma-512.png',
  '/icons/atoma-maskable-512.png',
];

globalThis.addEventListener('install', (event) => {
  event.waitUntil(
    globalThis.caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => globalThis.skipWaiting())
  );
});

globalThis.addEventListener('activate', (event) => {
  event.waitUntil(
    globalThis.caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('atoma-viz-') && key !== CACHE_NAME)
            .map((key) => globalThis.caches.delete(key))
        )
      )
      .then(() => globalThis.clients.claim())
  );
});

globalThis.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== globalThis.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await globalThis.caches.open(CACHE_NAME);
            await cache.put('/', response.clone());
          }
          return response;
        })
        .catch(async () => (await globalThis.caches.match('/')) ?? Response.error())
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await globalThis.caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      })
      .catch(async () => (await globalThis.caches.match(request)) ?? Response.error())
  );
});
