const CACHE_NAME = 'atoma-viz-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icons/atoma-192.png',
  '/icons/atoma-512.png',
  '/icons/atoma-maskable-512.png',
];

function noStore(response) {
  return response.headers.get('cache-control')?.toLowerCase().includes('no-store') === true;
}

function cacheable(response) {
  return response.ok && !noStore(response);
}

async function precacheShellBestEffort() {
  let cache;
  try {
    cache = await globalThis.caches.open(CACHE_NAME);
  } catch {
    // A security worker must still replace an older cache policy even when
    // Cache Storage is temporarily unavailable.
    return;
  }
  await Promise.all(
    SHELL_ASSETS.map(async (asset) => {
      try {
        const response = await fetch(asset);
        if (cacheable(response)) {
          await cache.put(asset, response);
        } else if (noStore(response)) {
          // A failed earlier installation may have left this cache namespace
          // behind. Do not let that stale entry survive a later no-store read.
          await cache.delete(asset);
        }
      } catch {
        // Offline shell assets are optional. Network-first fetch remains safe,
        // and activation must not be held behind one missing icon or response.
      }
    })
  );
}

async function activateSecurityWorker() {
  try {
    const keys = await globalThis.caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('atoma-viz-') && key !== CACHE_NAME)
        .map(async (key) => {
          try {
            await globalThis.caches.delete(key);
          } catch {
            // A stale cache must never keep the safer worker from activating.
          }
        })
    );
  } catch {
    // Cache enumeration is optional; the fetch boundary below names only v2.
  }
  try {
    await globalThis.clients.claim();
  } catch {
    // Unclaimed clients adopt this worker on their next navigation.
  }
}

async function updateCacheBestEffort(key, response) {
  try {
    const cache = await globalThis.caches.open(CACHE_NAME);
    if (cacheable(response)) {
      await cache.put(key, response.clone());
    } else if (noStore(response)) {
      await cache.delete(key);
    }
  } catch {
    // A cache failure cannot replace a successful network response with an
    // offline fallback or keep a no-store response from reaching the client.
  }
  return response;
}

async function matchCurrentCache(key) {
  try {
    const cache = await globalThis.caches.open(CACHE_NAME);
    return await cache.match(key);
  } catch {
    return undefined;
  }
}

globalThis.addEventListener('install', (event) => {
  event.waitUntil(precacheShellBestEffort().then(() => globalThis.skipWaiting()));
});

globalThis.addEventListener('activate', (event) => {
  event.waitUntil(activateSecurityWorker());
});

globalThis.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (
    url.origin !== globalThis.location.origin ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/auth' ||
    url.pathname.startsWith('/auth/') ||
    url.pathname === '/webhooks' ||
    url.pathname.startsWith('/webhooks/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => updateCacheBestEffort('/', response))
        .catch(async () => (await matchCurrentCache('/')) ?? Response.error())
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => updateCacheBestEffort(request, response))
      .catch(async () => (await matchCurrentCache(request)) ?? Response.error())
  );
});
