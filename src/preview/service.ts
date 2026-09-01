import {
  previewSummarySchema,
  type PreviewDescriptor,
  type PreviewInstance,
  type PreviewSummary,
} from '../contracts/preview.js';
import type { DeliveredPreviewSubject } from '../projects/coordinator.js';
import { buildPreviewDescriptor } from './descriptor.js';
import { effectiveEgressHosts, PreviewStore } from './store.js';

/**
 * THE PREVIEW SERVICE — what the feature DOES, with no transport in it.
 *
 * Deliberately not written inside `src/viz/server.ts`. That file already
 * composes auth, projects, GitHub, push, announcements and the sentinel while
 * still describing itself as a tiny read-only server, and the 2026-08-26
 * Lovable review named it the concrete gap to close: "amincir l'adaptateur
 * HTTP et extraire les services par strangler", starting with one coherent
 * group rather than a rewrite (`docs/lovable-lessons-atoma-2026-08-26.md` §1
 * and §3-P1). The preview is a new coherent group, so it is born extracted:
 * routes translate a request and call in here; the CLI calls the same
 * functions; both stay testable without a socket.
 */

/**
 * Classify a freshly delivered workspace and store the immutable descriptor.
 *
 * Called from inside the delivery path, so it must be quick and total: the
 * classifier reads two small bounded files and stats a handful of candidate
 * names, and returns a reason rather than throwing for anything it meets in a
 * workspace. What it does NOT swallow is a store failure — the coordinator's
 * own guard reports that, because a store that cannot write is a fact an
 * operator needs, not one to hide behind a preview.
 */
export function recordDeliveredPreview(
  store: PreviewStore,
  subject: DeliveredPreviewSubject,
  now?: Date
): PreviewDescriptor {
  return store.putDescriptor(
    buildPreviewDescriptor({
      orgId: subject.orgId,
      projectId: subject.projectId,
      projectRunId: subject.projectRunId,
      workspaceRoot: subject.workspaceRoot,
      ...(now ? { now } : {}),
    })
  );
}

/**
 * The only shape a browser receives, assembled from the three rows.
 *
 * A MISSING DESCRIPTOR IS `legacy-run`, not an error and not an empty screen:
 * runs delivered before this contract existed are simply not described, there
 * is no backfill, and saying so lets the surface offer the one thing that
 * actually helps — start a new run. A missing INSTANCE is `stopped` at
 * generation 0, which is the truthful reading of "nothing is running".
 */
export function previewSummary(input: {
  readonly descriptor: PreviewDescriptor | null;
  readonly instance: PreviewInstance | null;
  readonly approvedHosts: readonly string[];
}): PreviewSummary {
  const { descriptor, instance } = input;
  const requestedHosts = descriptor?.requestedHosts ?? [];
  const { allowed, blocked } = effectiveEgressHosts(requestedHosts, input.approvedHosts);
  return previewSummarySchema.parse({
    availability: descriptor?.availability ?? 'unavailable',
    kind: descriptor?.kind ?? null,
    reason: descriptor ? descriptor.unavailableReason : 'legacy-run',
    state: instance?.state ?? 'stopped',
    generation: instance?.generation ?? 0,
    readyAt: instance?.readyAt ?? null,
    expiresAt: instance?.expiresAt ?? null,
    errorCode: instance?.errorCode ?? null,
    requestedHosts,
    allowedHosts: allowed,
    blockedHosts: blocked,
  });
}

/** Read a run's complete preview state in one place. */
export function readPreviewSummary(
  store: PreviewStore,
  input: { readonly orgId: string; readonly projectId: string; readonly projectRunId: string }
): PreviewSummary {
  const descriptor = store.getDescriptor(input.orgId, input.projectRunId);
  return previewSummary({
    descriptor,
    instance: store.getInstance(input.orgId, input.projectRunId),
    approvedHosts: store.listApprovedHosts(input.orgId, input.projectId),
  });
}
