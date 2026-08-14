import { ToolSandbox } from '../tools/sandbox.js';
import { InMemoryToolRegistry } from '../tools/registry.js';
import { defaultBuiltinTools } from '../tools/builtin.js';
import { ContainerToolExecutor, DEFAULT_WORKER_IMAGE } from '../tools/containerExecutor.js';
import { startEgressSidecar } from '../tools/egressSidecar.js';
import type { Logger, Tool, ToolExecutor } from '../core/types.js';

/**
 * Where a run's side effects happen.
 *
 * Two backends behind one shape, because the choice touches five lines of
 * `runTask` and nothing else — the architecture already made this cheap:
 * `ToolExecutor` is two methods, the tool layer touches NO store (verified:
 * `src/tools/*` imports only node builtins, puppeteer and its own siblings),
 * and no part of the control plane reads the workspace directly — every
 * access, including the ground-truth read-back probe, goes through
 * `ctx.tools`. So moving the tool layer into a container moves exactly the
 * side-effecting half and leaves the supervise loop, the LLM calls, the atom
 * registry and the skill store untouched.
 */
export interface ToolBackend {
  /** Passed to `RunContext.tools`. */
  readonly executor: ToolExecutor;
  /** Declarations to seed atoms with — the BACKEND is the authority. */
  readonly toolDecls: Tool[];
  /** Human-facing description of where the work lands. */
  readonly rootLabel: string;
  /** Release children/containers. Must be safe to call twice. */
  cleanup(): Promise<void>;
}

/** In-process tools against a local sandbox. The historical behaviour. */
export function localToolBackend(opts: { workspaceRoot: string; logger: Logger }): ToolBackend {
  const sandbox = new ToolSandbox(opts.workspaceRoot);
  const registry = new InMemoryToolRegistry();
  registry.registerAll(defaultBuiltinTools({ sandbox, logger: opts.logger }));
  return {
    executor: registry,
    toolDecls: registry.declarations(),
    rootLabel: sandbox.root,
    cleanup: () => sandbox.cleanup(),
  };
}

/**
 * Tools inside a container: only the workspace mounted, no route out.
 *
 * OPT-IN (`--container` / `ATOMA_CONTAINER=1`) and not the default: the
 * isolation is proven (`tests/container-isolation.test.ts`) but its cost on a
 * real run — image start, per-call latency across the stdio pipe — has not
 * been measured against the burn-in curve yet, and this repo does not promote
 * a mechanism before measuring it.
 */
export async function containerToolBackend(opts: {
  workspaceRoot: string;
  image?: string;
  /**
   * Opt into PROXIED egress. Off by default: with it off the run gets
   * `--network none` and cannot fetch anything, which is right until a task
   * genuinely needs a dependency. On, the run joins a per-run internal
   * network with its host gateway removed; its only peer is an allowlisting
   * proxy.
   */
  egress?: boolean;
  egressAllowlist?: readonly string[];
  /** Names the per-run network and proxy, so two runs never share either. */
  runId?: string;
}): Promise<ToolBackend> {
  const image = opts.image ?? DEFAULT_WORKER_IMAGE;
  // PER RUN, not shared. Reproduced: two containers on one --internal network
  // reach each other's servers (`REACHED: TENANT_A_WORKSPACE_SECRET`), so a
  // shared network would hand one tenant's workspace to the next.
  const sidecar = opts.egress
    ? await startEgressSidecar({
        runId: opts.runId ?? String(process.pid),
        image,
        ...(opts.egressAllowlist ? { allowlist: opts.egressAllowlist } : {}),
      })
    : null;
  const exec = new ContainerToolExecutor({
    workspaceHostPath: opts.workspaceRoot,
    image,
    ...(sidecar
      ? { egress: { network: sidecar.network, proxyHost: sidecar.proxyHost, proxyPort: sidecar.proxyPort } }
      : {}),
  });
  try {
    await exec.start();
  } catch (err) {
    await sidecar?.stop();
    throw err;
  }
  return {
    executor: exec,
    toolDecls: exec.toolDeclarations(),
    // The host path is what a human opens; /workspace is only the container's
    // view of the same bytes through the bind mount.
    rootLabel:
      `${opts.workspaceRoot} (in container, mounted at /workspace` +
      `${sidecar ? ', proxied egress' : ', no network'})`,
    cleanup: async () => {
      exec.stop();
      // The sidecar outlives the worker container by design — the worker is
      // `--rm`, the network is not — so it must be torn down explicitly or
      // every run leaks a network and a proxy.
      await sidecar?.stop();
    },
  };
}
