import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_EGRESS_ALLOWLIST } from './egressPolicy.js';

const run = promisify(execFile);

/**
 * The egress proxy that a containerised run may reach, and nothing else.
 *
 * PER RUN, not shared, and that is a correctness requirement rather than
 * tidiness. REPRODUCED: with two containers on one `--internal` network, the
 * second read the first's HTTP server — `REACHED: TENANT_A_WORKSPACE_SECRET`.
 * A docker network is a LAN; putting two tenants on it hands each other's
 * workspaces over. So every run gets its own networks and its own proxy, all
 * named after the run and all torn down with it.
 *
 * Topology:
 *   run container  → atoma-egress-<id>   (--internal + isolated gateway)
 *   proxy          → atoma-egress-<id> AND atoma-uplink-<id>
 *   uplink         → per-run user-defined bridge with outbound NAT
 * The proxy is therefore the single peer the run can reach, and
 * `decideEgress` is the whole of what it will carry. The proxy never joins
 * Docker's shared default bridge: another run has no network in common with
 * it and therefore cannot use this run's allowlist as an ambient relay.
 */
export interface EgressSidecar {
  /** Docker network the run must join. */
  readonly network: string;
  /** Per-run NAT network used only by the proxy's outbound leg. */
  readonly uplinkNetwork: string;
  /** Hostname the run uses for the proxy (its container name on that net). */
  readonly proxyHost: string;
  readonly proxyPort: number;
  /** Remove the proxy and both networks. Safe to call twice. */
  stop(): Promise<void>;
}

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

/** Docker-safe, collision-resistant suffix for every per-run object name. */
export function egressObjectId(runId: string): string {
  const readable = runId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 30) || 'run';
  const hash = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  return `${readable}-${hash}`;
}

