import type { WorkspaceVolumes } from './volumes.js';
import { projectWorkspaceRelative } from '../contracts/launcherVolumes.js';
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerLauncher } from '../contracts/launcher.js';
import type { LauncherWorkerHandle, LauncherWorkerSpec, WorkerLauncher } from '../contracts/launcherWorker.js';
import { launcherWorkerSpecSchema, workerWorkspaceIdSchema } from '../contracts/launcherWorker.js';
import { attachedWorkerLifecycle, type AsyncDockerRunner } from './docker.js';
import { workerRunArgs } from './workerProfile.js';

const exec = promisify(execFile);
type State = {
  handle: LauncherWorkerHandle; workspace: string; directory: string;
  lifecycle: ReturnType<typeof attachedWorkerLifecycle>; servers: Server[]; sockets: Set<Socket>;
  egress: boolean;
};

/**
 * A Unix socket path must fit `sockaddr_un.sun_path`: 104 bytes on macOS/BSD,
 * 108 on Linux. 100 keeps the margin. The per-worker path is
 * `<socketRoot>/<uuid>/w.sock`, so the root itself only gets what a UUID and
 * the socket name leave. Checked at CONSTRUCTION as well as per worker: bound
 * late, the launcher answers `operation-failed` with no message on the wire,
 * and a socket root a few bytes too long looks like an engine fault.
 */
const SOCKET_PATH_BYTES = 100;
const WORKER_PATH_OVERHEAD = '/'.length + 36 + '/w.sock'.length;

function socketRootTooLong(socketRoot: string): string {
  return `Worker socket root is too long: ${Buffer.byteLength(socketRoot)} bytes + ${WORKER_PATH_OVERHEAD} for <uuid>/w.sock exceeds the ${SOCKET_PATH_BYTES}-byte Unix socket budget (${socketRoot})`;
}

export function assertSocketRootFits(socketRoot: string): void {
  if (Buffer.byteLength(socketRoot) + WORKER_PATH_OVERHEAD > SOCKET_PATH_BYTES) {
    throw new Error(socketRootTooLong(socketRoot));
  }
}

