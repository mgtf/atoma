import { ToolSandbox } from '../tools/sandbox.js';
import { InMemoryToolRegistry } from '../tools/registry.js';
import { defaultBuiltinTools } from '../tools/builtin.js';
import { ContainerToolExecutor, DEFAULT_WORKER_IMAGE } from '../tools/containerExecutor.js';
import { startEgressSidecar } from '../tools/egressSidecar.js';
import type { Logger, Tool, ToolExecutor } from '../core/types.js';
import { createProjectRetrievalTool, type ProjectRetrievalBinding, type ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';
import { projectRetrievalExecutor } from '../tools/projectRetrievalExecutor.js';

/**
 * Where a run's side effects happen.
 *
 * Both worker backends implement ToolExecutor. Ground-truth probes use that
 * same interface; supervision and provider calls stay on the host. Optional
 * host retrieval is composed separately and receives its authority/service
 * by injection, without giving the worker store or credential access.
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

/** Assemble the host capability around either backend, before L1/trace wrappers. */
export async function withProjectRetrievalBackend(
  backend: ToolBackend, binding: ProjectRetrievalBinding, context: ProjectRetrievalCallContext
): Promise<ToolBackend> {
  let retrieval: ReturnType<typeof createProjectRetrievalTool> | undefined;
  let cleanup: Promise<void> | undefined;
  const close = (): Promise<void> => {
    cleanup ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => retrieval?.close()),
        Promise.resolve().then(() => backend.cleanup()),
      ]);
      if (results.some(r => r.status === 'rejected')) throw new Error('project retrieval backend cleanup failed');
    })();
    return cleanup;
  };
  try {
    retrieval = createProjectRetrievalTool(binding, context);
    const composite = projectRetrievalExecutor(backend.executor, backend.toolDecls, retrieval);
    return { ...backend, ...composite, cleanup: close };
  } catch (error) {
    await close();
    throw error;
  }
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
