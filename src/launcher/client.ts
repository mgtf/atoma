import { WORKSPACE_HEARTBEAT_MS } from '../contracts/launcherVolumes.js';
import type { LauncherWorkerSpec, LauncherWorkerHandle } from '../contracts/launcherWorker.js';
import { createConnection, type Socket } from 'node:net';
import type { z } from 'zod';
import type {
  ContainerLauncher, LauncherFamily, LauncherNetworkHandle, LauncherNetworkSpec,
  LauncherOwnerId, LauncherPreviewOwnership, LauncherStopReason, LauncherUnitHandle,
  LauncherUnitKind, LauncherUnitSpec, LauncherUnitSummary, LauncherWorkspaceHandle,
} from '../contracts/launcher.js';
import {
  LAUNCHER_FRAME_BYTES, LAUNCHER_PROTOCOL_VERSION, LAUNCHER_REQUEST_TIMEOUT_MS,
  launcherResponseSchema, launcherResults, type LauncherHello, type LauncherRequest,
} from '../contracts/launcherRpc.js';
import { launcherNetworkName, launcherUnitName } from './names.js';

/** A broken connection is terminal: never replay a possibly executed mutation. */
export class SocketLauncher implements ContainerLauncher {
  private chain: Promise<unknown> = Promise.resolve();
  private buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private waiting: { resolve(value: unknown): void; reject(error: Error): void } | null = null;
  private hello: LauncherHello | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private constructor(private readonly socket: Socket) {
    socket.on('error', () => this.fail(new Error('Launcher connection failed')));
    socket.on('close', () => this.fail(new Error('Launcher connection closed')));
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > LAUNCHER_FRAME_BYTES) { this.fail(new Error('Launcher response too large')); return; }
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      const line = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      const waiter = this.waiting;
      if (!waiter || this.buffer.length) { this.fail(new Error('Unexpected launcher response')); return; }
      this.waiting = null;
      try {
        const response = launcherResponseSchema.parse(JSON.parse(line));
        if (!response.ok) {
          waiter.reject(new Error(response.code === 'isolated-gateway-unsupported'
            ? 'isolated gateway mode unsupported' : `Launcher ${response.code}`));
        } else waiter.resolve(response.result);
      } catch { waiter.reject(new Error('Invalid launcher response')); this.close(); }
    });
  }

  static async connect(socketPath: string): Promise<SocketLauncher> {
    const socket = createConnection(socketPath);
    const client = new SocketLauncher(socket);
    try {
      client.hello = await client.call({ op: 'hello', version: LAUNCHER_PROTOCOL_VERSION });
      client.heartbeatTimer = setInterval(() => { void client.call({ op: 'heartbeat' }).catch(() => client.close()); }, WORKSPACE_HEARTBEAT_MS);
      client.heartbeatTimer.unref();
      socket.unref();
      return client;
    } catch (error) { client.close(); throw error; }
  }

  get configuration(): LauncherHello {
    if (!this.hello) throw new Error('Launcher handshake incomplete');
    return this.hello;
  }

  close(): void { this.fail(new Error('Launcher connection closed')); }

  private fail(error: Error): void {
    clearInterval(this.heartbeatTimer);
    this.failure ??= error;
    this.waiting?.reject(this.failure);
    this.waiting = null;
    this.socket.destroy();
  }

  private call<R extends LauncherRequest>(request: R): Promise<z.infer<(typeof launcherResults)[R['op']]>> {
    const run = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      this.socket.ref();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await new Promise<unknown>((resolve, reject) => {
          this.waiting = { resolve, reject };
          timer = setTimeout(() => this.fail(new Error('Launcher request timed out; outcome unknown')), LAUNCHER_REQUEST_TIMEOUT_MS);
          this.socket.write(`${JSON.stringify(request)}\n`);
        });
        return launcherResults[request.op].parse(raw);
      } finally {
        clearTimeout(timer);
        this.socket.unref();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  startWorker(spec: LauncherWorkerSpec): Promise<LauncherWorkerHandle> { return this.call({ op: 'startWorker', spec }); }
  async stopWorker(id: string): Promise<void> { await this.call({ op: 'stopWorker', id }); }

  networkName(spec: LauncherNetworkSpec): string { return launcherNetworkName(spec); }
  unitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string { return launcherUnitName(kind, ownerId); }
  previewOwnership(): LauncherPreviewOwnership | null {
    const ownership = this.configuration.previewOwnership;
    if (process.getuid?.() === ownership.uid && process.getgid?.() === ownership.gid) return null;
    if (process.getuid?.() !== 0) throw new Error('Preview copy process must share the launcher preview uid/gid or run as root');
    return ownership;
  }
  async purgeOwner(family: LauncherFamily, ownerId: string): Promise<void> { await this.call({ op: 'purgeOwner', family, ownerId }); }
  async armHardExitCleanup(family: LauncherFamily, ownerId: string): Promise<void> { await this.call({ op: 'armHardExitCleanup', family, ownerId }); }
  async disarmHardExitCleanup(family: LauncherFamily, ownerId: string): Promise<void> { await this.call({ op: 'disarmHardExitCleanup', family, ownerId }); }
  createNetwork(spec: LauncherNetworkSpec): Promise<LauncherNetworkHandle> { return this.call({ op: 'createNetwork', spec }); }
  removeNetwork(handle: LauncherNetworkHandle): Promise<boolean> { return this.call({ op: 'removeNetwork', handle }); }
  removeNetworkBefore(handle: LauncherNetworkHandle, deadlineMs: number): Promise<boolean> { return this.call({ op: 'removeNetworkBefore', handle, deadlineMs }); }
  startUnit(spec: LauncherUnitSpec, networks: readonly LauncherNetworkHandle[]): Promise<LauncherUnitHandle> { return this.call({ op: 'startUnit', spec, networks: [...networks] }); }
  async awaitUnitReady(handle: LauncherUnitHandle, timeoutMs?: number): Promise<void> { await this.call({ op: 'awaitUnitReady', handle, timeoutMs }); }
  async stopUnit(handle: LauncherUnitHandle, reason: LauncherStopReason): Promise<void> { await this.call({ op: 'stopUnit', handle, reason }); }
  createWorkspace(ownerId: string): Promise<LauncherWorkspaceHandle> { return this.call({ op: 'createWorkspace', ownerId }); }
  async removeWorkspace(handle: LauncherWorkspaceHandle): Promise<void> { await this.call({ op: 'removeWorkspace', handle }); }
  listUnits(kind?: LauncherUnitKind): Promise<LauncherUnitSummary[]> { return this.call({ op: 'listUnits', kind }); }
  async reconcileOrphans(): Promise<number> {
    return this.call({ op: 'reconcileOrphans' });
  }
}
