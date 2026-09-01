import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  ContainerLauncher,
  LauncherNetworkHandle,
  LauncherNetworkSpec,
  LauncherOwnerId,
  LauncherStopReason,
  LauncherUnitHandle,
  LauncherUnitKind,
  LauncherUnitSpec,
  LauncherUnitSummary,
} from '../contracts/launcher.js';

/**
 * THE DOCKER BACKEND — the one component that speaks to the engine.
 *
 * It implements `ContainerLauncher` (`src/contracts/launcher.ts`), which is
 * where the invariants and the reasons live. This file holds only how those
 * operations are performed against Docker, and the flags ARE the isolation:
 * every one of them was verified against a real container before it was
 * written down, and `tests/egress-sidecar-lifecycle.test.ts` asserts the exact
 * command sequence rather than trusting this comment.
 *
 * IN-PROCESS FOR NOW, AND THAT IS A STATED HALFWAY POINT. The recorded target
 * is a launcher running as its own container under its own OS identity, with
 * the socket mounted only there, reached over a permissioned Unix socket. Two
 * things had to come first: a contract narrow enough that the transport can
 * change without any caller changing, and one implementation proving the
 * contract against behaviour that already works. Until the move happens, "the
 * launcher owns the images and the flags" is a code-organisation property
 * rather than a security boundary — it becomes the boundary the day this class
 * runs somewhere else. `src/launcher/AGENTS.md` records what that will take.
 */

const run = promisify(execFile);

const PROXY_PORT = 3128;
const PROXY_MEMORY = '256m';
const PROXY_CPUS = '0.5';
const PROXY_PIDS = '64';

export const EGRESS_NETWORK_REMOVE_ATTEMPTS = 25;
export const EGRESS_NETWORK_REMOVE_RETRY_MS = 200;
export const EGRESS_ASYNC_CLEANUP_BUDGET_MS = 3_500;
export const EGRESS_EXIT_REMOVE_ATTEMPTS = 2;
export const EGRESS_EXIT_REMOVE_RETRY_MS = 100;

const DOCKER_COMMAND_TIMEOUT_MS = 10_000;
const DOCKER_CLEANUP_COMMAND_TIMEOUT_MS = 750;
const DOCKER_EXIT_COMMAND_TIMEOUT_MS = 250;

/** The label every object carries, so orphans are findable by one query. */
export const LAUNCHER_OWNER_LABEL = 'dev.atoma.owner';
export const LAUNCHER_RUN_LABEL = 'dev.atoma.run';

/** Docker-safe, collision-resistant suffix for every per-owner object name. */
export function launcherObjectId(ownerId: string): string {
  const readable = ownerId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 30) || 'run';
  const hash = createHash('sha256').update(ownerId).digest('hex').slice(0, 10);
  return `${readable}-${hash}`;
}

export type AsyncDockerRunner = (args: string[]) => Promise<string>;
export type SyncDockerRunner = (args: string[]) => string;
export type SyncSleeper = (delayMs: number) => void;

async function defaultDocker(args: string[]): Promise<string> {
  const cleanupCommand =
    args[0] === 'rm' ||
    (args[0] === 'network' && (args[1] === 'rm' || args[1] === 'inspect'));
  const { stdout } = await run('docker', args, {
    maxBuffer: 4 * 1024 * 1024,
    timeout: cleanupCommand
      ? DOCKER_CLEANUP_COMMAND_TIMEOUT_MS
      : DOCKER_COMMAND_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function quiet(runDocker: AsyncDockerRunner, args: string[]): Promise<void> {
  try {
    await runDocker(args);
  } catch {
    /* teardown is best-effort: a missing object is the desired end state */
  }
}

function dockerSync(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    // Keep stderr captured (never printed): cleanup must distinguish an
    // already-absent network from a transient daemon failure worth retrying.
    stdio: ['ignore', 'pipe', 'pipe'],
    // `process.on('exit')` is synchronous. A dead daemon must not turn a
    // watchdog exit into minutes of blocking cleanup attempts.
    timeout: DOCKER_EXIT_COMMAND_TIMEOUT_MS,
  }).trim();
}

const syncWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(delayMs: number): void {
  Atomics.wait(syncWaitBuffer, 0, 0, delayMs);
}

function trySync(
  runSync: SyncDockerRunner,
  args: string[]
):
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: unknown } {
  try {
    return { ok: true, stdout: runSync(args) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function launcherErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: unknown }).stderr;
  const renderedStderr =
    typeof stderr === 'string'
      ? stderr
      : Buffer.isBuffer(stderr)
        ? stderr.toString('utf8')
        : '';
  return `${error.message}\n${renderedStderr}`;
}

