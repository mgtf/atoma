import type { PlatformEvent } from '../../contracts/platformEvents.js';
import type { PlatformEventLog } from '../../platform/events.js';
import { resolveAudience, type AudienceDirectory } from './router.js';
import { PUSH_ROUTES, renderPush, type PushLocale } from './routes.js';

/**
 * THE VIEWER'S NOTIFICATION TRAY — the journal, projected through the SAME
 * routing table the push path delivers from. A row is in your tray exactly
 * when `PUSH_ROUTES` would have pushed it to your devices, resolved against
 * your CURRENT roles: no second table of per-principal deliveries, no second
 * audience policy. Newest first, cursor-paged on `seq` like the admin
 * journal; copy is rendered per request in the viewer's language by the same
 * `renderPush` a subscription reads.
 *
 * ONE BUILDER, TWO DOORS. `/api/notifications` and `atoma_notifications`
 * both call this; the route is a query-string reader in front of it and the
 * tool a schema reader. Before it was extracted the loop lived inline in the
 * server, and a second consumer would have meant a second copy of the
 * bounded-scan rule below.
 */

export interface TrayNotification {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly traceId: string | null;
}

export interface TrayPage {
  readonly notifications: TrayNotification[];
  readonly nextBefore: number | null;
}

export const TRAY_DEFAULT_LIMIT = 30;
export const TRAY_MAX_LIMIT = 50;
/** Rows one page may scan before handing back a cursor with a short page. */
export const TRAY_MAX_SCAN = 1_000;

export function clampTrayLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Math.max(1, Math.min(TRAY_MAX_LIMIT, Number.isFinite(n) ? Math.trunc(n) : TRAY_DEFAULT_LIMIT));
}

export function notificationTray(input: {
  readonly journal: Pick<PlatformEventLog, 'list'>;
  readonly principalId: string;
  readonly directory: AudienceDirectory;
  readonly locale: PushLocale;
  readonly before?: number;
  readonly limit?: number;
  /** A project-run id → its trace id, so the client can link a row to its subject. */
  readonly traceIdFor?: (event: PlatformEvent) => string | null;
}): TrayPage {
  const limit = clampTrayLimit(input.limit);
  const notifications: TrayNotification[] = [];
  // Routed kinds are sparse in the journal, so the page FILLS by scanning:
  // filtering a fixed page would thin it (the journal filter rule). The scan
  // is bounded per request; a cap hit hands back the cursor with a short page
  // rather than holding the response open over 50k rows.
  let cursor = Number.isFinite(input.before) && (input.before ?? 0) > 0 ? Math.trunc(input.before!) : undefined;
  let nextBefore: number | null = null;
  for (let scanned = 0; notifications.length < limit && scanned < TRAY_MAX_SCAN; ) {
    const chunk = input.journal.list({ ...(cursor !== undefined ? { before: cursor } : {}), limit: 200 });
    for (const event of chunk.events) {
      scanned += 1;
      nextBefore = event.seq;
      const route = PUSH_ROUTES[event.kind] ?? null;
      if (!route) continue;
      if (!resolveAudience(event, route.audience, input.directory).includes(input.principalId)) continue;
      const copy = renderPush(event, input.locale, route);
      // The router's own refusal: a row that renders no title is a blank
      // line in a tray, not a degraded notification.
      if (!copy.title) continue;
      notifications.push({
        seq: event.seq,
        at: event.at,
        kind: event.kind,
        severity: event.severity,
        title: copy.title,
        body: copy.body,
        orgId: event.orgId,
        projectId: event.projectId,
        runId: event.runId,
        traceId: input.traceIdFor?.(event) ?? null,
      });
      if (notifications.length >= limit) break;
    }
    if (notifications.length >= limit) break;
    if (chunk.nextBefore === null) {
      nextBefore = null;
      break;
    }
    cursor = chunk.nextBefore;
  }
  return { notifications, nextBefore };
}
