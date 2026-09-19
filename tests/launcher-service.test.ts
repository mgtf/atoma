import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SocketLauncher } from '../src/launcher/client.js';
import { connectContainerLauncher } from '../src/launcher/connect.js';
import { startEgressSidecar } from '../src/tools/egressSidecar.js';

let child: ChildProcess;
let root: string;
let socketPath: string;
let calls: string[][];
const clients: SocketLauncher[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'atoma-launcher-'));
  if (process.platform !== 'win32') chmodSync(root, 0o700);
  socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\atoma-launcher-${randomUUID()}` : join(root, 'launcher.sock');
  calls = [];
  child = fork(fileURLToPath(new URL('./fixtures/launcher-service.mjs', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, ATOMA_TEST_SOCKET: socketPath, ATOMA_TEST_WORKSPACES: join(root, 'workspaces') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Launcher fixture exited: ${code}`)));
    child.on('message', (message: { kind: string; args?: string[] }) => {
      if (message.kind === 'ready') resolve();
      if (message.kind === 'engine' && message.args) calls.push(message.args);
    });
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const client of clients.splice(0)) client.close();
  if (child?.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.send('stop');
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

async function client(): Promise<SocketLauncher> {
  const result = await SocketLauncher.connect(socketPath);
  clients.push(result);
  return result;
}

describe('separate launcher process', () => {
  it('drives the production egress lifecycle through the socket', async () => {
    vi.stubEnv('ATOMA_LAUNCHER_SOCKET', socketPath);
    const sidecar = await startEgressSidecar({ runId: 'socket-run', image: 'worker-image' });
    await sidecar.stop();
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(['network', 'rm', sidecar.network]));
    const creation = calls.find((args) => args[0] === 'network' && args[1] === 'create' && args.includes('--internal'))!;
    expect(creation).toContain('com.docker.network.bridge.gateway_mode_ipv4=isolated');
    expect(calls.find((args) => args[0] === 'run')).toContain('worker-image');
  });

  it('reaps only the disconnected connection while another owner stays live', async () => {
    const first = await client();
    const second = await client();
    for (const [connection, ownerId] of [[first, 'first'], [second, 'second']] as const) {
      await connection.armHardExitCleanup('egress', ownerId);
      await connection.createNetwork({ family: 'egress', kind: 'internal', ownerId });
    }
    await expect(second.reconcileOrphans()).rejects.toThrow('operation-failed');
    first.close();
    const firstName = first.unitName('egress-proxy', 'first');
    await vi.waitFor(() => expect(calls).toContainEqual(['rm', '-f', firstName]));
    await vi.waitFor(() => expect(calls).toContainEqual(['rm', '-f', 'attached-worker']));
    expect(calls).not.toContainEqual(['rm', '-f', second.unitName('egress-proxy', 'second')]);
  });

  it('rejects a forged handle before any engine call', async () => {
    const connection = await client();
    await expect(connection.removeNetwork({ family: 'egress', kind: 'internal', ownerId: 'run', name: 'foreign-network' })).rejects.toThrow('operation-failed');
    expect(calls).toEqual([]);
  });

  it('refuses profile drift and never falls back to local Docker', async () => {
    await expect(connectContainerLauncher({ image: 'wrong-image' }, { ATOMA_LAUNCHER_SOCKET: socketPath })).rejects.toThrow('profile');
    expect(calls).toEqual([]);
  });

  it('rejects raw engine options at the process boundary', async () => {
    const socket = createConnection(socketPath);
    try {
      const response = new Promise<string>((resolve, reject) => {
        socket.once('data', (chunk) => resolve(String(chunk)));
        socket.once('error', reject);
      });
      socket.write(JSON.stringify({ op: 'createNetwork', spec: { family: 'egress', kind: 'internal', ownerId: 'run', image: 'attacker-image' } }) + '\n');
      expect(JSON.parse(await response)).toEqual({ ok: false, code: 'invalid-request' });
      expect(calls).toEqual([]);
    } finally { socket.destroy(); }
  });
});
