import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ContainerLauncher,
  LauncherFamily,
  LauncherNetworkHandle,
  LauncherNetworkSpec,
  LauncherOwnerId,
  LauncherStopReason,
  LauncherUnitHandle,
  LauncherUnitKind,
  LauncherUnitSpec,
  LauncherUnitSummary,
  LauncherWorkspaceHandle,
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
export const LAUNCHER_PREVIEW_LABEL = 'dev.atoma.preview';

/**
 * The preview application's envelope. Every value is a REFUSAL of something a
 * generated application might otherwise do to the host it runs on, and none of
 * them is a caller's to choose.
 */
const PREVIEW_APP_MEMORY = '512m';
const PREVIEW_APP_CPUS = '0.5';
const PREVIEW_APP_PIDS = '64';
const PREVIEW_APP_NOFILE = '1024';
const PREVIEW_TMP_SIZE = '64m';
const PREVIEW_DATA_SIZE = '128m';
const PREVIEW_LOG_MAX_SIZE = '1m';
/** Fixed by contract: the app is told PORT and must honour it (design D8). */
export const PREVIEW_APP_PORT = 8080;
/** Where the relay listens inside its own container. */
export const PREVIEW_INGRESS_PORT = 8081;
const PREVIEW_RELAY_MEMORY = '128m';
const PREVIEW_RELAY_CPUS = '0.25';
const PREVIEW_RELAY_PIDS = '32';

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

/**
 * A mount is a WIRE VALUE for the engine, and the engine always speaks POSIX —
 * so a host path is converted rather than passed through. Without this a
 * developer host with backslash separators hands Docker a string it reads as
 * one path component.
 */