function isMissingNetworkError(error: unknown): boolean {
  return /no such network|network .* not found/i.test(launcherErrorText(error));
}

/**
 * A hard exit cannot await Docker's endpoint teardown, but it can make the
 * same bounded retry the async path makes. Inspecting on every attempt also
 * catches a worker that had not exited yet: every container on this per-owner
 * network is safe to force-remove.
 */
function removeNetworkSync(
  network: string,
  runSync: SyncDockerRunner,
  waitSync: SyncSleeper
): void {
  for (let attempt = 0; attempt < EGRESS_EXIT_REMOVE_ATTEMPTS; attempt++) {
    const attached = trySync(runSync, [
      'network',
      'inspect',
      '--format',
      '{{range .Containers}}{{.Name}} {{end}}',
      network,
    ]);
    if (!attached.ok && isMissingNetworkError(attached.error)) return;
    if (attached.ok) {
      for (const name of attached.stdout.split(/\s+/).filter(Boolean)) {
        trySync(runSync, ['rm', '-f', name]);
      }
    }
    const removed = trySync(runSync, ['network', 'rm', network]);
    if (removed.ok || isMissingNetworkError(removed.error)) return;
    if (attempt + 1 < EGRESS_EXIT_REMOVE_ATTEMPTS) {
      waitSync(EGRESS_EXIT_REMOVE_RETRY_MS);
    }
  }
}

/**
 * Registry of per-owner Docker objects that must survive no control-plane
 * exit. Injectable sync runner keeps the hard-exit command sequence
 * unit-testable without requiring Docker.
 */
export class LauncherExitRegistry {
  private readonly active = new Map<
    string,
    { readonly proxyHost: string; readonly uplinkNetwork: string }
  >(); // internal network → per-owner Docker objects

  track(network: string, proxyHost: string, uplinkNetwork: string): void {
    this.active.set(network, { proxyHost, uplinkNetwork });
  }

  untrack(network: string): void {
    this.active.delete(network);
  }

  cleanup(runSync: SyncDockerRunner, waitSync: SyncSleeper = sleepSync): void {
    for (const [network, { proxyHost, uplinkNetwork }] of this.active) {
      trySync(runSync, ['rm', '-f', proxyHost]);
      removeNetworkSync(network, runSync, waitSync);
      removeNetworkSync(uplinkNetwork, runSync, waitSync);
    }
    this.active.clear();
  }
}

const exitRegistry = new LauncherExitRegistry();

/**
 * Hard-exit cleanup for the runner watchdog / process crash.
 *
 * Async teardown cannot run from `process.on('exit')`. Each network belongs to
 * exactly one owner, so it is safe to force-remove every container still
 * attached before removing the network. This is the Docker-side sibling of
 * ToolSandbox's synchronous child reaper, and it is armed at MODULE LOAD:
 * anything that changes when this module is imported changes when the net
 * exists.
 */
process.on('exit', () => exitRegistry.cleanup(dockerSync));

/**
 * Block until a unit's own log says it is serving.
 *
 * Reading the container's output rather than probing a port: these units sit
 * on `--internal` networks the host cannot reach, so there is nothing to
 * connect to from here — the log line is the only readiness signal available.
 */
