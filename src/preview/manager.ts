import type { PreviewSummary } from '../contracts/preview.js';
import type { ContainerLauncher } from '../contracts/launcher.js';
import { mintPreviewClaim, PreviewClaimRegistry } from './claims.js';
import type { PreviewConfig } from './config.js';
import { previewGenerationHost, previewOrigin } from './gateway.js';
import { PreviewRouteTable } from './gatewayServer.js';
import { materializePreviewWorkspace } from './policy.js';
import { startPreview, teardownPreview, PreviewRuntimeError } from './runtime.js';
import { effectiveEgressHosts, PreviewStateConflict, PreviewStore } from './store.js';
import { readPreviewSummary } from './service.js';

/**
 * THE PREVIEW MANAGER — one object that owns a preview's whole life.
 *
 * The store says what state a preview is in, the launcher makes containers,
 * the gateway serves them and the claim registry decides who may look. Each is
 * narrow on purpose; something has to hold them in the right order, and doing
 * that in a route handler would put the ordering in the transport.
 *
 * WHAT IT REFUSES, and why each refusal is here rather than at the route:
 *
 * - A run whose descriptor says there is nothing to preview. The descriptor is
 *   the delivery-time answer, so this is a fact, not a probe.
 * - A quota. Counted from the STORE, not from memory, because two processes
 *   may write this file and an in-memory count would let each of them believe
 *   it was the only one.
 * - A concurrent open. `openInstance` is a compare-and-set, so two members
 *   clicking at the same moment get one isolate and one generation.
 */

export interface PreviewManagerDeps {
  readonly store: PreviewStore;
  readonly launcher: ContainerLauncher;
  readonly routes: PreviewRouteTable;
  readonly claims: PreviewClaimRegistry;
  readonly config: PreviewConfig;
  /** Where the delivered workspace of a run lives. Host-owned, never a caller's. */
  readonly workspaceOf: (orgId: string, projectId: string, projectRunId: string) => string;
  /** One request through the relay that must succeed before anything is exposed. */
  readonly probe: (hostPort: number) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export class PreviewQuotaError extends Error {
  constructor(
    readonly scope: 'org' | 'global',
    readonly retryAfterSeconds: number
  ) {
    super(`preview capacity reached (${scope})`);
    this.name = 'PreviewQuotaError';
  }
}

export class PreviewUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`preview unavailable: ${reason}`);
    this.name = 'PreviewUnavailableError';
  }
}

export interface OpenedPreview {
  readonly summary: PreviewSummary;
  /**
   * The URL to put in an iframe, carrying the one-time claim in its FRAGMENT.
   * Present only on the call that made a preview ready; a reader never gets
   * one, because a claim nobody asked for is a credential nobody wanted.
   */
  readonly url: string;
}

export interface PreviewOpener {
  readonly principalId: string;
  readonly sessionId: string;
}

export class PreviewManager {
  private readonly starting = new Set<string>();

  constructor(private readonly deps: PreviewManagerDeps) {}

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  private key(orgId: string, projectRunId: string): string {
    return `${orgId}:${projectRunId}`;
  }

  /** An opaque per-generation identity; every engine object is named from it. */
  private ownerId(projectRunId: string, generation: number): string {
    return `preview-${projectRunId}-${generation}`;
  }

  status(orgId: string, projectId: string, projectRunId: string): PreviewSummary {
    return readPreviewSummary(this.deps.store, { orgId, projectId, projectRunId });
  }