function toEnginePath(hostPath: string): string {
  return hostPath.split(path.sep).join('/');
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
    { readonly containers: readonly string[]; readonly networks: readonly string[] }
  >(); // key → the objects one owner left behind

  /**
   * CONTAINERS BEFORE NETWORKS, always. A network with an endpoint still
   * attached refuses removal, so the reverse order spends the whole bounded
   * retry budget losing to a container nobody removed.
   */
  track(key: string, objects: { containers: readonly string[]; networks: readonly string[] }): void {
    this.active.set(key, { containers: [...objects.containers], networks: [...objects.networks] });
  }

  untrack(key: string): void {
    this.active.delete(key);
  }

  cleanup(runSync: SyncDockerRunner, waitSync: SyncSleeper = sleepSync): void {
    for (const [, { containers, networks }] of this.active) {
      for (const container of containers) trySync(runSync, ['rm', '-f', container]);
      for (const network of networks) removeNetworkSync(network, runSync, waitSync);
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
  /**
   * The pinned-by-digest image a preview application runs from. Separate from
   * the worker image on purpose: it carries no browser, no LLM SDK, no store,
   * no source tree and no tool executor.
   */
  readonly previewImage?: string;
  /**
   * The isolation runtime for preview applications. The CALLER decides
   * whether anything but `runsc` is admissible — production requires gVisor
   * with no silent fallback, and the dev escape hatch refuses to boot behind
   * the auth gate.
   */
  readonly previewRuntime?: string;
  /** Numeric uid:gid a preview application runs as. Never root. */
  readonly previewUser?: string;
  /** Where preview workspaces live. The launcher owns the location. */
  readonly workspaceRoot?: string;
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
  private readonly previewImage: string;
  private readonly previewRuntime: string;
  private readonly previewUser: string;
  private readonly workspaceRoot: string;
  private readonly runDocker: AsyncDockerRunner;
  private readonly waitUntilReady: ((name: string) => Promise<void>) | undefined;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: DockerLauncherOptions) {
    this.image = options.image;
    this.previewImage = options.previewImage ?? options.image;
    this.previewRuntime = options.previewRuntime ?? 'runsc';
    this.previewUser = options.previewUser ?? '10001:10001';
    this.workspaceRoot = options.workspaceRoot ?? path.join(homedir(), '.atoma', 'previews');
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
    if (spec.family === 'preview') return `atoma-preview-net-${id}`;
    return spec.kind === 'internal' ? `atoma-egress-${id}` : `atoma-uplink-${id}`;
  }

  unitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string {
    const id = launcherObjectId(ownerId);
    // One name per kind. `egress-proxy` keeps its historical spelling, which
    // is also the hostname the run reaches it by — and is what the app
    // container resolves its relay by, so these names are wire contracts
    // between two containers, not cosmetics.
    if (kind === 'egress-proxy') return `atoma-proxy-${id}`;
    if (kind === 'preview-app') return `atoma-preview-app-${id}`;
    return `atoma-preview-relay-${id}`;
  }

  /** The objects one owner in one family can leave behind, in removal order. */
  private ownedObjects(
    family: LauncherFamily,
    ownerId: LauncherOwnerId
  ): { containers: string[]; networks: string[] } {
    if (family === 'preview') {
      return {
        // The relay first: it is the only thing holding the network open once
        // the app is gone, and it is what a member is still connected to.
        containers: [
          this.unitName('preview-ingress', ownerId),
          this.unitName('preview-app', ownerId),
        ],
        networks: [this.networkName({ family, kind: 'internal', ownerId })],
      };
    }
    return {
      containers: [this.unitName('egress-proxy', ownerId)],
      networks: [
        this.networkName({ family, kind: 'internal', ownerId }),
        this.networkName({ family, kind: 'uplink', ownerId }),
      ],
    };
  }

  async purgeOwner(family: LauncherFamily, ownerId: LauncherOwnerId): Promise<void> {
    const owned = this.ownedObjects(family, ownerId);
    for (const container of owned.containers) {
      await quiet(this.runDocker, ['rm', '-f', container]);
    }
    for (const network of owned.networks) {
      await quiet(this.runDocker, ['network', 'rm', network]);
    }
  }

  armHardExitCleanup(family: LauncherFamily, ownerId: LauncherOwnerId): void {
    exitRegistry.track(`${family}:${ownerId}`, this.ownedObjects(family, ownerId));
  }

  disarmHardExitCleanup(family: LauncherFamily, ownerId: LauncherOwnerId): void {
    exitRegistry.untrack(`${family}:${ownerId}`);
  }

  /** The labels every object of one family carries, so a sweep can find them. */
  private labels(family: LauncherFamily, ownerId: LauncherOwnerId): string[] {
    const id = launcherObjectId(ownerId);
    return family === 'preview'
      ? ['--label', `${LAUNCHER_OWNER_LABEL}=preview`, '--label', `${LAUNCHER_PREVIEW_LABEL}=${id}`]
      : ['--label', `${LAUNCHER_OWNER_LABEL}=egress`, '--label', `${LAUNCHER_RUN_LABEL}=${id}`];
  }

  async createNetwork(spec: LauncherNetworkSpec): Promise<LauncherNetworkHandle> {
    const name = this.networkName(spec);
    const labels = this.labels(spec.family, spec.ownerId);
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
        ...labels,
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv4=isolated',
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv6=isolated',
        name,
      ]);
    } else {
      // A user-defined bridge gets outbound NAT like Docker's default bridge,
      // without being shared with unrelated containers.
      await this.runDocker(['network', 'create', ...labels, name]);
    }
    return { family: spec.family, kind: spec.kind, ownerId: spec.ownerId, name };
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
    const attach = networks[0];
    if (!attach) throw new Error('a unit must be attached to at least one network');
    if (spec.kind !== 'egress-proxy') {
      return this.startPreviewUnit(spec, name, attach, networks.slice(1));
    }
    await this.runDocker([
      'run',
      '-d',
      '--name',
      name,
      ...this.labels('egress', spec.ownerId),
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

  /**
   * The two preview profiles.
   *
   * Everything here is a REFUSAL of something a generated application might
   * otherwise do to the host, and none of it is a caller's to choose: the
   * image, the command, the mount, the environment and the whole resource
   * envelope are derived from the profile.
   */
  private async startPreviewUnit(
    spec: Extract<LauncherUnitSpec, { kind: 'preview-app' | 'preview-ingress' }>,
    name: string,
    attach: LauncherNetworkHandle,
    extraNetworks: readonly LauncherNetworkHandle[]
  ): Promise<LauncherUnitHandle> {
    const labels = this.labels('preview', spec.ownerId);
    if (spec.kind === 'preview-app') {
      const workspace = this.workspacePath(spec.workspace.ownerId);
      await this.runDocker([
        'run',
        '-d',
        '--name',
        name,
        ...labels,
        '--network',
        attach.name,
        // gVisor. Production requires it and there is no silent fallback; the
        // CALLER decides whether a dev runtime is admissible and constructs
        // the launcher accordingly, so an unset runtime here is a bug, not a
        // permission.
        '--runtime',
        this.previewRuntime,
        '--user',
        this.previewUser,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        PREVIEW_APP_MEMORY,
        // Swap equal to memory: otherwise the cap is escapable by swapping.
        '--memory-swap',
        PREVIEW_APP_MEMORY,
        '--cpus',
        PREVIEW_APP_CPUS,
        '--pids-limit',
        PREVIEW_APP_PIDS,
        '--ulimit',
        `nofile=${PREVIEW_APP_NOFILE}`,
        // A read-only root filesystem plus two bounded tmpfs: `/tmp` for what
        // any program expects to be able to write, `/data` for the demo state
        // an application keeps. Both die with the container, which is what
        // makes a restart start again from the immutable copy.
        '--tmpfs',
        `/tmp:rw,noexec,nosuid,size=${PREVIEW_TMP_SIZE}`,
        '--tmpfs',
        `/data:rw,noexec,nosuid,size=${PREVIEW_DATA_SIZE}`,
        '--log-opt',
        `max-size=${PREVIEW_LOG_MAX_SIZE}`,
        '--log-opt',
        'max-file=1',
        // EXACTLY these five. Never a spread of the parent environment: the
        // control plane's own variables are credentials and store paths.
        '-e',
        `PORT=${PREVIEW_APP_PORT}`,
        '-e',
        'HOST=0.0.0.0',
        '-e',
        'NODE_ENV=production',
        '-e',
        'HOME=/tmp',
        '-e',
        'ATOMA_DATA_DIR=/data',
        // The single mount: the filtered copy, writable because the app may
        // keep state — on the COPY, which is deleted at teardown.
        '-v',
        `${toEnginePath(workspace)}:/workspace`,
        '-w',
        '/workspace',
        this.previewImage,
        'node',
        spec.entry,
      ]);
      return { kind: spec.kind, ownerId: spec.ownerId, name };
    }

    // The relay. Its upstream is the app unit of the SAME owner, resolved
    // here rather than accepted from the caller — which is what makes it
    // impossible to point at anything else.
    await this.runDocker([
      'run',
      '-d',
      '--name',
      name,
      ...labels,
      '--network',
      attach.name,
      // Published on LOOPBACK only, on an OS-assigned port. The gateway is
      // the one thing that reaches it; nothing else on the machine should,
      // and no caller chooses the number.
      '-p',
      `127.0.0.1::${PREVIEW_INGRESS_PORT}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      PREVIEW_RELAY_MEMORY,
      '--memory-swap',
      PREVIEW_RELAY_MEMORY,
      '--cpus',
      PREVIEW_RELAY_CPUS,
      '--pids-limit',
      PREVIEW_RELAY_PIDS,
      '-e',
      `ATOMA_PREVIEW_INGRESS_PORT=${PREVIEW_INGRESS_PORT}`,
      '-e',
      `ATOMA_PREVIEW_UPSTREAM_HOST=${this.unitName('preview-app', spec.ownerId)}`,
      '-e',
      `ATOMA_PREVIEW_UPSTREAM_PORT=${PREVIEW_APP_PORT}`,
      this.image,
      'node',
      '/app/dist/tools/previewIngress.js',
    ]);
    for (const extra of extraNetworks) {
      await this.runDocker(['network', 'connect', extra.name, name]);
    }
    const hostPort = await this.publishedPort(name, PREVIEW_INGRESS_PORT);
    return {
      kind: spec.kind,
      ownerId: spec.ownerId,
      name,
      ...(hostPort === null ? {} : { hostPort }),
    };
  }

  /** Which loopback port the engine actually gave a published container. */
  private async publishedPort(name: string, containerPort: number): Promise<number | null> {
    const stdout = await this.runDocker(['port', name, String(containerPort)]);
    // `127.0.0.1:49154`, possibly several lines for several families.
    const match = /:(\d+)\s*$/m.exec(stdout.trim());
    const port = match?.[1] ? Number(match[1]) : Number.NaN;
    return Number.isInteger(port) && port > 0 ? port : null;
  }

  private workspacePath(ownerId: LauncherOwnerId): string {
    return path.join(this.workspaceRoot, launcherObjectId(ownerId));
  }

  async createWorkspace(ownerId: LauncherOwnerId): Promise<LauncherWorkspaceHandle> {
    const hostPath = this.workspacePath(ownerId);
    // Fresh, always. A directory left by a crashed predecessor would be
    // mounted into the next generation, which is how a preview would serve
    // bytes the run that owns it never produced.
    rmSync(hostPath, { recursive: true, force: true });
    mkdirSync(hostPath, { recursive: true });
    return { ownerId, id: launcherObjectId(ownerId), hostPath };
  }

  async removeWorkspace(handle: LauncherWorkspaceHandle): Promise<void> {
    rmSync(this.workspacePath(handle.ownerId), { recursive: true, force: true });
  }

  async awaitUnitReady(handle: LauncherUnitHandle, timeoutMs = 15_000): Promise<void> {
    if (this.waitUntilReady) {
      await this.waitUntilReady(handle.name);
      return;
    }
    if (handle.kind !== 'egress-proxy') {
      // The app announces the port it bound; a marker naming a DIFFERENT port
      // is a refusal, not readiness — the contract is that it honours `PORT`.
      const marker =
        handle.kind === 'preview-app'
          ? new RegExp(`LISTENING_ON_PORT=${PREVIEW_APP_PORT}(?!\\d)`)
          : /\[preview-ingress\] listening on/;
      await waitForUnitLog(this.runDocker, handle.name, marker, timeoutMs);
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

  /** Which name prefix belongs to which kind, for reading a sweep back. */
  private kindOfName(name: string): LauncherUnitKind | null {
    if (name.startsWith('atoma-proxy-')) return 'egress-proxy';
    if (name.startsWith('atoma-preview-app-')) return 'preview-app';
    if (name.startsWith('atoma-preview-relay-')) return 'preview-ingress';
    return null;
  }

  async listUnits(kind?: LauncherUnitKind): Promise<LauncherUnitSummary[]> {
    const units: LauncherUnitSummary[] = [];
    for (const family of ['egress', 'preview'] as const) {
      const stdout = await this.runDocker([
        'ps',
        '-a',
        '--filter',
        `label=${LAUNCHER_OWNER_LABEL}=${family}`,
        '--format',
        '{{.Names}}\t{{.State}}',
      ]);
      for (const line of stdout.split('\n').map((row) => row.trim()).filter(Boolean)) {
        const [name = '', state = ''] = line.split('\t');
        const found = this.kindOfName(name);
        if (!found) continue;
        if (kind && kind !== found) continue;
        units.push({
          kind: found,
          // The owner id is NOT recoverable from the name — it is hashed — so
          // the name stands in for it. A caller that needs the original owner
          // holds it already; a reconciler only needs to remove the object.
          ownerId: name,
          name,
          running: state === 'running',
        });
      }
    }
    return units;
  }

  async reconcileOrphans(): Promise<number> {
    let removed = 0;
    // CONTAINERS FIRST, across both families: a network with an endpoint
    // still attached refuses removal, so the reverse order spends the whole
    // bounded retry budget losing to a container nobody removed.
    for (const unit of await this.listUnits()) {
      await quiet(this.runDocker, ['rm', '-f', unit.name]);
      removed += 1;
    }
    for (const family of ['egress', 'preview'] as const) {
      const stdout = await this.runDocker([
        'network',
        'ls',
        '--filter',
        `label=${LAUNCHER_OWNER_LABEL}=${family}`,
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
