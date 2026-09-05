import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { MEND_REQUEST_SCHEMA_TAG, mendRequestSchema, type MendRequest } from '../contracts/supervisorMend.js';
import type { FindingConfidence, SupervisorVerdict } from '../contracts/supervisorVerdict.js';
import { dispatchedEvent } from './journal.js';
import { defectKey, eligibleFindings, sanitiseFinding } from './menderPolicy.js';

/**
 * HANDING A DEFECT TO THE MENDER ACROSS A BOUNDARY.
 *
 * The production host runs the analyst and must not run the mender: it is the
 * machine that serves tenants, it holds no git checkout, no `gh`, no
 * devDependencies, and a full check beside a customer run is exactly what the
 * idle gate exists to prevent. The repository's CI has everything the mender
 * needs and nothing else to do. So a verdict's eligible defects are SENT — a
 * GitHub `repository_dispatch` whose client payload is one `MendRequest` —
 * and `.github/workflows/mender.yml` picks them up.
 *
 * What crosses the wire is the SANITISED finding: no trace text, no verdict
 * summary, no raw evidence. The workflow's model reads the same shape the
 * local mender would have built for itself, so where the mender runs changes
 * nothing about what it may see.
 *
 * The token is a fine-grained personal access token or an App installation
 * token with `contents: write` on the repository — the permission
 * `repository_dispatch` requires. It is read from the environment at the
 * emitting process and never journaled. A dispatch is journaled as
 * `mender.dispatched` with the key and the target, so an operator can join a
 * later pull request back to the run that asked for it.
 */

export const DISPATCH_REPO_ENV = 'ATOMA_MENDER_DISPATCH_REPO';
export const DISPATCH_TOKEN_ENV = 'ATOMA_MENDER_DISPATCH_TOKEN';
export const DISPATCH_EVENT_ENV = 'ATOMA_MENDER_DISPATCH_EVENT';
export const DISPATCH_MIN_CONFIDENCE_ENV = 'ATOMA_MENDER_DISPATCH_MIN_CONFIDENCE';
export const DISPATCH_INSTANCE_ENV = 'ATOMA_MENDER_DISPATCH_INSTANCE';
export const DEFAULT_DISPATCH_EVENT = 'atoma-mend';

export interface DispatchConfig {
  /** `owner/name`. */
  readonly repo: string;
  readonly token: string;
  readonly eventType: string;
  readonly minConfidence: FindingConfidence;
  readonly instance: string | null;
  readonly apiBase: string;
}

/** Null unless BOTH the repository and the token are set: half a config dispatches nothing. */
export function dispatchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DispatchConfig | null {
  const repo = env[DISPATCH_REPO_ENV]?.trim();
  const token = env[DISPATCH_TOKEN_ENV]?.trim();
  if (!repo || !token) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`${DISPATCH_REPO_ENV} must be owner/name, got "${repo}"`);
  }
  const confidence = env[DISPATCH_MIN_CONFIDENCE_ENV]?.trim();
  const minConfidence: FindingConfidence =
    confidence === 'low' || confidence === 'medium' || confidence === 'high' ? confidence : 'high';
  return {
    repo,
    token,
    eventType: env[DISPATCH_EVENT_ENV]?.trim() || DEFAULT_DISPATCH_EVENT,
    minConfidence,
    instance: env[DISPATCH_INSTANCE_ENV]?.trim() || null,
    apiBase: 'https://api.github.com',
  };
}

/** The requests one verdict produces: one per eligible defect. */
export function mendRequestsFor(verdict: SupervisorVerdict, config: Pick<DispatchConfig, 'minConfidence' | 'instance'>): MendRequest[] {
  return eligibleFindings(verdict, config.minConfidence).map(({ index, finding }) =>
    mendRequestSchema.parse({
      schema: MEND_REQUEST_SCHEMA_TAG,
      runId: verdict.runId,
      findingIndex: index,
      key: defectKey(finding),
      runStatus: verdict.runStatus,
      runGrade: verdict.runAssessment.grade,
      finding: sanitiseFinding(finding),
      ...(config.instance ? { instance: config.instance } : {}),
    })
  );
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

export interface DispatchOutcome {
  readonly request: MendRequest;
  readonly ok: boolean;
  readonly status: number | null;
  readonly detail: string | null;
}

/**
 * Send every request, one HTTP call each; a refusal is warned about and
 * journaled as nothing — a row about a dispatch that did not happen would be
 * a fact about nothing. Never throws into the analyst.
 */
export async function dispatchMendRequests(input: {
  readonly requests: readonly MendRequest[];
  readonly config: DispatchConfig;
  readonly journal: PlatformEventSink;
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly warn: (line: string) => void;
  readonly fetchImpl?: FetchLike;
}): Promise<DispatchOutcome[]> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const out: DispatchOutcome[] = [];
  for (const request of input.requests) {
    try {
      const response = await fetchImpl(`${input.config.apiBase}/repos/${input.config.repo}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.config.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'atoma-supervisor',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: input.config.eventType, client_payload: request }),
      });
      if (response.status === 204) {
        input.journal(
          dispatchedEvent({
            runId: request.runId,
            findingIndex: request.findingIndex,
            key: request.key,
            repo: input.config.repo,
            eventType: input.config.eventType,
            orgId: input.orgId ?? null,
            projectId: input.projectId ?? null,
          })
        );
        out.push({ request, ok: true, status: 204, detail: null });
      } else {
        const text = (await response.text()).slice(0, 300);
        input.warn(`repository_dispatch to ${input.config.repo} refused (${response.status}) for ${request.runId}#${request.findingIndex}: ${text}`);
        out.push({ request, ok: false, status: response.status, detail: text });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      input.warn(`repository_dispatch to ${input.config.repo} failed for ${request.runId}#${request.findingIndex}: ${detail}`);
      out.push({ request, ok: false, status: null, detail });
    }
  }
  return out;
}