  /**
   * Start or reuse a preview, and mint the claim that opens it.
   *
   * IDEMPOTENT: a second call while one is starting reuses the generation
   * rather than building a second isolate, and a call on a ready preview mints
   * a fresh claim for the SAME generation — which is what makes "open in a new
   * tab" work without ever copying a stale bearer.
   */
  async open(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly projectRunId: string;
    readonly opener: PreviewOpener;
  }): Promise<OpenedPreview> {
    const { store } = this.deps;
    const descriptor = store.getDescriptor(input.orgId, input.projectRunId);
    if (!descriptor) throw new PreviewUnavailableError('legacy-run');
    if (descriptor.availability !== 'available') {
      throw new PreviewUnavailableError(descriptor.unavailableReason ?? 'unavailable');
    }

    const existing = store.getInstance(input.orgId, input.projectRunId);
    if (existing?.state === 'ready') {
      return this.claimFor(input, existing.generation, descriptor.requestedHosts);
    }

    this.assertCapacity(input.orgId);

    const key = this.key(input.orgId, input.projectRunId);
    if (this.starting.has(key)) {
      // Someone else is already building this generation. Saying so is better
      // than queueing behind it: the caller polls, which is what the route
      // contract already tells it to do while `starting`.
      throw new PreviewStateConflict('a preview for this run is already starting');
    }

    const opened = store.openInstance({
      orgId: input.orgId,
      projectRunId: input.projectRunId,
      now: new Date(this.now()),
    });
    if (!opened.started) {
      return {
        summary: this.status(input.orgId, input.projectId, input.projectRunId),
        url: '',
      };
    }

    this.starting.add(key);
    const generation = opened.instance.generation;
    const ownerId = this.ownerId(input.projectRunId, generation);
    try {
      const host = `${previewGenerationHost(input.orgId, input.projectRunId, generation)}.${this.deps.config.domain}`;
      const approved = store.listApprovedHosts(input.orgId, input.projectId);
      const { allowed } = effectiveEgressHosts(descriptor.requestedHosts, approved);

      if (descriptor.kind === 'static') {
        // No container at all: the gateway serves the copy. It still gets an
        // origin, a generation and a claim, because those are what bound WHO
        // may look, not what is running.
        const workspace = await this.deps.launcher.createWorkspace(ownerId);
        if (!workspace.hostPath) throw new PreviewRuntimeError('internal', 'no host-side copy');
        materializePreviewWorkspace({
          sourceRoot: this.deps.workspaceOf(input.orgId, input.projectId, input.projectRunId),
          destinationRoot: workspace.hostPath,
          limits: { maxBytes: this.deps.config.copyMaxBytes },
        });
        this.deps.routes.set(host, {
          orgId: input.orgId,
          projectRunId: input.projectRunId,
          generation,
          kind: 'static',
          workspaceRoot: workspace.hostPath,
          allowedHosts: allowed,
        });
        store.markReady({
          orgId: input.orgId,
          projectRunId: input.projectRunId,
          generation,
          expiresAt: new Date(this.now() + this.deps.config.hardMs).toISOString(),
          now: new Date(this.now()),
        });
      } else {
        const running = await startPreview(
          {
            launcher: this.deps.launcher,
            imageDigest: this.digestOf(this.deps.config.image),
            runtime: this.deps.config.runtime,
            probe: this.deps.probe,
            copyMaxBytes: this.deps.config.copyMaxBytes,
            ...(this.deps.log ? { log: this.deps.log } : {}),
          },
          {
            ownerId,
            sourceWorkspace: this.deps.workspaceOf(
              input.orgId,
              input.projectId,
              input.projectRunId
            ),
            entry: descriptor.entry ?? '',
          }
        );
        // THE ROUTE IS PUBLISHED LAST. `startPreview` has already proved the
        // application answers through the relay, so nothing is reachable
        // before it is known to work.
        this.deps.routes.set(host, {
          orgId: input.orgId,
          projectRunId: input.projectRunId,
          generation,
          kind: 'node',
          upstreamPort: running.hostPort,
          allowedHosts: allowed,
        });
        store.markReady({
          orgId: input.orgId,
          projectRunId: input.projectRunId,
          generation,
          imageDigest: running.imageDigest,
          runtime: running.runtime,
          expiresAt: new Date(this.now() + this.deps.config.hardMs).toISOString(),
          now: new Date(this.now()),
        });
      }

      return this.claimFor(input, generation, descriptor.requestedHosts);
    } catch (error) {
      const code = error instanceof PreviewRuntimeError ? error.code : 'internal';
      try {
        this.deps.store.markFailed({
          orgId: input.orgId,
          projectRunId: input.projectRunId,
          generation,
          errorCode: code,
          now: new Date(this.now()),
        });
      } catch {
        /* the row moved on; the teardown below is what matters */
      }
      throw error;
    } finally {
      this.starting.delete(key);
    }
  }

  /** A fresh one-time claim for a generation that is already ready. */
  private claimFor(
    input: { orgId: string; projectId: string; projectRunId: string; opener: PreviewOpener },
    generation: number,
    _requestedHosts: readonly string[]
  ): OpenedPreview {
    const host = `${previewGenerationHost(input.orgId, input.projectRunId, generation)}.${this.deps.config.domain}`;
    const claim = mintPreviewClaim(
      {
        principalId: input.opener.principalId,
        sessionId: input.opener.sessionId,
        orgId: input.orgId,
        projectRunId: input.projectRunId,
        generation,
        host,
      },
      this.now()
    );
    this.deps.claims.register(claim);
    const origin = previewOrigin(
      this.deps.config.domain,
      input.orgId,
      input.projectRunId,
      generation
    );
    return {
      summary: this.status(input.orgId, input.projectId, input.projectRunId),
      // The secret rides the FRAGMENT: never sent to a server, so never in a
      // request line, an access log or a `Referer`.
      url: `${origin}/#${claim.secret}`,
    };
  }

  /** The trusted UI heartbeat. Application traffic never reaches this. */
  heartbeat(orgId: string, projectRunId: string, generation: number): boolean {
    const touched = this.deps.store.touchActivity({
      orgId,
      projectRunId,
      generation,
      now: new Date(this.now()),
    });
    return touched !== null;
  }

  /** Stop one preview and remove everything it owns. */
  async stop(
    orgId: string,
    projectId: string,
    projectRunId: string,
    reason: 'manual' | 'idle' | 'hard-expiry' | 'restart' | 'logout' | 'policy-change' | 'crash'
  ): Promise<PreviewSummary> {
    const instance = this.deps.store.getInstance(orgId, projectRunId);
    if (!instance || instance.state === 'stopped') {
      return this.status(orgId, projectId, projectRunId);
    }
    const generation = instance.generation;
    const host = `${previewGenerationHost(orgId, projectRunId, generation)}.${this.deps.config.domain}`;

    // ROUTES AND GRANTS FIRST. A member holding a live grant must stop being
    // able to reach the application before the application is taken away, or
    // the last thing they see is a connection error we caused.
    this.deps.routes.delete(host);
    this.deps.claims.revokeRun(orgId, projectRunId);

    if (instance.state !== 'failed') {
      try {
        this.deps.store.beginStop({
          orgId,
          projectRunId,
          generation,
          reason,
          now: new Date(this.now()),
        });
      } catch {
        /* it moved on; the teardown below is still right */
      }
    }

    const ownerId = this.ownerId(projectRunId, generation);
    await teardownPreview(
      { launcher: this.deps.launcher, ...(this.deps.log ? { log: this.deps.log } : {}) },
      ownerId,
      {
        workspace: { ownerId, id: ownerId },
        network: { family: 'preview', kind: 'internal', ownerId, name: this.deps.launcher.networkName({ family: 'preview', kind: 'internal', ownerId }) },
        app: { kind: 'preview-app', ownerId, name: this.deps.launcher.unitName('preview-app', ownerId) },
        relay: { kind: 'preview-ingress', ownerId, name: this.deps.launcher.unitName('preview-ingress', ownerId) },
      }
    );

    try {
      this.deps.store.finishStop({
        orgId,
        projectRunId,
        generation,
        reason,
        now: new Date(this.now()),
      });
    } catch {
      // A failed row stays failed until the next open, by contract: that is
      // the state carrying the code a member still needs to read.
    }
    return this.status(orgId, projectId, projectRunId);
  }

  /**
   * Stop every preview whose idle or hard bound has passed.
   *
   * Called on a timer. Both bounds are enforced here rather than in the
   * gateway, because the gateway sees only traffic and traffic is exactly what
   * must NOT keep a preview alive.
   */
  async sweepExpired(): Promise<number> {
    const at = this.now();
    let stopped = 0;
    for (const row of this.deps.store.listLiveInstances()) {
      const hard = row.expiresAt ? Date.parse(row.expiresAt) : Number.POSITIVE_INFINITY;
      const idleSince = row.lastActivityAt ? Date.parse(row.lastActivityAt) : at;
      const reason = at > hard ? 'hard-expiry' : at - idleSince > this.deps.config.idleMs ? 'idle' : null;
      if (!reason) continue;
      await this.stop(row.orgId, row.projectId, row.projectRunId, reason);
      stopped += 1;
    }
    return stopped;
  }

  private assertCapacity(orgId: string): void {
    const counts = this.deps.store.countLiveInstances(orgId);
    if (counts.global >= this.deps.config.maxGlobal) {
      // NEVER evict someone else's preview to make room. A refusal the member
      // can retry is honest; taking a colleague's running preview is not.
      throw new PreviewQuotaError('global', 30);
    }
    if (counts.org >= this.deps.config.maxPerOrg) throw new PreviewQuotaError('org', 30);
  }

  /** `name@sha256:...` → the digest alone, for the attribution column. */
  private digestOf(image: string): string | null {
    const match = /@(sha256:[a-f0-9]{64})$/.exec(image);
    return match?.[1] ?? null;
  }
}
