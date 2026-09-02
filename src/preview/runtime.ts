import type {
  ContainerLauncher,
  LauncherNetworkHandle,
  LauncherUnitHandle,
  LauncherWorkspaceHandle,
} from '../contracts/launcher.js';
import type { PreviewErrorCode } from '../contracts/preview.js';
import { materializePreviewWorkspace, PreviewPolicyError } from './policy.js';

/**
 * BRINGING ONE PREVIEW UP, AND TAKING IT DOWN AGAIN.
 *
 * The order is the contract, and it is the same shape the egress sidecar
 * proved: purge an owner's debris, arm the hard-exit fallback BEFORE creating
 * anything, create, and tear down in reverse under one shared deadline.
 *
 * TWO PROPERTIES ARE LOAD-BEARING.
 *
 * 1. NOTHING IS EXPOSED BEFORE IT ANSWERS. Readiness is two facts, not one:
 *    the application's own marker on stdout, and then a real request that
 *    reaches it through the relay. A route or a claim handed out on the marker
 *    alone would sometimes open a preview onto a connection refused, and the
 *    member would be reading our timing as their bug.
 * 2. A FAILED START LEAVES NOTHING BEHIND. Every exit path — refusal,
 *    timeout, crash, an error from the engine itself — runs the same teardown,
 *    because the alternative is a leaked container holding a tenant's bytes.
 */

export class PreviewRuntimeError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PreviewRuntimeError';
  }
}

/** What a running preview hands back. No engine identity crosses further. */
export interface RunningPreview {
  /** Loopback port the gateway forwards to. */
  readonly hostPort: number;
  readonly imageDigest: string | null;
  readonly runtime: 'runsc' | 'runc';
}

export interface PreviewRuntimeDeps {
  readonly launcher: ContainerLauncher;
  /** The pinned image digest, recorded on the instance row for attribution. */
  readonly imageDigest: string | null;
  readonly runtime: 'runsc' | 'runc';
  /**
   * One request through the relay that must succeed before anything is
   * exposed. Injected because a probe is I/O and this module is orchestration.
   */
  readonly probe: (hostPort: number) => Promise<boolean>;
  readonly copyMaxBytes?: number;
  /**
   * Who must own the copy so the container can read it. Null where the
   * container already runs as this process's uid, which is the ordinary case.
   */
  readonly copyOwnership?: { readonly uid: number; readonly gid: number } | null;
  /** Readiness budget for the application's own marker. Design D8: 60 s. */
  readonly readyTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface StartPreviewInput {
  /** Opaque per-generation identity; every engine object is named from it. */
  readonly ownerId: string;
  /**
   * The delivered workspace, to be COPIED into a launcher workspace here.
   * Read-only, and never mutated. Exactly one of this and `preparedWorkspace`.
   */
  readonly sourceWorkspace?: string;
  /**
   * A launcher workspace ALREADY holding the filtered copy — the in-flight
   * path's case, where the copy was made first so the classifier could read
   * frozen bytes. It is used as is: no second `createWorkspace`, no second
   * copy. Before this existed the in-flight path handed its copy back as
   * `sourceWorkspace` under the SAME owner id; `createWorkspace` then
   * recreated that very directory EMPTY before copying from it, so every Node
   * deliverable in flight failed with "could not be copied" — the source had
   * just been deleted by the step meant to receive it. Measured 2026-09-02.
   * Teardown owns it from here like any workspace it created.
   */
  readonly preparedWorkspace?: LauncherWorkspaceHandle;
  /** Workspace-relative entry the descriptor resolved. */
  readonly entry: string;
}

interface Created {
  workspace?: LauncherWorkspaceHandle;
  /** The internal network, and the publishable one the relay is reached on. */
  networks?: LauncherNetworkHandle[];
  app?: LauncherUnitHandle;
  relay?: LauncherUnitHandle;
}

/**
 * Teardown, in reverse creation order, best-effort and idempotent.
 *
 * RELAY FIRST: it is what a member is still connected to, and what holds the
 * network open. Then the application, then the network — a network with an
 * endpoint still attached refuses removal — then the ephemeral copy, which is
 * the only thing here that holds tenant bytes.
 *
 * It never throws. A teardown that failed loudly in the middle would leave
 * everything after it standing, which is the opposite of what it is for.
 */
export async function teardownPreview(
  deps: Pick<PreviewRuntimeDeps, 'launcher' | 'log'>,
  ownerId: string,
  created: Created
): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      // Bounded, and never the engine's own output: an operator needs to know
      // which step could not finish, not what Docker printed.
      log(`[preview] teardown could not remove the ${what} for ${ownerId}`);
      void error;
    }
  };
  if (created.relay) {
    await attempt('relay', () => deps.launcher.stopUnit(created.relay!, 'caller-requested'));
  }
  if (created.app) {
    await attempt('application', () => deps.launcher.stopUnit(created.app!, 'caller-requested'));
  }
  for (const network of created.networks ?? []) {
    await attempt('network', () => deps.launcher.removeNetwork(network));
  }
  if (created.workspace) {
    await attempt('workspace copy', () => deps.launcher.removeWorkspace(created.workspace!));
  }
  // A FINAL SWEEP BY OWNER, because handles only cover what we managed to
  // record. MEASURED: `startUnit` that created a container and then threw on a
  // later step left it running with no handle for teardown to remove. Purging
  // by owner is exactly the operation that does not depend on our bookkeeping.
  await attempt('remaining objects', () => deps.launcher.purgeOwner('preview', ownerId));
  deps.launcher.disarmHardExitCleanup('preview', ownerId);
}

