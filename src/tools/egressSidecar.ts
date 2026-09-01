import {
  DockerLauncher,
  EGRESS_ASYNC_CLEANUP_BUDGET_MS,
  EGRESS_EXIT_REMOVE_ATTEMPTS,
  EGRESS_EXIT_REMOVE_RETRY_MS,
  EGRESS_NETWORK_REMOVE_ATTEMPTS,
  EGRESS_NETWORK_REMOVE_RETRY_MS,
  isIsolatedGatewayUnsupported,
  launcherObjectId,
  LauncherExitRegistry,
  type AsyncDockerRunner,
  type SyncDockerRunner,
  type SyncSleeper,
} from '../launcher/docker.js';
import { DEFAULT_EGRESS_ALLOWLIST } from './egressPolicy.js';

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
 *
 * WHAT THIS FILE IS NOW. The Docker commands, the flags, the naming, the
 * bounded retries and the hard-exit registry moved to
 * [`src/launcher`](../launcher/docker.ts), which is the one component allowed
 * to hold engine access. What stayed is the ORDER — which objects are cleaned,
 * created, connected and torn down, and in which sequence — because that
 * order is this subsystem's contract with the run, not the engine's. Nothing
 * about the sequence changed in the move, and the command-level test asserts
 * it unchanged.
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

export {
  EGRESS_ASYNC_CLEANUP_BUDGET_MS,
  EGRESS_EXIT_REMOVE_ATTEMPTS,
  EGRESS_EXIT_REMOVE_RETRY_MS,
  EGRESS_NETWORK_REMOVE_ATTEMPTS,
  EGRESS_NETWORK_REMOVE_RETRY_MS,
  type AsyncDockerRunner,
  type SyncDockerRunner,
  type SyncSleeper,
};

/**
 * Docker-safe, collision-resistant suffix for every per-run object name.
 *
 * One definition, in the launcher, re-exported here under the name this
 * subsystem's callers and tests already use.
 */
export const egressObjectId = launcherObjectId;

/** The hard-exit registry, under this subsystem's historical name. */
export const EgressExitRegistry = LauncherExitRegistry;
export type EgressExitRegistry = LauncherExitRegistry;

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
  const now = deps.now ?? Date.now;
  const launcher = new DockerLauncher({
    image: opts.image,
    ...(deps.runDocker ? { runDocker: deps.runDocker } : {}),
    ...(deps.waitUntilReady ? { waitUntilReady: deps.waitUntilReady } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const ownerId = opts.runId;
  const internal = { kind: 'internal', ownerId } as const;
  const uplink = { kind: 'uplink', ownerId } as const;
  const network = launcher.networkName(internal);
  const uplinkNetwork = launcher.networkName(uplink);
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;

  // Clean any debris from a previous crashed run with the same id before
  // creating: `docker network create` fails on an existing name, and the
  // failure would be reported as "egress unavailable" for a stale object.
  await launcher.purgeOwner(ownerId);

  // Arm hard-exit cleanup before creation too: if stale-object removal raced
  // Docker endpoint teardown, `network create` itself can fail while the old
  // network is still durable and still needs the synchronous fallback.
  launcher.armHardExitCleanup(ownerId);
  let proxy;
  try {
    const internalHandle = await launcher.createNetwork(internal);
    const uplinkHandle = await launcher.createNetwork(uplink);
    proxy = await launcher.startUnit(
      {
        kind: 'egress-proxy',
        ownerId,
        allowlist: [...allowlist],
        ...(opts.allowedPorts ? { allowedPorts: [...opts.allowedPorts] } : {}),
      },
      [internalHandle, uplinkHandle]
    );
    await launcher.awaitUnitReady(proxy);
  } catch (err) {
    const cleanupDeadline = now() + EGRESS_ASYNC_CLEANUP_BUDGET_MS;
    await launcher.stopUnit(
      {
        kind: 'egress-proxy',
        ownerId,
        name: launcher.unitName('egress-proxy', ownerId),
      },
      'failed'
    );
    const internalRemoved = await launcher.removeNetworkBefore(
      { kind: 'internal', ownerId, name: network },
      cleanupDeadline
    );
    const uplinkRemoved = await launcher.removeNetworkBefore(
      { kind: 'uplink', ownerId, name: uplinkNetwork },
      cleanupDeadline
    );
    // If Docker is still tearing down an endpoint, keep the entry registered:
    // process-exit cleanup gets one final synchronous, bounded retry.
    if (internalRemoved && uplinkRemoved) launcher.disarmHardExitCleanup(ownerId);
    if (isIsolatedGatewayUnsupported(err)) {
      throw new Error(
        'proxied egress requires Docker Engine 28+ for an isolated bridge gateway; refusing to fall back to host-reachable --internal networking',
        { cause: err }
      );
    }
    throw err;
  }

  const proxyHandle = proxy;
  let stopPromise: Promise<void> | null = null;
  return {
    network,
    uplinkNetwork,
    proxyHost: proxyHandle.name,
    proxyPort: PROXY_PORT,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const cleanupDeadline = now() + EGRESS_ASYNC_CLEANUP_BUDGET_MS;
        await launcher.stopUnit(proxyHandle, 'caller-requested');
        // RETRY both network removals. The worker container is `--rm`, but
        // `ContainerToolExecutor.stop()` only signals it — Docker may still be
        // tearing its endpoint down. The same attempt/delay bounds are used by
        // the synchronous process-exit cleanup in the launcher.
        const uplinkRemoved = await launcher.removeNetworkBefore(
          { kind: 'uplink', ownerId, name: uplinkNetwork },
          cleanupDeadline
        );
        const internalRemoved = await launcher.removeNetworkBefore(
          { kind: 'internal', ownerId, name: network },
          cleanupDeadline
        );
        if (internalRemoved && uplinkRemoved) {
          launcher.disarmHardExitCleanup(ownerId);
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
