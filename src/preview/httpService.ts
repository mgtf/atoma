import type { Viewer } from '../auth/store.js';
import { ProjectHttpError, roleAtLeast } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { previewEgressHostSchema, type PreviewSummary } from '../contracts/preview.js';
import {
  PreviewManager,
  PreviewQuotaError,
  PreviewUnavailableError,
} from './manager.js';
import { PreviewPolicyError } from './policy.js';
import { PreviewRuntimeError } from './runtime.js';
import { PreviewStateConflict, type PreviewStore } from './store.js';

/**
 * THE PREVIEW'S HTTP SEMANTICS — who may ask, and what an answer means.
 *
 * The transport translates a request and calls in here; this decides. That
 * split is the strangler direction the 2026-08-26 review named, and it is why
 * `src/viz/server.ts` gains five thin blocks rather than five more decisions.
 *
 * THREE AUTHORISATION RULES, none of which the transport may restate:
 *
 * 1. READING allocates nothing. `org:viewer` may see whether a preview exists
 *    and what state it is in, and a GET never starts a container — a route
 *    that allocated compute on a read would let a tab left open spend an
 *    organisation's quota.
 * 2. WRITING is `org:member` and above, and is bound to the viewer's ACTIVE
 *    organisation. A platform admin reading across organisations still writes
 *    only in its own, exactly as `cancel` and `publish` already require.
 * 3. THE RUN MUST BE UNDER THE PROJECT NAMED IN THE PATH. A run of another
 *    project in the same organisation is a 404, or the REST hierarchy lies.
 *
 * `ProjectHttpError` is reused rather than a second error type: the routes
 * already know how to render one, and a parallel vocabulary would be a second
 * mapping from failures to status codes.
 */

export interface PreviewHttpDeps {
  readonly manager: PreviewManager;
  readonly store: PreviewStore;
  readonly projects: ProjectStore;
}

/** How long a caller should wait before polling a starting preview again. */
export const PREVIEW_RETRY_AFTER_SECONDS = 2;

export interface PreviewOpenResponse {
  readonly summary: PreviewSummary;
  /**
   * Present ONLY when this call has a ready preview to hand over. It carries
   * the one-time claim in its fragment, so it is a credential: never logged,
   * never cached, and never returned to a reader.
   */
  readonly url?: string;
  readonly retryAfterSeconds?: number;
}

export class PreviewHttpService {
  constructor(private readonly deps: PreviewHttpDeps) {}

  /**
   * Is this run still going?
   *
   * THE HOST DECIDES, never the caller. A request may ASK for an in-flight
   * preview, but whether one is what it gets is a fact about the run: a
   * delivered run has a descriptor and gets its delivered preview, and a
   * running one gets a snapshot of the moment. Taking the client's word would
   * let a caller ask for a snapshot of a finished run and be served one that
   * silently disagrees with the result it published.
   *
   * `queued` is NOT in flight: nothing has been produced to snapshot yet.
   */
  private runInFlight(viewer: Viewer, projectRunId: string): boolean {
    return this.deps.projects.getProjectRun(viewer.orgId, projectRunId)?.status === 'running';
  }

