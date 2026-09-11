import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerLauncher } from '../src/launcher/docker.js';
import { startPreview, teardownPreview } from '../src/preview/runtime.js';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// This test proves network plumbing under the local development runtime.
// Production gVisor confinement remains covered by preview-isolation.test.ts.
let dockerAvailable = false;
try {
  execFileSync('docker', ['image', 'inspect', 'atoma-worker:latest'], { stdio: 'ignore' });
  dockerAvailable = true;
} catch { /* optional local runtime */ }

// Explicit live smoke: ordinary tests do not depend on Google availability.
it.skipIf(!dockerAvailable || process.env['ATOMA_NETWORK_LIVE_TEST'] !== '1')('allows approved preview egress and refuses the control plane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-preview-network-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const ownerId = `network-check-${process.pid}`;
  const launcher = new DockerLauncher({
    image: 'atoma-worker:latest', previewImage: 'atoma-worker:latest',
    previewRuntime: 'runc', workspaceRoot: join(root, 'copies'),
  });
  writeFileSync(join(source, 'server.mjs'), `
import http from 'node:http';
const server = http.createServer(async (req, res) => {
  if (req.url !== '/check') { res.end('ready'); return; }
  try {
    const remote = await fetch('https://fonts.googleapis.com/css?family=Open+Sans', {
      signal: AbortSignal.timeout(10000),
    });
    let denied = false;
    try {
      await fetch('http://host.docker.internal:4111/api/runs', { signal: AbortSignal.timeout(3000) });
    } catch { denied = true; }
    res.end(JSON.stringify({ externalStatus: remote.status, denied }));
  } catch (error) { res.end(JSON.stringify({ error: String(error) })); }
});
server.listen(Number(process.env.PORT), '0.0.0.0', () => {
  console.log('LISTENING_ON_PORT=' + server.address().port);
});
`);
  try {
    const running = await startPreview({
      launcher, imageDigest: null, runtime: 'runc',
      probe: async (port) => (await fetch(`http://127.0.0.1:${port}`)).ok,
    }, { ownerId, sourceWorkspace: source, entry: 'server.mjs', allowedHosts: ['fonts.googleapis.com'] });
    const result = await (await fetch(`http://127.0.0.1:${running.hostPort}/check`)).json();
    expect(result).toEqual({ externalStatus: 200, denied: true });
  } finally {
    await teardownPreview({ launcher }, ownerId, {});
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
