import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ServiceWorkerHandler = (event: Record<string, unknown>) => void;

interface WorkerHarness {
  handlers: Map<string, ServiceWorkerHandler>;
  fetch: ReturnType<typeof vi.fn>;
  cache: {
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    match: ReturnType<typeof vi.fn>;
  };
  caches: {
    open: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
}

function workerHarness(): WorkerHarness {
  const handlers = new Map<string, ServiceWorkerHandler>();
  const cache = {
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    match: vi.fn(async () => undefined),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const fetchMock = vi.fn();
  const claim = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  const source = readFileSync('src/viz/public/sw.js', 'utf8');
  runInNewContext(source, {
    URL,
    Response,
    fetch: fetchMock,
    caches,
    location: { origin: 'https://viz.example' },
    clients: { claim },
    skipWaiting,
    addEventListener(name: string, handler: ServiceWorkerHandler) {
      handlers.set(name, handler);
    },
  });
  return { handlers, fetch: fetchMock, cache, caches, skipWaiting, claim };
}

async function dispatchLifecycle(harness: WorkerHarness, name: 'install' | 'activate') {
  let work: Promise<unknown> | undefined;
  harness.handlers.get(name)?.({
    waitUntil(value: Promise<unknown>) {
      work = value;
    },
  });
  if (!work) throw new Error(`service worker did not register ${name}`);
  await work;
}

function dispatchFetch(
  harness: WorkerHarness,
  request: { method: string; url: string; mode: string }
): Promise<Response> | undefined {
  let response: Promise<Response> | undefined;
  harness.handlers.get('fetch')?.({
    request,
    respondWith(value: Promise<Response>) {
      response = value;
    },
  });
  return response;
}

describe('viz service worker cache boundary', () => {
  let harness: WorkerHarness;

  beforeEach(() => {
    harness = workerHarness();
  });

  it('installs despite a missing asset and never pre-caches a no-store shell', async () => {
    harness.fetch.mockImplementation((asset: string) => {
      if (asset === '/') {
        return new Response('sign in', {
          status: 200,
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (asset === '/favicon.svg') return new Response('missing', { status: 404 });
      return new Response('asset', { status: 200 });
    });

    await dispatchLifecycle(harness, 'install');

    expect(harness.skipWaiting).toHaveBeenCalledOnce();
    expect(harness.cache.put).not.toHaveBeenCalledWith('/', expect.any(Response));
    expect(harness.cache.delete).toHaveBeenCalledWith('/');
    expect(harness.cache.put).not.toHaveBeenCalledWith('/favicon.svg', expect.any(Response));
    expect(harness.cache.put).toHaveBeenCalledWith(
      '/manifest.webmanifest',
      expect.any(Response)
    );
  });

  it('activates by purging v1 before claiming existing clients', async () => {
    harness.caches.keys.mockResolvedValueOnce([
      'atoma-viz-shell-v1',
      'atoma-viz-shell-v2',
      'unrelated-cache',
    ]);

    await dispatchLifecycle(harness, 'activate');

    expect(harness.caches.delete).toHaveBeenCalledTimes(1);
    expect(harness.caches.delete).toHaveBeenCalledWith('atoma-viz-shell-v1');
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it('still activates when stale-cache cleanup is unavailable', async () => {
    harness.caches.keys.mockRejectedValueOnce(new Error('cache storage unavailable'));
    harness.claim.mockRejectedValueOnce(new Error('client disappeared'));

    await expect(dispatchLifecycle(harness, 'activate')).resolves.toBeUndefined();
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it.each(['/api/runs', '/auth/whoami', '/webhooks/github'])(
    'does not intercept protected live route %s',
    (path) => {
      const response = dispatchFetch(harness, {
        method: 'GET',
        url: `https://viz.example${path}`,
        mode: 'cors',
      });
      expect(response).toBeUndefined();
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.caches.open).not.toHaveBeenCalled();
    }
  );

  it('deletes a stale offline shell when a navigation becomes no-store', async () => {
    harness.fetch.mockResolvedValueOnce(
      new Response('sign in', {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      })
    );
    const response = dispatchFetch(harness, {
      method: 'GET',
      url: 'https://viz.example/',
      mode: 'navigate',
    });

    expect(await response).toBeInstanceOf(Response);
    expect(harness.cache.delete).toHaveBeenCalledWith('/');
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it('keeps an explicitly revalidated app shell available offline', async () => {
    harness.fetch.mockResolvedValueOnce(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'cache-control': 'no-cache' },
      })
    );
    const response = dispatchFetch(harness, {
      method: 'GET',
      url: 'https://viz.example/',
      mode: 'navigate',
    });

    expect((await response)?.status).toBe(200);
    expect(harness.cache.put).toHaveBeenCalledWith('/', expect.any(Response));
    expect(harness.cache.delete).not.toHaveBeenCalled();
  });

  it('falls back to the cached shell only after a network failure', async () => {
    const cached = new Response('offline', { status: 200 });
    harness.fetch.mockRejectedValueOnce(new Error('offline'));
    harness.cache.match.mockResolvedValueOnce(cached);
    const response = dispatchFetch(harness, {
      method: 'GET',
      url: 'https://viz.example/runs',
      mode: 'navigate',
    });

    expect(await response).toBe(cached);
    expect(harness.caches.open).toHaveBeenCalledWith('atoma-viz-shell-v2');
    expect(harness.cache.match).toHaveBeenCalledWith('/');
  });

  it('returns a successful network response even when cache writes fail', async () => {
    const network = new Response('live', { status: 200 });
    harness.fetch.mockResolvedValueOnce(network);
    harness.cache.put.mockRejectedValueOnce(new Error('quota exceeded'));
    harness.cache.match.mockResolvedValueOnce(new Response('stale', { status: 200 }));

    const response = dispatchFetch(harness, {
      method: 'GET',
      url: 'https://viz.example/runs',
      mode: 'navigate',
    });

    expect(await response).toBe(network);
    expect(harness.cache.match).not.toHaveBeenCalled();
  });
});
