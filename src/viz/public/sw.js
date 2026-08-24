const CACHE_NAME = 'atoma-viz-shell-v3';
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
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

globalThis.addEventListener('push', (event) => {
  // Payloads come from the Atoma server but cross a third-party push service;
  // treat every field as untrusted data with a safe default.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' && payload.title ? payload.title : 'Atoma';
  const url =
    typeof payload.url === 'string' && payload.url.startsWith('/') && !payload.url.startsWith('//')
      ? payload.url
      : '/';
  event.waitUntil(
    globalThis.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : 'atoma-run',
      icon: '/icons/atoma-192.png',
      badge: '/icons/atoma-192.png',
      data: { url },
    })
  );
});

globalThis.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = data && typeof data.url === 'string' ? data.url : '/';
  event.waitUntil(
    (async () => {
      const windows = await globalThis.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (typeof client.focus === 'function') {
          await client.focus();
          return;
        }
      }
      await globalThis.clients.openWindow(url);
    })()
  );
});

/**
 * Vite's dev module graph, which only exists when the worker was opted into a
 * dev session (`ATOMA_VIZ_SW_DEV=1`). These URLs are rewritten on every edit,
 * so caching them would let an offline fallback serve a module from a previous
 * edit — a stale-code bug that looks like anything but a cache. A production
 * build emits none of these paths, so this costs prod nothing, and bypassing
 * the worker only means an ordinary network fetch.
 */
function isDevModuleGraph(url) {
  return (
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/') ||
    url.searchParams.has('t') ||
    url.searchParams.has('import')
  );
}

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
    url.pathname.startsWith('/webhooks/') ||
    isDevModuleGraph(url)
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
