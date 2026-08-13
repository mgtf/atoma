import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

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

  it('registers only in production and never caches API responses', () => {
    expect(registration).toMatch(/import\.meta\.env\.PROD/);
    expect(registration).toContain("register('/sw.js'");
    expect(serviceWorker).toContain("url.pathname.startsWith('/api/')");
    expect(serviceWorker).toContain('request.mode === \'navigate\'');
    expect(serviceWorker).toContain('atoma-viz-shell-v1');
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
