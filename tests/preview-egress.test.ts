import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerLauncher } from '../src/launcher/docker.js';
import { startPreview, teardownPreview } from '../src/preview/runtime.js';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';

// This test proves network plumbing under the local development runtime.
// Production gVisor confinement remains covered by preview-isolation.test.ts.
let dockerAvailable = false;
try {
  execFileSync('docker', ['image', 'inspect', 'docker.io/library/atoma-worker:latest'], { stdio: 'ignore' });
  dockerAvailable = true;
} catch { /* optional local runtime */ }

if (process.env['CI_REQUIRE_DOCKER'] === '1' && !dockerAvailable) {
  throw new Error('Preview network tests require the Docker worker image');
}
const runtime = process.env['CI_REQUIRE_PREVIEW_RUNTIME'] === '1' ? 'runsc' : 'runc';
const previewImage = process.env['ATOMA_TEST_PREVIEW_IMAGE'] ?? 'docker.io/library/atoma-worker:latest';

// A controlled origin on the proxy uplink avoids any dependency on a public CDN.
it.skipIf(!dockerAvailable).each([false, true])('allows approved preview egress and refuses the control plane (DNS unavailable: %s)', async (disableDns) => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-preview-network-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const ownerId = `network-check-${process.pid}`;
  const fixture = `atoma-preview-network-fixture-${process.pid}`;
  const launcher = new DockerLauncher({
    image: 'docker.io/library/atoma-worker:latest', previewImage,
    previewRuntime: runtime, workspaceRoot: join(root, 'copies'),
  });
  writeFileSync(join(source, 'server.mjs'), `
import http from 'node:http';
import dns from 'node:dns';
import { isIP } from 'node:net';
// Reproduce the production EAI_AGAIN at the application's DNS boundary even
// on a developer runtime whose embedded Docker DNS happens to work.
if (${disableDns}) {
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (isIP(host)) return lookup(host, options, callback);
    if (typeof options === 'function') callback = options;
    callback(Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' }));
  };
}
const server = http.createServer(async (req, res) => {
  if (req.url !== '/check') { res.end('ready'); return; }
  try {
    const remote = await fetch('http://assets.atoma-test.invalid/resource', {
      signal: AbortSignal.timeout(10000),
    });
    const externalBody = await remote.text();
    let denied = false;
    let unapprovedDenied = false;
    try {
      await fetch('http://denied.atoma-test.invalid/resource', { signal: AbortSignal.timeout(3000) });
    } catch { unapprovedDenied = true; }
    try {
      await fetch('http://host.docker.internal:4111/api/runs', { signal: AbortSignal.timeout(3000) });
    } catch { denied = true; }
    res.end(JSON.stringify({ externalStatus: remote.status, externalBody, denied, unapprovedDenied }));
  } catch (error) { res.end(JSON.stringify({ error: String(error) })); }
});
server.listen(Number(process.env.PORT), '0.0.0.0', () => {
  console.log('LISTENING_ON_PORT=' + server.address().port);
});
`);
  try {
    const running = await startPreview({
      launcher, imageDigest: null, runtime,
      probe: async (port) => (await fetch(`http://127.0.0.1:${port}`)).ok,
    }, { ownerId, sourceWorkspace: source, entry: 'server.mjs', allowedHosts: ['assets.atoma-test.invalid'] });
    execFileSync('docker', ['run', '-d', '--rm', '--name', fixture,
      '--network', launcher.networkName({ family: 'preview', kind: 'uplink', ownerId }),
      '--network-alias', 'assets.atoma-test.invalid', '--network-alias', 'denied.atoma-test.invalid',
      'docker.io/library/atoma-worker:latest', 'node', '-e',
      'require("http").createServer((q,r)=>r.end("CONTROLLED_ORIGIN")).listen(80,"0.0.0.0",()=>console.log("READY"))',
    ], { stdio: 'ignore' });
    await vi.waitFor(() => expect(execFileSync('docker', ['logs', fixture], { encoding: 'utf8' })).toContain('READY'));
    const result = await (await fetch(`http://127.0.0.1:${running.hostPort}/check`)).json();
    expect(result).toEqual({ externalStatus: 200, externalBody: 'CONTROLLED_ORIGIN', denied: true, unapprovedDenied: true });
  } finally {
    try { execFileSync('docker', ['rm', '-f', fixture], { stdio: 'ignore' }); } catch { /* not started */ }
    await teardownPreview({ launcher }, ownerId, {});
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