async function waitForUnitLog(
  runDocker: AsyncDockerRunner,
  name: string,
  marker: RegExp,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let logs = '';
    try {
      // BOTH STREAMS. `docker logs` mirrors the container's stdout and stderr
      // onto its own, and the proxy deliberately logs to STDERR — stdout is
      // the stdio protocol for the worker image. Reading only stdout here made
      // readiness never arrive, and the symptom was an empty node_modules
      // three layers away.
      const { stdout, stderr } = await run('docker', ['logs', name], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 2_000,
      });
      logs = stdout + stderr;
    } catch {
      /* container not up yet */
    }
    if (marker.test(logs)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `unit ${name} did not report ready in ${timeoutMs}ms: ${logs.slice(-300)}`
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function removeNetworkWithRetry(
  network: string,
  runDocker: AsyncDockerRunner,
  sleep: (delayMs: number) => Promise<void>,
  deadlineMs = Number.POSITIVE_INFINITY,
  now: () => number = Date.now
): Promise<boolean> {
  for (let attempt = 0; attempt < EGRESS_NETWORK_REMOVE_ATTEMPTS; attempt++) {
    if (now() >= deadlineMs) return false;
    try {
      await runDocker(['network', 'rm', network]);
      return true;
    } catch (removeError) {
      if (isMissingNetworkError(removeError)) return true;
      // A failed remove because the network is already absent is success, not
      // a reason to spend the entire retry budget.
      try {
        await runDocker(['network', 'inspect', network]);
      } catch (inspectError) {
        if (isMissingNetworkError(inspectError)) return true;
      }
      if (now() >= deadlineMs) return false;
      if (attempt + 1 < EGRESS_NETWORK_REMOVE_ATTEMPTS) {
        await sleep(
          Math.max(0, Math.min(EGRESS_NETWORK_REMOVE_RETRY_MS, deadlineMs - now()))
        );
      }
    }
  }
  return false;
}

export interface DockerLauncherOptions {
  /**
   * The image the launcher starts units from. IT IS THE LAUNCHER'S, not a
   * caller's: a spec carries no image, which is what stops this interface
   * from being a remote shell.
   */
  readonly image: string;
  /** Injectable Docker boundary for command-level lifecycle tests. */
  readonly runDocker?: AsyncDockerRunner;
  /** Readiness is log-based in production; tests can acknowledge it directly. */
  readonly waitUntilReady?: (name: string) => Promise<void>;
  /** Injectable so retry tests do not wait five real seconds. */
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** Injectable monotonic-enough wall clock for cleanup deadline tests. */
  readonly now?: () => number;
}

export class DockerLauncher implements ContainerLauncher {
  private readonly image: string;
  private readonly runDocker: AsyncDockerRunner;
  private readonly waitUntilReady: ((name: string) => Promise<void>) | undefined;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: DockerLauncherOptions) {
    this.image = options.image;
    this.runDocker = options.runDocker ?? defaultDocker;
    this.waitUntilReady = options.waitUntilReady;
    this.sleep =
      options.sleep ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.now = options.now ?? Date.now;
  }

  /** The deadline every bounded teardown in one call shares. */
  private cleanupDeadline(): number {
    return this.now() + EGRESS_ASYNC_CLEANUP_BUDGET_MS;
  }

  networkName(spec: LauncherNetworkSpec): string {
    const id = launcherObjectId(spec.ownerId);
    return spec.kind === 'internal' ? `atoma-egress-${id}` : `atoma-uplink-${id}`;
  }

  unitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string {
    const id = launcherObjectId(ownerId);
    // One name per kind. `egress-proxy` keeps its historical spelling, which
    // is also the hostname the run reaches it by.
    return kind === 'egress-proxy' ? `atoma-proxy-${id}` : `atoma-${kind}-${id}`;
  }

  async purgeOwner(ownerId: LauncherOwnerId): Promise<void> {
    await quiet(this.runDocker, ['rm', '-f', this.unitName('egress-proxy', ownerId)]);
    await quiet(this.runDocker, [
      'network',
      'rm',
      this.networkName({ kind: 'internal', ownerId }),
    ]);
    await quiet(this.runDocker, [
      'network',
      'rm',
      this.networkName({ kind: 'uplink', ownerId }),
    ]);
  }

  armHardExitCleanup(ownerId: LauncherOwnerId): void {
    exitRegistry.track(
      this.networkName({ kind: 'internal', ownerId }),
      this.unitName('egress-proxy', ownerId),
      this.networkName({ kind: 'uplink', ownerId })
    );
  }

  disarmHardExitCleanup(ownerId: LauncherOwnerId): void {
    exitRegistry.untrack(this.networkName({ kind: 'internal', ownerId }));
  }

  async createNetwork(spec: LauncherNetworkSpec): Promise<LauncherNetworkHandle> {
    const name = this.networkName(spec);
    const id = launcherObjectId(spec.ownerId);
    if (spec.kind === 'internal') {
      // `--internal` alone still assigns the bridge a host gateway address;
      // Docker explicitly documents that containers can reach host services
      // bound there. Gateway mode `isolated` (Engine 28+) removes that
      // address, so the proxy is genuinely the run's only reachable peer.
      // Older engines fail this create command closed instead of silently
      // weakening the isolation.
      await this.runDocker([
        'network',
        'create',
        '--internal',
        '--label',
        `${LAUNCHER_OWNER_LABEL}=egress`,
        '--label',
        `${LAUNCHER_RUN_LABEL}=${id}`,
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv4=isolated',
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv6=isolated',
        name,
      ]);
    } else {
      // A user-defined bridge gets outbound NAT like Docker's default bridge,
      // without being shared with unrelated containers.
      await this.runDocker([
        'network',
        'create',
        '--label',
        `${LAUNCHER_OWNER_LABEL}=egress`,
        '--label',
        `${LAUNCHER_RUN_LABEL}=${id}`,
        name,
      ]);
    }
    return { kind: spec.kind, ownerId: spec.ownerId, name };
  }

  async removeNetwork(handle: LauncherNetworkHandle): Promise<boolean> {
    return removeNetworkWithRetry(
      handle.name,
      this.runDocker,
      this.sleep,
      this.cleanupDeadline(),
      this.now
    );
  }

  /**
   * Remove a network against a deadline the CALLER owns, so several removals
   * in one teardown share one budget instead of each getting a fresh one.
   */
  async removeNetworkBefore(
    handle: LauncherNetworkHandle,
    deadlineMs: number
  ): Promise<boolean> {
    return removeNetworkWithRetry(
      handle.name,
      this.runDocker,
      this.sleep,
      deadlineMs,
      this.now
    );
  }

  async startUnit(
    spec: LauncherUnitSpec,
    networks: readonly LauncherNetworkHandle[]
  ): Promise<LauncherUnitHandle> {
    const name = this.unitName(spec.kind, spec.ownerId);
    const id = launcherObjectId(spec.ownerId);
    const attach = networks[0];
    if (!attach) throw new Error('a unit must be attached to at least one network');
    await this.runDocker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${LAUNCHER_OWNER_LABEL}=egress`,
      '--label',
      `${LAUNCHER_RUN_LABEL}=${id}`,
      '--network',
      attach.name,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      // The proxy is part of the untrusted run's resource envelope too. A
      // connection storm must not turn this small relay into a host-wide DoS.
      '--memory',
      PROXY_MEMORY,
      '--memory-swap',
      PROXY_MEMORY,
      '--cpus',
      PROXY_CPUS,
      '--pids-limit',
      PROXY_PIDS,
      '-e',
      `ATOMA_EGRESS_PORT=${PROXY_PORT}`,
      '-e',
      `ATOMA_EGRESS_ALLOWLIST=${spec.allowlist.join(',')}`,
      ...(spec.allowedPorts ? ['-e', `ATOMA_EGRESS_PORTS=${spec.allowedPorts.join(',')}`] : []),
      this.image,
      'node',
      '/app/dist/tools/egressProxy.js',
    ]);
    // The proxy's SECOND leg. This per-owner bridge gives it a route out
    // without making it reachable from Docker's shared default bridge.
    for (const extra of networks.slice(1)) {
      await this.runDocker(['network', 'connect', extra.name, name]);
    }
    return { kind: spec.kind, ownerId: spec.ownerId, name };
  }

  async awaitUnitReady(handle: LauncherUnitHandle, timeoutMs = 15_000): Promise<void> {
    if (this.waitUntilReady) {
      await this.waitUntilReady(handle.name);
      return;
    }
    // WAIT FOR IT TO LISTEN. `docker run -d` returns as soon as the container
    // is created, not when the process inside is serving — and the run's very
    // first `npm install` hits the proxy immediately. Found the hard way: the
    // hand-driven reproduction had a `sleep 2` and worked, the orchestrated
    // path had none and npm failed with an empty node_modules while every
    // other check passed, which reads like a policy problem and is not one.
    await waitForUnitLog(this.runDocker, handle.name, /\[egress\] listening on/, timeoutMs);
  }

  async stopUnit(handle: LauncherUnitHandle, _reason: LauncherStopReason): Promise<void> {
    await quiet(this.runDocker, ['rm', '-f', handle.name]);
  }

  async listUnits(kind?: LauncherUnitKind): Promise<LauncherUnitSummary[]> {
    const stdout = await this.runDocker([
      'ps',
      '-a',
      '--filter',
      `label=${LAUNCHER_OWNER_LABEL}=egress`,
      '--format',
      '{{.Names}}\t{{.State}}',
    ]);
    const units: LauncherUnitSummary[] = [];
    for (const line of stdout.split('\n').map((row) => row.trim()).filter(Boolean)) {
      const [name = '', state = ''] = line.split('\t');
      if (!name.startsWith('atoma-proxy-')) continue;
      if (kind && kind !== 'egress-proxy') continue;
      units.push({
        kind: 'egress-proxy',
        // The owner id is NOT recoverable from the name — it is hashed — so
        // the name stands in for it. A caller that needs the original owner
        // holds it already; a reconciler only needs to remove the object.
        ownerId: name,
        name,
        running: state === 'running',
      });
    }
    return units;
  }

  async reconcileOrphans(): Promise<number> {
    let removed = 0;
    for (const unit of await this.listUnits()) {
      await quiet(this.runDocker, ['rm', '-f', unit.name]);
      removed += 1;
    }
    const stdout = await this.runDocker([
      'network',
      'ls',
      '--filter',
      `label=${LAUNCHER_OWNER_LABEL}=egress`,
      '--format',
      '{{.Name}}',
    ]);
    for (const name of stdout.split('\n').map((row) => row.trim()).filter(Boolean)) {
      const gone = await removeNetworkWithRetry(
        name,
        this.runDocker,
        this.sleep,
        this.cleanupDeadline(),
        this.now
      );
      if (gone) removed += 1;
    }
    return removed;
  }
}

/**
 * Does this error mean the engine is too old for an isolated bridge gateway?
 *
 * Exported because the CALLER decides what to say about it: an engine that
 * cannot remove the bridge's host gateway must fail closed rather than
 * silently serve a run a network that reaches host services.
 */
export function isIsolatedGatewayUnsupported(error: unknown): boolean {
  return /gateway[_ -]mode|isolated.*(?:invalid|unknown|unsupported)/i.test(
    launcherErrorText(error)
  );
}