  /** The run, bound to the project named in the path, or a 404. */
  private boundRun(viewer: Viewer, projectId: string, projectRunId: string): void {
    const run = this.deps.projects.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) {
      throw new ProjectHttpError(404, 'project run not found');
    }
  }

  private requireMember(viewer: Viewer, what: string): void {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, `org:member role or above is required to ${what}`);
    }
  }

  /** GET — status only. Allocates nothing, ever. */
  status(viewer: Viewer, projectId: string, projectRunId: string): PreviewSummary {
    this.boundRun(viewer, projectId, projectRunId);
    return this.deps.manager.status(viewer.orgId, projectId, projectRunId, {
      runInFlight: this.runInFlight(viewer, projectRunId),
    });
  }

  /**
   * POST open — idempotent start or reuse.
   *
   * `202` while a preview is still building, with a retry delay, because the
   * alternative is holding an HTTP request open for the length of a container
   * start. `200` with a URL once it is ready.
   */
  async open(
    viewer: Viewer,
    projectId: string,
    projectRunId: string,
    options: { readonly inFlight?: boolean } = {}
  ): Promise<{ readonly status: number; readonly body: PreviewOpenResponse }> {
    this.requireMember(viewer, 'open previews');
    this.boundRun(viewer, projectId, projectRunId);
    // `Viewer` carries no session id; see `PreviewClaimBinding.sessionId`.
    const opener = { principalId: viewer.principalId, sessionId: null };
    // The caller ASKS; the run's own status ANSWERS. `inFlight` is a
    // willingness to accept a snapshot, not an assertion about the run, so a
    // request for one on a delivered run gets the delivered preview.
    const inFlight = options.inFlight === true && this.runInFlight(viewer, projectRunId);
    try {
      const opened = inFlight
        ? await this.deps.manager.openInFlight({ orgId: viewer.orgId, projectId, projectRunId, opener })
        : await this.deps.manager.open({ orgId: viewer.orgId, projectId, projectRunId, opener });
      if (!opened.url) {
        // Another caller is building this generation; the summary says so and
        // the caller polls rather than queueing behind it.
        return {
          status: 202,
          body: { summary: opened.summary, retryAfterSeconds: PREVIEW_RETRY_AFTER_SECONDS },
        };
      }
      return { status: 200, body: { summary: opened.summary, url: opened.url } };
    } catch (error) {
      throw this.asHttp(error);
    }
  }

  /** POST heartbeat — the ONLY thing that extends a preview. */
  heartbeat(
    viewer: Viewer,
    projectId: string,
    projectRunId: string,
    generation: number
  ): PreviewSummary {
    this.requireMember(viewer, 'keep previews alive');
    this.boundRun(viewer, projectId, projectRunId);
    // A heartbeat for a generation that has moved on is NOT an error: the
    // browser is a beat behind, and the summary it gets back tells it so.
    this.deps.manager.heartbeat(viewer.orgId, projectRunId, generation, viewer.principalId);
    return this.deps.manager.status(viewer.orgId, projectId, projectRunId, {
      runInFlight: this.runInFlight(viewer, projectRunId),
    });
  }

  /** POST stop. */
  async stop(viewer: Viewer, projectId: string, projectRunId: string): Promise<PreviewSummary> {
    this.requireMember(viewer, 'stop previews');
    this.boundRun(viewer, projectId, projectRunId);
    await this.deps.manager.stop(viewer.orgId, projectId, projectRunId, 'manual');
    // Re-read with the run's status in hand. The manager answers about the
    // INSTANCE it just removed and knows nothing about the run, so its own
    // summary would tell a member who stopped a snapshot of a live run that
    // there is now nothing to preview — and take the control away mid-run.
    return this.status(viewer, projectId, projectRunId);
  }

  /**
   * POST restart — stop, then open a new generation.
   *
   * Two steps rather than one, because a restart IS a new browser origin: the
   * generation increments, the old grants are revoked, and any service worker
   * or storage the previous generation left behind is unreachable from the new
   * one.
   */
  async restart(
    viewer: Viewer,
    projectId: string,
    projectRunId: string,
    options: { readonly inFlight?: boolean } = {}
  ): Promise<{ readonly status: number; readonly body: PreviewOpenResponse }> {
    this.requireMember(viewer, 'restart previews');
    this.boundRun(viewer, projectId, projectRunId);
    await this.deps.manager.stop(viewer.orgId, projectId, projectRunId, 'restart');
    return this.open(viewer, projectId, projectRunId, options);
  }

  /** GET egress approvals — readable by anyone who may see the project. */
  listEgress(viewer: Viewer, projectId: string): { readonly approvedHosts: string[] } {
    this.requireProject(viewer, projectId);
    return { approvedHosts: this.deps.store.listApprovedHosts(viewer.orgId, projectId) };
  }

  /**
   * PUT egress approvals — `org:admin` and above.
   *
   * REPLACES the set, and only with hosts a delivered run of this project
   * actually requested: an approval for a host nobody asked for is a standing
   * permission nobody reviewed. Changing approvals STOPS the project's live
   * previews, so the next generation gets a coherent CSP and sidecar policy
   * rather than a running one whose rules changed underneath it.
   */
  async replaceEgress(
    viewer: Viewer,
    projectId: string,
    hosts: readonly unknown[]
  ): Promise<{ readonly approvedHosts: string[] }> {
    if (!roleAtLeast(viewer.role, 'org:admin')) {
      throw new ProjectHttpError(403, 'org:admin role or above is required to approve egress');
    }
    this.requireProject(viewer, projectId);
    if (hosts.length > 16) {
      throw new ProjectHttpError(400, 'at most 16 hosts may be approved');
    }
    const parsed: string[] = [];
    for (const host of hosts) {
      const result = previewEgressHostSchema.safeParse(host);
      if (!result.success) {
        throw new ProjectHttpError(400, 'each host must be an exact public DNS name');
      }
      parsed.push(result.data);
    }
    const requested = new Set(
      (this.deps.projects.listProjectRuns(viewer.orgId, projectId) ?? []).flatMap(
        (run) => this.deps.store.getDescriptor(viewer.orgId, run.projectRunId)?.requestedHosts ?? []
      )
    );
    for (const host of parsed) {
      if (!requested.has(host)) {
        throw new ProjectHttpError(
          400,
          'a host may be approved only after a delivered run of this project has requested it'
        );
      }
    }
    const approved = this.deps.store.replaceApprovedHosts({
      orgId: viewer.orgId,
      projectId,
      hosts: parsed,
      approvedByPrincipalId: viewer.principalId,
    });
    for (const row of this.deps.store.listLiveInstances()) {
      if (row.orgId === viewer.orgId && row.projectId === projectId) {
        await this.deps.manager.stop(row.orgId, row.projectId, row.projectRunId, 'policy-change');
      }
    }
    return { approvedHosts: approved };
  }

  private requireProject(viewer: Viewer, projectId: string): void {
    if (!this.deps.projects.getProject(viewer.orgId, projectId)) {
      throw new ProjectHttpError(404, 'project not found');
    }
  }

  /**
   * One mapping from a failure to a status code.
   *
   * `409` for a run with nothing to preview, because the request was
   * well-formed and the run's state is the reason; `429` for capacity, with
   * the delay the caller should wait; `503` for a deployment that cannot serve
   * previews at all, which is an operator's problem and not the member's.
   */
  private asHttp(error: unknown): unknown {
    if (error instanceof PreviewUnavailableError) {
      return new ProjectHttpError(409, `preview unavailable: ${error.reason}`);
    }
    if (error instanceof PreviewQuotaError) {
      return new ProjectHttpError(429, error.message);
    }
    if (error instanceof PreviewStateConflict) {
      return new ProjectHttpError(409, error.message);
    }
    if (error instanceof PreviewPolicyError || error instanceof PreviewRuntimeError) {
      // A deliverable this deployment cannot serve is the run's state, not a
      // malformed request and not a server fault the member can act on.
      return new ProjectHttpError(409, `preview could not start: ${error.message}`);
    }
    return error;
  }
}
