import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, type ProxyOptions } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config.js';

it('forwards OAuth discovery and exchanges through the real dev proxy, preserving the public Host', async () => {
  const backend = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method, host: req.headers.host }));
  });
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', resolve);
  });
  const target = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const proxy = Object.fromEntries(Object.entries(config.server!.proxy!).map(([path, entry]) => [
    path, typeof entry === 'string' ? target : { ...entry, target },
  ])) as Record<string, string | ProxyOptions>;
  const cacheDir = mkdtempSync(join(tmpdir(), 'atoma-oauth-proxy-'));
  const vite = await createViteServer({ ...config, configFile: false, cacheDir,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: 0, proxy, hmr: false, watch: null },
  });
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    for (const [path, method] of [
      ['/.well-known/oauth-authorization-server', 'GET'],
      ['/.well-known/oauth-protected-resource', 'GET'],
      ['/.well-known/oauth-protected-resource/mcp', 'GET'],
      ['/oauth/authorize?client_id=test', 'GET'],
      ['/oauth/register', 'POST'], ['/oauth/token', 'POST'], ['/oauth/revoke', 'POST'],
    ]) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ path, method, host: new URL(base).host });
    }
  } finally {
    await vite.close();
    backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