/**
 * Start one preview generation.
 *
 * On ANY failure it tears down what it created and throws a
 * `PreviewRuntimeError` carrying a bounded code — the same closed vocabulary
 * the instance row and the browser summary use, so a member reads one word
 * rather than an engine's prose.
 */
export async function startPreview(
  deps: PreviewRuntimeDeps,
  input: StartPreviewInput
): Promise<RunningPreview> {
  const { launcher } = deps;
  const created: Created = {};
  const fail = async (code: PreviewErrorCode, message: string): Promise<never> => {
    await teardownPreview(deps, input.ownerId, created);
    throw new PreviewRuntimeError(code, message);
  };

  // Debris from a crashed predecessor with the same identity would make
  // `create` fail on an existing name, and that failure would be reported as
  // "preview unavailable" for a stale object.
  await launcher.purgeOwner('preview', input.ownerId);
  // Armed BEFORE creation: if the purge raced the engine's endpoint teardown,
  // creation itself can fail while the old objects are still durable.
  launcher.armHardExitCleanup('preview', input.ownerId);

  if ((input.sourceWorkspace === undefined) === (input.preparedWorkspace === undefined)) {
    return fail('internal', 'a preview starts from exactly one of a source workspace or a prepared copy');
  }
  if (input.preparedWorkspace) {
    // The copy exists and was classified; the only thing to check is that this
    // backend gave it a host path the engine can mount.
    created.workspace = input.preparedWorkspace;
    if (!created.workspace.hostPath) {
      return fail('internal', 'this launcher backend cannot receive a host-side copy');
    }
  } else {
    try {
      created.workspace = await launcher.createWorkspace(input.ownerId);
    } catch {
      return fail('internal', 'the preview workspace could not be created');
    }

    const destination = created.workspace.hostPath;
    if (!destination) {
      // A backend that hands back no path needs a streaming copy, which is a
      // different mechanism, not a fallback to guessing where the bytes go.
      return fail('internal', 'this launcher backend cannot receive a host-side copy');
    }
    try {
      materializePreviewWorkspace({
        sourceRoot: input.sourceWorkspace!,
        destinationRoot: destination,
        ...(deps.copyMaxBytes ? { limits: { maxBytes: deps.copyMaxBytes } } : {}),
        ...(deps.copyOwnership ? { ownership: deps.copyOwnership } : {}),
      });
    } catch (error) {
      if (error instanceof PreviewPolicyError && error.code === 'limit') {
        return fail('copy-limit', 'the delivered workspace is larger than a preview may copy');
      }
      return fail('internal', 'the delivered workspace could not be copied');
    }
  }

  let internal: LauncherNetworkHandle;
  let publishable: LauncherNetworkHandle;
  try {
    // The isolate's network carries no route out and no host gateway; the
    // second one exists ONLY so the relay can be published on loopback, and
    // nothing but the relay ever joins it.
    internal = await launcher.createNetwork({
      family: 'preview',
      kind: 'internal',
      ownerId: input.ownerId,
    });
    created.networks = [internal];
    publishable = await launcher.createNetwork({
      family: 'preview',
      kind: 'uplink',
      ownerId: input.ownerId,
    });
    created.networks = [internal, publishable];
  } catch {
    return fail('runtime-unavailable', 'the preview network could not be created');
  }

  try {
    created.app = await launcher.startUnit(
      {
        kind: 'preview-app',
        ownerId: input.ownerId,
        entry: input.entry,
        workspace: { ownerId: created.workspace.ownerId, id: created.workspace.id },
      },
      [internal]
    );
  } catch {
    // The engine refusing to start this unit is most often a missing image or
    // an absent runtime, and both are deployment facts rather than app bugs.
    return fail('image-unavailable', 'the preview application container could not be started');
  }

  try {
    await launcher.awaitUnitReady(created.app, deps.readyTimeoutMs ?? 60_000);
  } catch {
    // The marker never arrived, or arrived naming another port. Either way the
    // application did not honour the start contract it was given.
    return fail('readiness-timeout', 'the application did not report listening on the port it was given');
  }

  try {
    created.relay = await launcher.startUnit(
      { kind: 'preview-ingress', ownerId: input.ownerId },
      // PUBLISHABLE FIRST: a container whose only network is `--internal` gets
      // no published port, so the leg the gateway reaches it on has to be the
      // one it is created with. The internal leg is connected after.
      [publishable, internal]
    );
    await launcher.awaitUnitReady(created.relay);
  } catch {
    return fail('gateway-unavailable', 'the preview relay could not be started');
  }

  const hostPort = created.relay.hostPort;
  if (hostPort === undefined) {
    return fail('gateway-unavailable', 'the preview relay was not published on a reachable port');
  }

  // THE SECOND FACT. A marker says a process bound a port; only a request that
  // comes back says the member will find something there.
  let answered = false;
  try {
    answered = await deps.probe(hostPort);
  } catch {
    answered = false;
  }
  if (!answered) {
    return fail('server-exited', 'the application stopped answering before the preview was exposed');
  }

  return { hostPort, imageDigest: deps.imageDigest, runtime: deps.runtime };
}