/** Engine ownership and transport rendezvous. No tool is executed in this process. */
export class LauncherWorkers implements WorkerLauncher {
  private readonly live = new Map<string, State>();
  private readonly run: AsyncDockerRunner;
  private readonly workspaces = new Map<string, string>();
  constructor(private readonly options: {
    launcher: ContainerLauncher; image: string; socketRoot: string; user: string;
    volumes?: WorkspaceVolumes; workspaceRoot?: string; workspaces: Record<string, string>; allowlist: readonly string[]; runDocker?: AsyncDockerRunner;
  }) {
    this.run = options.runDocker ?? (async (args) => (await exec('docker', args, { timeout: args[0] === 'run' ? 60_000 : 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    for (const [id, directory] of Object.entries(options.workspaces)) {
      workerWorkspaceIdSchema.parse(id);
      this.validateDirectory(directory);
      this.workspaces.set(id, directory);
    }
    this.validateDirectory(options.socketRoot);
    if (options.workspaceRoot && (options.socketRoot === options.workspaceRoot || options.socketRoot.startsWith(options.workspaceRoot + path.sep) || options.workspaceRoot.startsWith(options.socketRoot + path.sep))) throw new Error('Worker sockets must be outside the workspace root');
    const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
    for (const directory of this.workspaces.values()) {
      if (contains(directory, options.socketRoot) || contains(options.socketRoot, directory)) throw new Error('Worker sockets and workspaces must be separate');
      for (const other of this.workspaces.values()) {
        if (directory !== other && (contains(directory, other) || contains(other, directory))) throw new Error('Registered workspaces must not overlap');
      }
    }
    if ((lstatSync(options.socketRoot).mode & 0o007) !== 0) throw new Error('Worker socket root must be private');
    assertSocketRootFits(options.socketRoot);
    if (!/^[1-9]\d*:\d+$/.test(options.user)) throw new Error('Worker user must be numeric and non-root');
  }

  private validateDirectory(directory: string): void {
    if (!path.isAbsolute(directory) || directory === path.parse(directory).root || /[:,\n\r]/.test(directory)
      || realpathSync(directory) !== path.resolve(directory) || !lstatSync(directory).isDirectory()) {
      throw new Error('Launcher requires pre-created real dedicated directories');
    }
  }

  async startWorker(input: LauncherWorkerSpec): Promise<LauncherWorkerHandle> {
    const spec = launcherWorkerSpecSchema.parse(input);
    if (!!spec.project === !!spec.workspaceId) throw new Error('Select exactly one workspace identity');
    const relative = spec.project ? projectWorkspaceRelative(spec.project) : undefined;
    const workspace = relative && this.options.workspaceRoot
      ? path.join(this.options.workspaceRoot, relative) : this.workspaces.get(spec.workspaceId ?? '');
    if (!workspace) throw new Error('Unknown worker workspace');
    if (!this.options.volumes) this.validateDirectory(workspace);
    if (this.live.size >= 16 || [...this.live.values()].some(s => s.workspace === workspace || s.handle.ownerId === spec.ownerId)) {
      throw new Error('Worker workspace or owner is already active');
    }
    const id = randomUUID();
    const directory = path.join(this.options.socketRoot, id);
    const workerPath = path.join(directory, 'w.sock');
    const clientPath = path.join(directory, 'c.sock');
    if (Buffer.byteLength(workerPath) > SOCKET_PATH_BYTES) throw new Error(socketRootTooLong(this.options.socketRoot));
    mkdirSync(directory, { mode: 0o700 });
    const state: State = {
      handle: { id, ownerId: spec.ownerId, socketPath: clientPath, workspaceHostPath: workspace },
      workspace, directory, lifecycle: attachedWorkerLifecycle({ runDocker: this.run }),
      servers: [], sockets: new Set(), egress: spec.egress,
    };
    let finishLaunch!: () => void;
    const launched = new Promise<void>(resolve => { finishLaunch = resolve; });
    this.live.set(id, state); // Claim before the first asynchronous operation.
    try {
      if (this.options.volumes) {
        if (!this.options.workspaceRoot) throw new Error('Workspace root missing');
        const row = await this.options.volumes.create('worker', spec.ownerId, path.relative(this.options.workspaceRoot, workspace));
        state.handle = { ...state.handle, volume: row.volume };
      }
      let worker: Socket | undefined;
      let client: Socket | undefined;
      let workerAccepted = false;
      let clientAccepted = false;
      const bridge = () => {
        if (worker && client) { worker.pipe(client); client.pipe(worker); }
      };
      const accept = (side: 'worker' | 'client', socket: Socket) => {
        if (side === 'worker' ? workerAccepted : clientAccepted) { socket.destroy(); return; }
        socket.pause();
        state.sockets.add(socket);
        socket.on('error', () => socket.destroy());
        socket.once('close', () => {
          // Failure is terminal: no reconnection/replay into this workspace.
          for (const peer of state.sockets) peer.destroy();
          void launched.then(() => this.stopWorker(id)).catch(() => undefined); // retained for retry on failure
        });
        if (side === 'worker') { workerAccepted = true; worker = socket; }
        else { clientAccepted = true; client = socket; }
        bridge();
      };
      for (const [endpoint, side] of [[workerPath, 'worker'], [clientPath, 'client']] as const) {
        const server = createServer(socket => accept(side, socket));
        state.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(endpoint, () => {
            try { chmodSync(endpoint, 0o600); resolve(); }
            catch (error) { reject(error instanceof Error ? error : new Error('Worker socket bind failed')); }
          });
        });
      }
      const [uid, gid] = this.options.user.split(':').map(Number);
      chownSync(workerPath, uid!, gid!);
      let egress: { network: string; proxyHost: string; proxyPort: number } | undefined;
      if (spec.egress) {
        const launcher = this.options.launcher;
        await launcher.purgeOwner('egress', spec.ownerId);
        await launcher.armHardExitCleanup('egress', spec.ownerId);
        const internal = await launcher.createNetwork({ family: 'egress', kind: 'internal', ownerId: spec.ownerId });
        const uplink = await launcher.createNetwork({ family: 'egress', kind: 'uplink', ownerId: spec.ownerId });
        const proxy = await launcher.startUnit({ kind: 'egress-proxy', ownerId: spec.ownerId, allowlist: [...this.options.allowlist] }, [internal, uplink]);
        await launcher.awaitUnitReady(proxy);
        egress = { network: internal.name, proxyHost: proxy.name, proxyPort: 3128 };
      }
      const args = workerRunArgs({ image: this.options.image, workspaceHostPath: workspace, workspaceVolume: state.handle.volume, user: this.options.user, socketHostPath: workerPath, egress });
      args.splice(1, 0, '--name', state.lifecycle.name, '--label', 'dev.atoma.owner=worker');
      await this.run(args);
      finishLaunch();
      return state.handle;
    } catch (error) {
      finishLaunch();
      await this.stopWorker(id);
      throw error;
    }
  }

  private readonly stopping = new Map<string, Promise<void>>();
  stopWorker(id: string): Promise<void> {
    const running = this.stopping.get(id);
    if (running) return running;
    const state = this.live.get(id);
    if (!state) return Promise.resolve();
    const stop = Promise.resolve().then(async () => {
      await state.lifecycle.drain(); // Engine absence BEFORE networks or workspace reuse.
      for (const socket of state.sockets) socket.destroy();
      await Promise.all(state.servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      if (state.egress) {
        const launcher = this.options.launcher;
        await launcher.stopUnit({ kind: 'egress-proxy', ownerId: state.handle.ownerId, name: launcher.unitName('egress-proxy', state.handle.ownerId) }, 'completed');
        const deadline = Date.now() + 3500;
        for (const kind of ['uplink', 'internal'] as const) {
          const spec = { family: 'egress' as const, ownerId: state.handle.ownerId, kind };
          if (!await launcher.removeNetworkBefore({ ...spec, name: launcher.networkName(spec) }, deadline)) throw new Error('Worker network teardown incomplete');
        }
        await launcher.disarmHardExitCleanup('egress', state.handle.ownerId);
      }
      await this.options.volumes?.release('worker', state.handle.ownerId);
      rmSync(state.directory, { recursive: true, force: true });
      this.live.delete(id);
    }).finally(() => this.stopping.delete(id));
    this.stopping.set(id, stop);
    return stop;
  }

  async stopOwner(ownerId: string): Promise<void> {
    for (const state of this.live.values()) {
      if (state.handle.ownerId === ownerId) await this.stopWorker(state.handle.id);
    }
  }

  /** Process-exit backstop; normal shutdown awaits stopWorker through the service. */
  hardExit(): void {
    for (const state of this.live.values()) {
      try { execFileSync('docker', ['rm', '-f', state.lifecycle.name], { timeout: 750, stdio: 'ignore' }); } catch { /* orphan reconciliation retries */ }
    }
  }

  async reconcileOrphans(): Promise<number> {
    if (this.live.size) throw new Error('Workers still active');
    const names = (await this.run(['ps', '-a', '--filter', 'label=dev.atoma.owner=worker', '--format', '{{.Names}}'])).trim().split(/\s+/).filter(Boolean);
    for (const name of names) {
      if (!/^atoma-worker-[a-f0-9-]+$/.test(name)) throw new Error('Unexpected worker name');
      await this.run(['rm', '-f', name]);
    }
    return names.length;
  }
}
