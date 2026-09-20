// Run on a disposable engine after building web, launcher and worker images.
// Docker Desktop proves this service/volume boundary, not W13 Linux/gVisor acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
const images = Object.fromEntries(['WEB', 'LAUNCHER', 'WORKER', 'PREVIEW'].map(kind => {
  const image = process.env[`ATOMA_TEST_${kind}_IMAGE`];
  assert(image, `ATOMA_TEST_${kind}_IMAGE is required`);
  docker('image', 'inspect', image);
  return [kind, image];
}));
assert(/@sha256:[a-f0-9]{64}$/.test(images.PREVIEW), 'Preview profile needs a real pulled digest');
// Boot recovery scans atoma resources. Refuse a shared engine holding any of them.
for (const command of [['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']]) {
  assert.equal(docker(...command, '--filter', 'label=dev.atoma.owner').trim(), '', 'Use an idle disposable engine');
}
const id = `atoma-smoke-${randomUUID()}`;
// AF_UNIX paths include the engine's volume mountpoint and a worker UUID.
const volume = `as-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const service = `${id}-launcher`;
let serviceCreated = false;
let volumeCreated = false;
try {
  docker('volume', 'create', volume);
  volumeCreated = true;
  const root = JSON.parse(docker('volume', 'inspect', volume))[0].Mountpoint;
  assert(root.startsWith('/') && root.endsWith('/_data'));
  assert(root.length < 50, 'Engine volume path is too long for private Unix sockets');
  const mount = `type=volume,source=${volume},target=${root}`;
  docker('run', '--rm', '--network', 'none', '--mount', mount, images.WEB,
    'node', '-e', `const fs=require('node:fs'); for(const p of ['control','sockets','workspaces','state']) fs.mkdirSync(${JSON.stringify(root)}+'/'+p,{mode:0o700});`);
  const env = {
    ATOMA_LAUNCHER_SOCKET: `${root}/control/launcher.sock`,
    ATOMA_LAUNCHER_WORKER_SOCKET_ROOT: `${root}/sockets`,
    ATOMA_LAUNCHER_WORKSPACE_ROOT: `${root}/workspaces`,
    ATOMA_LAUNCHER_STATE_ROOT: `${root}/state`,
    ATOMA_LAUNCHER_WORKER_IMAGE: images.WORKER,
    ATOMA_LAUNCHER_PREVIEW_IMAGE: images.PREVIEW,
    ATOMA_LAUNCHER_PREVIEW_USER: '10001:10001',
  };
  docker('run', '-d', '--name', service, '--network', 'none', '--read-only', '--tmpfs', '/tmp',
    '--security-opt', 'no-new-privileges:true', '--mount', mount,
    '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    ...Object.entries(env).flatMap(([key,value]) => ['-e', `${key}=${value}`]), images.LAUNCHER);
  serviceCreated = true;
  const client = readFileSync(new URL('./launcher-container-smoke-client.mjs', import.meta.url), 'utf8');
  const runClient = phase => execFileSync('docker', ['run', '--rm', '-i', '--network', 'none',
    '--read-only', '--tmpfs', '/tmp', '--security-opt', 'no-new-privileges:true', '--mount', mount,
    '-e', `ATOMA_LAUNCHER_SOCKET=${env.ATOMA_LAUNCHER_SOCKET}`,
    '-e', `ATOMA_TEST_ROOT=${root}`, '-e', `ATOMA_WORKER_IMAGE=${images.WORKER}`,
    '-e', `ATOMA_TEST_PHASE=${phase}`, images.WEB, 'node', '--input-type=module'],
  { input: client, encoding: 'utf8', timeout: 180_000, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdout.write(runClient('initial'));
  docker('restart', service);
  process.stdout.write(runClient('restart'));
  docker('stop', service);
  for (const command of [['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']]) {
    assert.equal(docker(...command, '--filter', 'label=dev.atoma.owner').trim(), '', 'Launcher leaked resources');
  }
  console.log('launcher container smoke passed: real RPC/worker, foreign path refusal, retained bytes after restart, cleanup');
} catch (error) {
  if (serviceCreated) process.stderr.write(docker('logs', service));
  throw error;
} finally {
  if (serviceCreated) { docker('stop', service); docker('rm', service); }
  if (volumeCreated) docker('volume', 'rm', volume);
}