async function docker(args: string[]): Promise<string> {
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

export type AsyncDockerRunner = (args: string[]) => Promise<string>;

async function quiet(runDocker: AsyncDockerRunner, args: string[]): Promise<void> {
  try {
    await runDocker(args);
  } catch {
    /* teardown is best-effort: a missing object is the desired end state */
  }
}

export type SyncDockerRunner = (args: string[]) => string;
export type SyncSleeper = (delayMs: number) => void;

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

function errorText(error: unknown): string {
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
  return /no such network|network .* not found/i.test(errorText(error));
}

/**
 * A hard exit cannot await Docker's endpoint teardown, but it can make the
 * same bounded retry the async path makes. Inspecting on every attempt also
 * catches a worker that had not exited yet: every container on this per-run
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
 * Registry of per-run Docker objects that must survive no control-plane exit.
 * Injectable sync runner keeps the hard-exit command sequence unit-testable
 * without requiring Docker.
 */
export class EgressExitRegistry {
  private readonly active = new Map<
    string,
    { readonly proxyHost: string; readonly uplinkNetwork: string }
  >(); // internal network → per-run Docker objects

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

const exitRegistry = new EgressExitRegistry();

/**
 * Hard-exit cleanup for the runner watchdog / process crash.
 *
 * Async `stop()` cannot run from `process.on('exit')`. Each network belongs to
 * exactly one run, so it is safe to force-remove every container still
 * attached before removing the network. This is the Docker-side sibling of
 * ToolSandbox's synchronous child reaper.
 */
process.on('exit', () => exitRegistry.cleanup(dockerSync));


/**
 * Block until the proxy has logged that it is listening.
 *
 * Reading the container's own log rather than probing a port: the proxy sits
 * on an `--internal` network the host cannot reach, so there is nothing to
 * connect to from here — the log line is the only readiness signal available.
 */
async function waitForProxy(proxyHost: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let logs = '';
    try {
      // BOTH STREAMS. `docker logs` mirrors the container's stdout and stderr
      // onto its own, and the proxy deliberately logs to STDERR — stdout is
      // the stdio protocol for the worker image. Reading only stdout here
      // made readiness never arrive, and the symptom was an empty
      // node_modules three layers away. The hand-run reproduction saw the
      // line only because the shell merged the streams with 2>&1.
      const { stdout, stderr } = await run('docker', ['logs', proxyHost], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 2_000,
      });
      logs = stdout + stderr;
    } catch {
      /* container not up yet */
    }
    if (/\[egress\] listening on/.test(logs)) return;
    if (Date.now() > deadline) {
      throw new Error(`egress proxy ${proxyHost} did not start listening in ${timeoutMs}ms: ${logs.slice(-300)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function removeNetwork(
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

export interface EgressSidecarDependencies {
  /** Injectable Docker boundary for command-level lifecycle tests. */
  readonly runDocker?: AsyncDockerRunner;
  /** Readiness is log-based in production; tests can acknowledge it directly. */
  readonly waitUntilReady?: (proxyHost: string) => Promise<void>;
  /** Injectable so retry tests do not wait five real seconds. */
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** Injectable monotonic-enough wall clock for cleanup deadline tests. */
  readonly now?: () => number;
}

export async function startEgressSidecar(
  opts: {
    runId: string;
    image: string;
    allowlist?: readonly string[];
    /** Widen only for a private registry on a non-standard port. */
    allowedPorts?: readonly number[];
  },
  deps: EgressSidecarDependencies = {}
): Promise<EgressSidecar> {
  const runDocker = deps.runDocker ?? docker;
  const waitUntilReady = deps.waitUntilReady ?? waitForProxy;
  const sleep =
    deps.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  const now = deps.now ?? Date.now;
  const id = egressObjectId(opts.runId);
  const network = `atoma-egress-${id}`;
  const uplinkNetwork = `atoma-uplink-${id}`;
  const proxyHost = `atoma-proxy-${id}`;
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;

  // Clean any debris from a previous crashed run with the same id before
  // creating: `docker network create` fails on an existing name, and the
  // failure would be reported as "egress unavailable" for a stale object.
  await quiet(runDocker, ['rm', '-f', proxyHost]);
  await quiet(runDocker, ['network', 'rm', network]);
  await quiet(runDocker, ['network', 'rm', uplinkNetwork]);

  // Arm hard-exit cleanup before creation too: if stale-object removal raced
  // Docker endpoint teardown, `network create` itself can fail while the old
  // network is still durable and still needs the synchronous fallback.
  exitRegistry.track(network, proxyHost, uplinkNetwork);
  try {
    // `--internal` alone still assigns the bridge a host gateway address;
    // Docker explicitly documents that containers can reach host services
    // bound there. Gateway mode `isolated` (Engine 28+) removes that address,
    // so the proxy is genuinely the run's only reachable peer. Older engines
    // fail this create command closed instead of silently weakening T1.
    await runDocker([
      'network',
      'create',
      '--internal',
      '--label',
      'dev.atoma.owner=egress',
      '--label',
      `dev.atoma.run=${id}`,
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv6=isolated',
      network,
    ]);
    // A user-defined bridge gets outbound NAT like Docker's default bridge,
    // without being shared with unrelated containers. Only the proxy joins it.
    await runDocker([
      'network',
      'create',
      '--label',
      'dev.atoma.owner=egress',
      '--label',
      `dev.atoma.run=${id}`,
      uplinkNetwork,
    ]);
    await runDocker([
      'run',
      '-d',
      '--name',
      proxyHost,
      '--label',
      'dev.atoma.owner=egress',
      '--label',
      `dev.atoma.run=${id}`,
      '--network',
      network,
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
      `ATOMA_EGRESS_ALLOWLIST=${allowlist.join(',')}`,
      ...(opts.allowedPorts ? ['-e', `ATOMA_EGRESS_PORTS=${opts.allowedPorts.join(',')}`] : []),
      opts.image,
      'node',
      '/app/dist/tools/egressProxy.js',
    ]);
    // The proxy's SECOND leg. This per-run bridge gives it a route out without
    // making the proxy reachable from Docker's shared default bridge.
    await runDocker(['network', 'connect', uplinkNetwork, proxyHost]);
    // WAIT FOR IT TO LISTEN. `docker run -d` returns as soon as the container
    // is created, not when the process inside is serving — and the run's very
    // first `npm install` hits the proxy immediately. Found the hard way: the
    // hand-driven reproduction had a `sleep 2` and worked, the orchestrated
    // path had none and npm failed with an empty node_modules while every
    // other check passed, which reads like a policy problem and is not one.
    await waitUntilReady(proxyHost);
  } catch (err) {
    const cleanupDeadline = now() + EGRESS_ASYNC_CLEANUP_BUDGET_MS;
    await quiet(runDocker, ['rm', '-f', proxyHost]);
    const internalRemoved = await removeNetwork(
      network,
      runDocker,
      sleep,
      cleanupDeadline,
      now
    );
    const uplinkRemoved = await removeNetwork(
      uplinkNetwork,
      runDocker,
      sleep,
      cleanupDeadline,
      now
    );
    // If Docker is still tearing down an endpoint, keep the entry registered:
    // process-exit cleanup gets one final synchronous, bounded retry.
    if (internalRemoved && uplinkRemoved) exitRegistry.untrack(network);
    if (/gateway[_ -]mode|isolated.*(?:invalid|unknown|unsupported)/i.test(errorText(err))) {
      throw new Error(
        'proxied egress requires Docker Engine 28+ for an isolated bridge gateway; refusing to fall back to host-reachable --internal networking',
        { cause: err }
      );
    }
    throw err;
  }

  let stopPromise: Promise<void> | null = null;
  return {
    network,
    uplinkNetwork,
    proxyHost,
    proxyPort: PROXY_PORT,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const cleanupDeadline = now() + EGRESS_ASYNC_CLEANUP_BUDGET_MS;
        await quiet(runDocker, ['rm', '-f', proxyHost]);
        // RETRY both network removals. The worker container is `--rm`, but
        // `ContainerToolExecutor.stop()` only signals it — Docker may still be
        // tearing its endpoint down. The same attempt/delay bounds are used by
        // the synchronous process-exit cleanup above.
        const uplinkRemoved = await removeNetwork(
          uplinkNetwork,
          runDocker,
          sleep,
          cleanupDeadline,
          now
        );
        const internalRemoved = await removeNetwork(
          network,
          runDocker,
          sleep,
          cleanupDeadline,
          now
        );
        if (internalRemoved && uplinkRemoved) {
          exitRegistry.untrack(network);
        } else {
          // Keep the hard-exit fallback armed and allow an explicit second
          // stop() call to retry. Reject explicitly: resolving here told the
          // caller cleanup had completed while durable Docker objects lived.
          stopPromise = null;
          throw new Error(
            `egress cleanup exceeded ${EGRESS_ASYNC_CLEANUP_BUDGET_MS}ms; Docker objects remain registered for hard-exit cleanup and stop() may be retried`
          );
        }
      })();
      return stopPromise;
    },
  };
}
