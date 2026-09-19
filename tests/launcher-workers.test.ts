import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LauncherWorkers } from '../src/launcher/workers.js';
import { DockerLauncher } from '../src/launcher/docker.js';
import { serveLauncher } from '../src/launcher/service.js';
import { SocketLauncher } from '../src/launcher/client.js';
import { ContainerToolExecutor, workerRunArgs } from '../src/tools/containerExecutor.js';
import { launcherRequestSchema } from '../src/contracts/launcherRpc.js';

it('keeps the worker socket profile isolated and rejects caller engine syntax', () => {
  const args = workerRunArgs({ image: 'pinned-worker', workspaceHostPath: '/work', socketHostPath: '/run/private/w.sock', user: '10001:10001' });
  expect(args).toContain('type=bind,src=/run/private/w.sock,dst=/run/atoma-worker.sock,readonly');
  expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'none']);
  expect(args).toContain('no-new-privileges');
  expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
  expect(args).not.toContain('-i');
  expect(launcherRequestSchema.safeParse({ op: 'startWorker', spec: { ownerId: 'run', workspaceId: 'build', egress: false, workspaceHostPath: '/etc' } }).success).toBe(false);
});

// Unix socket-file mounts are a Linux deployment contract. The fake engine
// starts the REAL worker in a child; no Docker or paid provider is used here.
describe.skipIf(process.platform === 'win32')('launcher worker transport', () => {
  let root: string;
  let workspace: string;
  let workers: LauncherWorkers;
  let service: Awaited<ReturnType<typeof serveLauncher>>;
  const children = new Map<string, ChildProcess>();
  let calls: string[][];
  let refuseRemoval: boolean;
  const executors: ContainerToolExecutor[] = [];
  const clients: SocketLauncher[] = [];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'atw-')));
    chmodSync(root, 0o700);
    mkdirSync(join(root, 's'), { mode: 0o700 });
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    calls = [];
    refuseRemoval = false;
    const runDocker = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]!;
        const mount = args[args.indexOf('--mount') + 1]!;
        const socketPath = /src=([^,]+)/.exec(mount)![1]!;
        const child = fork(fileURLToPath(new URL('../src/tools/worker.ts', import.meta.url)), [], {
          execArgv: ['--import', 'tsx'],
          env: { PATH: process.env['PATH'], ATOMA_WORKER_ROOT: workspace, ATOMA_WORKER_SOCKET: socketPath },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        children.set(name, child);
      }
      if (args[0] === 'rm') {
        if (refuseRemoval) throw new Error('engine unavailable');
        const child = children.get(args[2]!);
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
          child.kill('SIGTERM');
          await exited;
        }
        children.delete(args[2]!);
      }
      if (args[0] === 'ps') {
        if (refuseRemoval) throw new Error('engine unavailable');
        return '';
      }
      return '';
    };
    const launcher = new DockerLauncher({ image: 'worker-image', runDocker });
    workers = new LauncherWorkers({
      launcher, image: 'worker-image', socketRoot: join(root, 's'),
      user: `${process.getuid?.() || 10001}:${process.getgid?.() || 10001}`,
      workspaces: { build: workspace }, allowlist: [], runDocker,
    });
    service = await serveLauncher({
      socketPath: join(root, 'control.sock'), launcher, workers,
      hello: { version: 2, image: 'worker-image', previewImage: 'preview-image', previewRuntime: 'runsc', previewOwnership: { uid: 10001, gid: 10001 } },
      disconnectOwner: async () => undefined,
    });
    vi.stubEnv('ATOMA_LAUNCHER_SOCKET', join(root, 'control.sock'));
    vi.stubEnv('ATOMA_LAUNCHER_WORKSPACE_ID', 'build');
  });
  afterEach(async () => {
    refuseRemoval = false;
    for (const executor of executors.splice(0)) await executor.drain().catch(() => undefined);
    for (const client of clients.splice(0)) client.close();
    await service.close();
    for (const child of children.values()) child.kill('SIGKILL');
    children.clear();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const executor = () => {
    const result = new ContainerToolExecutor({ workspaceHostPath: workspace, image: 'worker-image', forwardWorkerLogs: false });
    executors.push(result);
    return result;
  };
  const client = async () => {
    const result = await SocketLauncher.connect(join(root, 'control.sock'));
    clients.push(result);
    return result;
  };

  it('uses the real worker protocol, preserves UTF-8 and pipelines tool calls', async () => {
    const run = executor();
    await run.start();
    expect(run.has('write_file')).toBe(true);
    await run.execute('write_file', { path: 'value.txt', content: 'été 日本語' });
    let shellDone = false;
    const shell = run.execute('run_shell', { command: 'node', args: ['-e', 'setTimeout(() => {}, 2000)'] }).then(() => { shellDone = true; });
    const read = await run.execute('read_file', { path: 'value.txt' });
    expect(JSON.stringify(read)).toContain('été 日本語');
    expect(shellDone).toBe(false);
    await shell;
    await run.drain();
    expect(children.size).toBe(0);
    expect(calls.some(args => args[0] === 'ps')).toBe(true);
  });

  it('refuses foreign stop handles and simultaneous use of the workspace', async () => {
    const first = await client();
    const second = await client();
    const handle = await first.startWorker({ ownerId: 'first', workspaceId: 'build', egress: false });
    await expect(second.stopWorker(handle.id)).rejects.toThrow('operation-failed');
    await expect(second.startWorker({ ownerId: 'second', workspaceId: 'build', egress: false })).rejects.toThrow('operation-failed');
    first.close();
    await vi.waitFor(() => expect(children.size).toBe(0));
  });

  it('does not certify drain while the engine cannot prove removal', async () => {
    const run = executor();
    await run.start();
    refuseRemoval = true;
    await expect(run.drain()).rejects.toThrow('operation-failed');
    refuseRemoval = false;
    await run.drain();
  });

  it('fails on a wrong workspace mapping without executing tools there', async () => {
    const run = new ContainerToolExecutor({ workspaceHostPath: join(root, 'different'), image: 'worker-image' });
    await expect(run.start()).rejects.toThrow('workspace mapping mismatch');
    await vi.waitFor(() => expect(children.size).toBe(0));
  });
});
