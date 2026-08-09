import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, ToolExecutor } from '../core/types.js';
import {
  drainLines,
  encodeMessage,
  isToolCallResponse,
  isWorkerHello,
  type ToolCallResponse,
} from './containerProtocol.js';

/** Image tag the worker Dockerfile builds to. */
export const DEFAULT_WORKER_IMAGE = 'atoma-worker:latest';

/**
 * `docker run` arguments that carry the isolation. Exported so a test can
 * assert them rather than trusting a comment — every one of them was
 * verified against a real container before this file existed.
 */
export function workerRunArgs(opts: {
  image: string;
  workspaceHostPath: string;
  memory?: string;
  cpus?: string;
}): string[] {
  return [
    'run',
    '--rm',
    '-i',
    // NO NETWORK ROUTE OUT. The container keeps its own loopback — verified:
    // a server started inside is reachable from inside — so the HTTP bucket
    // (`start_node_server` + `fetch_url` at 127.0.0.1) works unchanged, while
    // the control plane is unreachable: `host.docker.internal` does not even
    // resolve. This is the network half of invariant T1
    // (docs/saas-architecture.md) and it costs nothing.
    '--network',
    'none',
    // ONLY the workspace. The atom registry, the skill bodies, the ledger and
    // other runs' traces are simply not on this filesystem, so the
    // `../../atoma-build.db` walk that works today finds nothing.
    '-v',
    `${opts.workspaceHostPath}:/workspace`,
    '-w',
    '/workspace',
    // Drop every capability and forbid regaining privilege: nothing the
    // builtins do needs either, and a container that can re-acquire them is
    // one kernel bug away from not being a boundary.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // Bounds, so a runaway build cannot take the host down with it. A run
    // already has a wall-clock budget; this is the resource equivalent.
    '--memory',
    opts.memory ?? '2g',
    '--cpus',
    opts.cpus ?? '2',
    opts.image,
  ];
}

/**
 * A `ToolExecutor` whose tools run inside a container.
 *
 * Drop-in for `InMemoryToolRegistry`: the interface is two methods, which is
 * why this seam was available at all. The control plane keeps the supervise
 * loop, the LLM calls and every store; only the side-effecting half moves.
 *
 * NOT WIRED INTO A RUN YET, deliberately. This is the isolation primitive and
 * its proof; adopting it as the default for `runTask` is a separate change
 * with its own measurement (image build cost, per-call latency across the
 * pipe, and what it does to the burn-in curve).
 */
export class ContainerToolExecutor implements ToolExecutor {
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private declarations: Tool[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      workspaceHostPath: string;
      image?: string;
      /** Per-call ceiling. A wedged tool must not hold the run open. */
      callTimeoutMs?: number;
      startTimeoutMs?: number;
      docker?: string;
    }
  ) {}

  /** Boot the container and wait for its hello. Idempotent. */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const args = workerRunArgs({
        image: this.opts.image ?? DEFAULT_WORKER_IMAGE,
        workspaceHostPath: this.opts.workspaceHostPath,
      });
      const child = spawn(this.opts.docker ?? 'docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;

      let stderr = '';
      const startMs = this.opts.startTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        reject(
          new Error(`worker container did not report ready in ${startMs}ms: ${stderr.slice(-400)}`)
        );
        this.stop();
      }, startMs);
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
        if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        const { messages, rest } = drainLines(this.buffer);
        this.buffer = rest;
        for (const m of messages) {
          if (isWorkerHello(m)) {
            this.declarations = m.tools;
            clearTimeout(timer);
            resolve();
          } else if (isToolCallResponse(m)) {
            this.settle(m);
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Fail every in-flight call rather than leaving them pending: a dead
        // container must surface as an error the supervise loop can act on,
        // never as a run that hangs forever (the failure mode the CLI
        // transport deadline exists to prevent).
        const err = new Error(`worker container exited (code ${code}): ${stderr.slice(-400)}`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        reject(err);
      });
    });
    return this.readyPromise;
  }

  private settle(res: ToolCallResponse): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error ?? 'tool failed in worker'));
  }

  /** Declarations announced by the WORKER — the image is the authority. */
  toolDeclarations(): Tool[] {
    return [...this.declarations];
  }

  has(name: string): boolean {
    return this.declarations.some((d) => d.name === name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child?.stdin) throw new Error('worker container is not running');
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.opts.callTimeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`tool "${name}" timed out after ${timeoutMs}ms in the worker`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin!.write(encodeMessage({ id, name, args }));
    });
  }

  /** Close stdin so the worker cleans up, then make sure the container dies. */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }
    // `docker run --rm` tears the container down when the process exits;
    // SIGTERM (not SIGKILL) so the worker's own cleanup gets its chance —
    // the same lesson as the burn-in harness, where group SIGKILL leaked
    // nine puppeteer processes and SIGTERM leaked none.
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
