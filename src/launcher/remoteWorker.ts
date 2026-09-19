import type { ProjectWorkspaceIdentity } from '../contracts/launcherVolumes.js';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolExecutor } from '../core/types.js';
import { SocketLauncher } from './client.js';
import { encodeMessage, drainLines, isWorkerHello, isToolCallResponse, WORKER_FRAME_BYTES } from '../contracts/workerProtocol.js';

/** Tool calls never use the serial lifecycle channel. A broken stream is terminal. */
export class RemoteWorkerExecutor implements ToolExecutor {
  private launcher?: SocketLauncher;
  private socket?: Socket;
  private id?: string;
  private ready?: Promise<void>;
  private failure?: Error;
  private declarations: Tool[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  constructor(private readonly options: {
    endpoint: string; workspaceId?: string; project?: ProjectWorkspaceIdentity; workspaceHostPath: string; image: string;
    ownerId?: string; proxiedEgress?: boolean; callTimeoutMs?: number; startTimeoutMs?: number;
    forwardWorkerLogs?: boolean;
  }) {}

  start(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return this.ready ??= this.open();
  }
  private async open(): Promise<void> {
    try {
      if (!path.isAbsolute(this.options.endpoint)) throw new Error('Launcher endpoint must be absolute');
      this.launcher = await SocketLauncher.connect(this.options.endpoint);
      this.assertAlive();
      if (this.launcher.configuration.image !== this.options.image) throw new Error('Launcher worker image mismatch');
      const handle = await this.launcher.startWorker({
        ownerId: this.options.ownerId ?? randomUUID(), workspaceId: this.options.workspaceId, project: this.options.project,
        egress: this.options.proxiedEgress ?? false,
      });
      this.id = handle.id;
      this.assertAlive();
      if (path.resolve(handle.workspaceHostPath) !== path.resolve(this.options.workspaceHostPath)) throw new Error('Launcher workspace mapping mismatch');
      const socket = this.socket = createConnection(handle.socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        let greeted = false;
        const timer = setTimeout(() => { const error = new Error('Worker socket readiness timed out'); this.fail(error); reject(error); }, this.options.startTimeoutMs ?? 60_000);
        const failed = () => { clearTimeout(timer); const error = new Error('Worker socket closed'); this.fail(error); reject(error); };
        socket.on('error', failed);
        socket.on('close', failed);
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > WORKER_FRAME_BYTES) { failed(); return; }
          const parsed = drainLines(buffer);
          buffer = parsed.rest;
          for (const message of parsed.messages) {
            if (!greeted && isWorkerHello(message)) {
              this.declarations = message.tools; greeted = true; clearTimeout(timer); resolve();
            } else if (greeted && isToolCallResponse(message)) {
              const pending = this.pending.get(message.id);
              this.pending.delete(message.id);
              if (message.ok) pending?.resolve(message.result);
              else pending?.reject(new Error(message.error ?? 'Worker tool failed'));
            } else if (greeted && typeof message === 'object' && message !== null && 'log' in message && typeof message.log === 'string') {
              if (this.options.forwardWorkerLogs !== false) process.stderr.write(message.log);
            } else { failed(); return; }
          }
        });
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Worker start failed'));
      // Even an unknown start outcome belongs to this connection; closing it reaps it.
      if (this.id) await this.launcher?.stopWorker(this.id).catch(() => undefined);
      this.launcher?.close();
      throw error;
    }
  }
  private assertAlive(): void { if (this.failure) throw this.failure; }
  private fail(error: Error): void {
    this.failure ??= error;
    this.socket?.destroy();
    for (const call of this.pending.values()) call.reject(this.failure);
    this.pending.clear();
  }
  toolDeclarations(): Tool[] { return [...this.declarations]; }
  has(name: string): boolean { return this.declarations.some(tool => tool.name === name); }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    if (this.failure || !this.socket) throw this.failure ?? new Error('Worker unavailable');
    const id = this.nextId++;
    const frame = encodeMessage({ id, name, args });
    if (Buffer.byteLength(frame) > WORKER_FRAME_BYTES || this.pending.size >= 256 || this.socket.writableLength > WORKER_FRAME_BYTES) throw new Error('Worker transport capacity exceeded');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Worker tool ${name} timed out`)); }, this.options.callTimeoutMs ?? 120_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket!.write(frame);
    });
  }
  stop(): void { this.fail(new Error('Worker stopped')); }
  async drain(): Promise<void> {
    this.stop();
    await this.ready?.catch(() => undefined);
    if (this.id) {
      if (!this.launcher) throw new Error('Worker lifecycle connection lost');
      await this.launcher.stopWorker(this.id);
      this.id = undefined;
    }
    this.launcher?.close();
  }
}
