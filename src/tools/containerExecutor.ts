import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
export type ContainerSpawn = typeof spawn;

/**
 * Match bind-mount ownership on native Linux; Docker Desktop also accepts it.
 *
 * ONE definition, in `src/launcher`, which is the component that owns
 * container concerns. Re-exported here under the name this subsystem's
 * callers and tests already use.
 */
import { hostContainerUser } from '../launcher/docker.js';
export { hostContainerUser };

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
  /** Numeric uid:gid allowed to write the host-owned bind mount. */
  user?: string;
  /**
   * EGRESS MODE. When set, the run joins a per-run Docker network created
   * with `--internal` AND bridge gateway mode `isolated`
   * instead of getting no network at all, and `HTTP_PROXY` points at the one
   * peer on it. Measured, which is why the shape is this and not `bridge`:
   *   --network none      control plane blocked, internet blocked
   *   default bridge      control plane REACHED, internet reached
   *   isolated internal  control plane blocked, internet blocked
   * Plain `--internal` is NOT enough: its bridge gateway can reach host
   * services. Removing that gateway makes the network equivalent to `none`
   * for host/external routes while still BEING a LAN, so a proxy attached
   * to it and to an external network can
   * carry egress selectively — and `decideEgress` is the whole of what it
   * carries. Plain `bridge` is never an option: it hands the run the control
   * plane, the same reachability that made an HTTP-served launch token
   * worthless.
   */
  egress?: { network: string; proxyHost: string; proxyPort: number };
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
    opts.egress ? opts.egress.network : 'none',
    ...(opts.egress
      ? [
          '-e',
          `HTTP_PROXY=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `HTTPS_PROXY=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `npm_config_proxy=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `npm_config_https_proxy=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          // The HTTP bucket probes servers inside this SAME container.
          // Loopback must never leave through the default-deny proxy.
          '-e',
          'NO_PROXY=127.0.0.1,localhost,::1',
          '-e',
          'no_proxy=127.0.0.1,localhost,::1',
          // Node 22+ does not consult HTTP_PROXY for fetch() unless this is
          // explicitly enabled. Without it fetch_url had no route on the
          // internal network even for allowlisted hosts.
          '-e',
          'NODE_USE_ENV_PROXY=1',
        ]
      : []),
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
    ...(opts.user ? ['--user', opts.user, '-e', 'HOME=/tmp/atoma-home'] : []),
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
 * OPT-IN, not the default: `runTask` selects it on `--container` /
 * `ATOMA_CONTAINER=1` (see `src/run/toolBackend.ts`). It is proven — a real
 * task ran end to end through it — but making it the default is a separate
 * decision that needs the burn-in curve, not one measurement.
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
      /** Opt into proxied egress; omit for the default no-network run. */
      egress?: { network: string; proxyHost: string; proxyPort: number };
      /** Per-call ceiling. A wedged tool must not hold the run open. */
      callTimeoutMs?: number;
      startTimeoutMs?: number;
      docker?: string;
      /** Injectable process spawn for lifecycle tests. */
      spawnFn?: ContainerSpawn;
      /** Override for tests/deployments; defaults to the host uid:gid. */
      containerUser?: string;
      /** Mirror the worker's stderr onto the host's. Default true. */
      forwardWorkerLogs?: boolean;
    }
  ) {}

  /** Boot the container and wait for its hello. Idempotent. */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const user = this.opts.containerUser ?? hostContainerUser();
      // THE HOST CREATES THE MOUNT SOURCE, before the engine sees it.
      //
      // A bind-mount source that does not exist is created BY THE DAEMON, as
      // root. The worker then runs as the host user (`hostContainerUser`) and
      // finds `/workspace` owned by root, mode 755: every write is refused,
      // and the L1 agent — which is told nothing about the reason — improvises
      // in `/tmp`, so the deliverable never lands where delivery, publication
      // and the preview look for it. Measured on a real project run
      // (2026-09-02): `drwxr-xr-x root root workspace` beside siblings owned by
      // the host user, `ln: Permission denied` in the worker log, and an
      // artifact manifest naming a file that did not exist.
      //
      // The local sandbox creates its root itself; in container mode that
      // sandbox lives INSIDE the worker and cannot create the host directory
      // it is mounted from. The operator path never hit this because its
      // workspace persists across runs; a project run gets a fresh path every
      // time, so every containerised project run on a fresh workspace was
      // read-only to its own agent.
      try {
        mkdirSync(this.opts.workspaceHostPath, { recursive: true });
      } catch (error) {
        reject(
          new Error(
            `cannot create the worker workspace on the host at ${this.opts.workspaceHostPath}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
        return;
      }
      const args = workerRunArgs({
        image: this.opts.image ?? DEFAULT_WORKER_IMAGE,
        workspaceHostPath: this.opts.workspaceHostPath,
        ...(user ? { user } : {}),
        ...(this.opts.egress ? { egress: this.opts.egress } : {}),
      });
      const child = (this.opts.spawnFn ?? spawn)(this.opts.docker ?? 'docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;

      let stderr = '';
      const startMs = this.opts.startTimeoutMs ?? 60_000;
      // Forward the worker's own log lines to the host console. Without this
      // a containerised run prints no `[tool:write_file] …` at all and reads
      // as if nothing happened between LLM calls — the trace still has every
      // tool event (onToolInvocation fires on the control plane), but the
      // operator watching a terminal loses the live signal. Safe for the
      // burn-in harness, which greps a combined log: the worker's lines
      // match none of the markers `parseRunLog` looks for, and they arrive
      // on STDERR so they cannot corrupt the stdio protocol on stdout.
      const forwardLogs = this.opts.forwardWorkerLogs !== false;
      const timer = setTimeout(() => {
        reject(
          new Error(`worker container did not report ready in ${startMs}ms: ${stderr.slice(-400)}`)
        );
        this.stop();
      }, startMs);
      child.stderr?.on('data', (c: Buffer) => {
        const text = c.toString();
        stderr += text;
        if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
        if (forwardLogs) process.stderr.write(text);
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
        if (this.child === child) this.child = null;
        this.readyPromise = null;
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
    this.readyPromise = null;
    const stopped = new Error('worker container stopped');
    for (const [, pending] of this.pending) pending.reject(stopped);
    this.pending.clear();
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
