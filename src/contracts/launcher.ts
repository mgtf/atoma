import { z } from 'zod';

/**
 * THE LAUNCHER CONTRACT — who is allowed to create a container, and what may
 * be asked of them.
 * =========================================================================
 *
 * A containerised atoma must start sibling containers. Mounting `docker.sock`
 * into the web-facing container would hand host-root to the process that also
 * holds session cookies, the authenticated API and the product store — the
 * exact inversion of this repository's isolation discipline, where the worker
 * is already forbidden the socket. So:
 *
 *   INVARIANT 1  the atoma web container never mounts the Docker socket, in
 *                any mode, including development;
 *   INVARIANT 2  exactly one component — the launcher — holds Docker API
 *                access, under its own OS identity.
 *
 * Design of record: `docs/deployment-docker-launcher-2026-08-28.md` §2.
 *
 * WHAT MAKES THIS CONTRACT NARROW, and why that is the whole point: a caller
 * names a PROFILE and supplies identity plus the few values that profile
 * takes. It may never supply a command line, an image, a mount path, an
 * environment map, a network name, or any other engine option — those are
 * derived launcher-side. A launcher that accepted them would be a remote
 * shell wearing a typed interface, and Invariant 2 would buy nothing.
 *
 * IT MUST ALSO BE NARROW ENOUGH TO SWAP. The recorded position is that
 * Kubernetes is deferred, not rejected, and that the insurance policy is this
 * interface: a Kubernetes backend implements the same operations over
 * Job/Pod under RBAC without any caller changing. That is the concrete
 * meaning of "Kubernetes is a swap", and it is why nothing below names
 * Docker.
 *
 * WHAT IS DELIBERATELY NOT HERE: the worker container's attached stdio. That
 * is an RPC TRANSPORT, not a lifecycle operation — the control plane pipes a
 * tool-call protocol over the child's stdin and stdout — and a launcher
 * reached over a socket cannot hand a pipe back. Moving it is a protocol
 * change, and Phase 0's contract is explicitly that the run path is unchanged
 * behaviourally. `src/launcher/AGENTS.md` records what closing that gap will
 * take.
 */

/* ─────────────────────────────── identity ─────────────────────────────── */

/**
 * The opaque identity a caller passes so its objects can be named, labelled
 * and later found. Bounded and character-restricted because it reaches an
 * engine's object namespace, and because a launcher must never be asked to
 * interpret a caller's string.
 */
export const launcherOwnerIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'owner ids are opaque ASCII tokens');

/**
 * What a unit is FOR. A closed vocabulary, because the profile — image,
 * command, mounts, resource envelope, capability set — is chosen from it
 * launcher-side.
 *
 * It holds exactly what a backend implements. A member with no
 * implementation would be a promise the type system makes and the runtime
 * breaks; the preview profiles join it when the preview runtime lands.
 */
export const launcherUnitKindSchema = z.enum(['egress-proxy']);

/**
 * What a network is FOR. `internal` carries no route out and no host gateway;
 * `uplink` carries outbound NAT and is joined by nothing but the one unit
 * that needs it.
 */
export const launcherNetworkKindSchema = z.enum(['internal', 'uplink']);

/* ──────────────────────────────── networks ────────────────────────────── */

export const launcherNetworkSpecSchema = z
  .object({
    kind: launcherNetworkKindSchema,
    ownerId: launcherOwnerIdSchema,
  })
  .strict();

export const launcherNetworkHandleSchema = z
  .object({
    kind: launcherNetworkKindSchema,
    ownerId: launcherOwnerIdSchema,
    /**
     * The engine-side name. A caller receives it so it can be given to a unit
     * spec by REFERENCE, and must never construct one: a caller that could
     * name a network could name someone else's.
     */
    name: z.string().min(1).max(255),
  })
  .strict();

/* ───────────────────────────────── units ──────────────────────────────── */

/**
 * The egress proxy: the ONE peer a containerised run may reach.
 *
 * `allowlist` and `allowedPorts` are policy the launcher hands the proxy, and
 * they are the only inputs this profile takes. Nothing inside the container
 * can widen them.
 */
export const egressProxyUnitSpecSchema = z
  .object({
    kind: z.literal('egress-proxy'),
    ownerId: launcherOwnerIdSchema,
    allowlist: z.array(z.string().min(1).max(253)).max(256),
    allowedPorts: z.array(z.number().int().min(1).max(65535)).max(32).optional(),
  })
  .strict();

export const launcherUnitSpecSchema = z.discriminatedUnion('kind', [egressProxyUnitSpecSchema]);

export const launcherUnitHandleSchema = z
  .object({
    kind: launcherUnitKindSchema,
    ownerId: launcherOwnerIdSchema,
    /** Engine-side name. Also the hostname its peers reach it by. */
    name: z.string().min(1).max(255),
  })
  .strict();

/**
 * Why a unit was stopped. Recorded rather than free text so an operator can
 * count causes without reading prose.
 */
export const launcherStopReasonSchema = z.enum([
  'completed',
  'failed',
  'caller-requested',
  'reconciled',
]);

export const launcherUnitSummarySchema = z
  .object({
    kind: launcherUnitKindSchema,
    ownerId: launcherOwnerIdSchema,
    name: z.string().min(1).max(255),
    running: z.boolean(),
  })
  .strict();

