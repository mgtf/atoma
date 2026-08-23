import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  registerAtomaServiceWorker,
  serviceWorkerRegistrationAllowed,
} from '../src/viz/client/pwa.js';

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe('Atoma visualizer PWA assets', () => {
  const manifest = JSON.parse(
    readFileSync('src/viz/public/manifest.webmanifest', 'utf8')
  ) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  const gpuHtml = readFileSync('src/viz/client-gl/index.html', 'utf8');
  const muiHtml = readFileSync('src/viz/client/index.html', 'utf8');
  const favicon = readFileSync('src/viz/public/favicon.svg', 'utf8');
  const serviceWorker = readFileSync('src/viz/public/sw.js', 'utf8');
  const registration = readFileSync('src/viz/client/pwa.ts', 'utf8');
  const vite = readFileSync('vite.config.ts', 'utf8');
  const server = readFileSync('src/viz/server.ts', 'utf8');

  it('uses the capitalized Atoma identity and installable manifest contract', () => {
    expect(manifest).toMatchObject({
      name: 'Atoma Visualizer',
      short_name: 'Atoma',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#0b111e',
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      ])
    );
  });

  it('ships exact PNG sizes for browser, Apple and maskable surfaces', () => {
    expect(pngSize('src/viz/public/icons/atoma-192.png')).toEqual({
      width: 192,
      height: 192,
    });
    expect(pngSize('src/viz/public/icons/atoma-512.png')).toEqual({
      width: 512,
      height: 512,
    });
    expect(pngSize('src/viz/public/icons/atoma-maskable-512.png')).toEqual({
      width: 512,
      height: 512,
    });
    expect(pngSize('src/viz/public/apple-touch-icon.png')).toEqual({
      width: 180,
      height: 180,
    });
  });

  it('uses the one-crystal rank mark in both clients', () => {
    expect(favicon).toContain('Atoma');
    expect(favicon).toMatch(/one crystal, three ranks/);
    expect(favicon).not.toMatch(/<circle|<ellipse/);
    for (const html of [gpuHtml, muiHtml]) {
      expect(html).toContain('<title>Atoma');
      expect(html).toContain('href="/favicon.svg"');
      expect(html).toContain('href="/apple-touch-icon.png"');
      expect(html).toContain('href="/manifest.webmanifest"');
    }
  });

  it('registers in production, opts in for dev, and never caches API or auth responses', () => {
    expect(registration).toContain("register('/sw.js'");
    // The define is the ONLY dev switch, and it is read in one place.
    expect(vite).toContain("ATOMA_VIZ_SW_DEV");
    expect(vite).toContain('__ATOMA_SW_DEV__');
    expect(serviceWorker).toContain("url.pathname.startsWith('/api/')");
    expect(serviceWorker).toContain("url.pathname.startsWith('/auth/')");
    expect(serviceWorker).toContain("url.pathname.startsWith('/webhooks/')");
    expect(serviceWorker).toContain("cache-control");
    expect(serviceWorker).toContain("no-store");
    expect(serviceWorker).toContain('request.mode === \'navigate\'');
    expect(serviceWorker).toContain('atoma-viz-shell-v2');
    // A dev-session worker must not cache Vite's rewritten module URLs.
    expect(serviceWorker).toContain('isDevModuleGraph');
    expect(serviceWorker).toContain("url.pathname.startsWith('/@')");
  });

  it('handles push notifications with untrusted-payload defaults', () => {
    expect(serviceWorker).toContain("addEventListener('push'");
    expect(serviceWorker).toContain("addEventListener('notificationclick'");
    expect(serviceWorker).toContain('showNotification');
    expect(serviceWorker).toContain("payload.url.startsWith('/')");
  });

  it('shares one public directory and serves every required MIME type', () => {
    expect(vite).toContain("new URL('./src/viz/public'");
    expect(server).toContain("case '.webmanifest':");
    expect(server).toContain('application/manifest+json');
    for (const path of [
      'src/viz/public/favicon.svg',
      'src/viz/public/sw.js',
      'src/viz/public/icons/atoma-192.png',
      'src/viz/public/icons/atoma-512.png',
      'src/viz/public/icons/atoma-maskable-512.png',
      'src/viz/public/apple-touch-icon.png',
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
  });
});

/**
 * THE DEV OPT-IN, exercised rather than grepped.
 *
 * The worker's scope is the ORIGIN, not the build, so a registration left by a
 * dev session outlives the dev server that made it. That is why turning the
 * flag off must UNREGISTER, not merely skip: the off switch is the half that
 * makes the on switch safe, and a guard that only skips would leave every
 * developer who tried it once permanently controlled by a stale worker.
 */
describe('the service worker is production-default and dev-opt-in', () => {
  it('allows production always and dev only on the explicit flag', () => {
    expect(serviceWorkerRegistrationAllowed({ prod: true, devOptIn: false })).toBe(true);
    expect(serviceWorkerRegistrationAllowed({ prod: false, devOptIn: true })).toBe(true);
    expect(serviceWorkerRegistrationAllowed({ prod: false, devOptIn: false })).toBe(false);
    // No production build, no define: the default in any other context is off.
    expect(serviceWorkerRegistrationAllowed()).toBe(false);
  });

  interface FakeRegistration {
    readonly active: { scriptURL: string };
    unregistered: boolean;
    unregister(): Promise<boolean>;
  }

  function fakeRegistration(scriptURL: string): FakeRegistration {
    const registration: FakeRegistration = {
      active: { scriptURL },
      unregistered: false,
      unregister: () => {
        registration.unregistered = true;
        return Promise.resolve(true);
      },
    };
    return registration;
  }

  function withBrowser(registrations: FakeRegistration[], cacheKeys: string[]): {
    registered: string[];
    deletedCaches: string[];
    restore: () => void;
  } {
    const registered: string[] = [];
    const deletedCaches: string[] = [];
    // `navigator` is a getter-only global in Node; stubGlobal redefines it.
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: () => Promise.resolve(registrations),
        register: (url: string) => {
          registered.push(url);
          return Promise.resolve({ update: () => Promise.resolve() });
        },
      },
    });
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve(cacheKeys),
      delete: (key: string) => {
        deletedCaches.push(key);
        return Promise.resolve(true);
      },
    });
    return { registered, deletedCaches, restore: () => vi.unstubAllGlobals() };
  }

  it('removes its own dev registration and shell cache when the flag is off', async () => {
    const ours = fakeRegistration('http://127.0.0.1:5173/sw.js');
    const someoneElse = fakeRegistration('http://127.0.0.1:5173/other-app/worker.js');
    const browser = withBrowser([ours, someoneElse], ['atoma-viz-shell-v2', 'other-app-v1']);
    try {
      // Under vitest neither PROD nor the define is set: this is a dev session
      // that did NOT opt in.
      registerAtomaServiceWorker();
      // Cleanup is fire-and-forget by design, so settle on the effect itself
      // rather than on a guessed number of microtasks.
      await vi.waitFor(() => {
        expect(ours.unregistered).toBe(true);
        expect(browser.deletedCaches).toEqual(['atoma-viz-shell-v2']);
      });
      expect(browser.registered).toEqual([]);
      // The dev origin is shared with whatever else uses that port. Removing a
      // neighbour's worker, or its caches, is not ours to do.
      expect(someoneElse.unregistered).toBe(false);
    } finally {
      browser.restore();
    }
  });
});