export type LauncherOwnerId = z.infer<typeof launcherOwnerIdSchema>;
export type LauncherUnitKind = z.infer<typeof launcherUnitKindSchema>;
export type LauncherNetworkKind = z.infer<typeof launcherNetworkKindSchema>;
export type LauncherNetworkSpec = z.infer<typeof launcherNetworkSpecSchema>;
export type LauncherNetworkHandle = z.infer<typeof launcherNetworkHandleSchema>;
export type LauncherUnitSpec = z.infer<typeof launcherUnitSpecSchema>;
export type LauncherUnitHandle = z.infer<typeof launcherUnitHandleSchema>;
export type LauncherStopReason = z.infer<typeof launcherStopReasonSchema>;
export type LauncherUnitSummary = z.infer<typeof launcherUnitSummarySchema>;

/**
 * Everything a caller may ask of whatever holds engine access.
 *
 * Every method is a CLOSED operation over the shapes above. There is
 * deliberately no `exec`, no `inspect(raw)`, no option passthrough and no
 * escape hatch: each one would reopen Invariant 2.
 */
export interface ContainerLauncher {
  /**
   * The engine-side name an owner's object WILL have, without creating it.
   *
   * Naming is deterministic from the owner id so a caller can compose, and a
   * hard-exit path can clean up, without holding a handle it may never have
   * received. It is the launcher's rule, not the caller's: a caller that
   * could construct a name could name someone else's object.
   */
  networkName(spec: LauncherNetworkSpec): string;

  /** The same rule for a unit, so a failure path with no handle can still name it. */
  unitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string;

  /**
   * Best-effort removal of every object belonging to one owner.
   *
   * The pre-clean before creation: debris from a crashed predecessor with the
   * same owner id makes `create` fail on an existing name, and that failure
   * would be reported as "egress unavailable" for a stale object. Never
   * throws — a missing object is the desired end state.
   */
  purgeOwner(ownerId: LauncherOwnerId): Promise<void>;

  /**
   * Arm the synchronous, bounded, hard-exit cleanup for one owner.
   *
   * A watchdog exit or a crash cannot await teardown, but it can make the
   * same bounded attempt. Armed BEFORE creation on purpose: if stale-object
   * removal raced the engine's endpoint teardown, `create` itself can fail
   * while the old objects are still durable and still need the fallback.
   *
   * A backend whose objects are already owned by something that cascades —
   * Kubernetes `ownerReferences` — implements this as a no-op, which is
   * precisely the kind of difference the swap is meant to absorb.
   */
  armHardExitCleanup(ownerId: LauncherOwnerId): void;

  /** Disarm it, once every object for that owner is provably gone. */
  disarmHardExitCleanup(ownerId: LauncherOwnerId): void;

  /**
   * Create one network for one owner. Creation only: the caller decides when
   * to `purgeOwner`, because the ORDER in which an owner's objects are
   * cleaned and created is the caller's contract, not the launcher's.
   */
  createNetwork(spec: LauncherNetworkSpec): Promise<LauncherNetworkHandle>;

  /**
   * Remove a network, with the bounded retry an engine's endpoint teardown
   * needs. Returns whether it is gone — a caller that must keep a hard-exit
   * fallback armed needs to know, and a resolved promise that meant "probably"
   * is how durable objects leak.
   */
  removeNetwork(handle: LauncherNetworkHandle): Promise<boolean>;

  /**
   * Start one unit from its profile, attached to the networks named by
   * handle. The launcher derives image, command, environment, mounts,
   * capabilities and resource limits; the spec carries none of them.
   */
  startUnit(
    spec: LauncherUnitSpec,
    networks: readonly LauncherNetworkHandle[]
  ): Promise<LauncherUnitHandle>;

  /**
   * Block until the unit's own output announces it is serving.
   *
   * READINESS IS A LOG LINE because the alternative does not exist: these
   * units sit on internal networks the control plane cannot reach, so there
   * is nothing to connect to from here. Every backend can read a unit's
   * output, so this stays swappable.
   */
  awaitUnitReady(handle: LauncherUnitHandle, timeoutMs?: number): Promise<void>;

  /** Stop and remove a unit. Safe to call twice; absence is the desired end. */
  stopUnit(handle: LauncherUnitHandle, reason: LauncherStopReason): Promise<void>;

  /** Every unit this launcher owns, optionally narrowed to one kind. */
  listUnits(kind?: LauncherUnitKind): Promise<LauncherUnitSummary[]>;

  /**
   * Remove every labelled object this launcher owns.
   *
   * It lives here because only the component with engine access can see and
   * remove orphans, and a control plane that crashed mid-run cannot clean up
   * after itself. Returns how many objects were removed, so a boot can say so
   * rather than reaping silently.
   */
  reconcileOrphans(): Promise<number>;
}

/** Parsed at module load, like every contract example in this directory. */
export const EXAMPLE_EGRESS_PROXY_SPEC: LauncherUnitSpec = launcherUnitSpecSchema.parse({
  kind: 'egress-proxy',
  ownerId: 'run-4f2c1a',
  allowlist: ['registry.npmjs.org', '.npmjs.org'],
});
