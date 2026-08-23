import type { PlatformEvent } from '../../contracts/platformEvents.js';
import type { PushNotifier } from './notifier.js';
import { DEFAULT_LOCALE } from '../../contracts/locales.js';
import { PUSH_ROUTES, renderPush, type AudienceRule } from './routes.js';

/**
 * FROM ONE JOURNALED EVENT TO THE RIGHT DEVICES.
 *
 * The router subscribes to the platform event log and is the ONLY thing that
 * turns events into pushes. Everything it needs to decide lives in
 * `PUSH_ROUTES` (audience + copy, one entry per kind), so routing policy is
 * read in one table rather than reconstructed from call sites.
 *
 * Audience resolution is injected as two small readers rather than an
 * `AuthStore`, because the router's rules are worth testing without a
 * database and because it must never be able to write identity state.
 */

export interface AudienceDirectory {
  /** Principal ids holding `org:owner` in this organisation. */
  ownersOf(orgId: string): readonly string[];
  /** Principal ids holding the instance-wide operator flag. */
  platformAdmins(): readonly string[];
  /** Every principal the instance knows. Only an announcement reaches here. */
  allPrincipals(): readonly string[];
  /** Every member of these organisations, in one read. */
  membersOf(orgIds: readonly string[]): readonly string[];
}

export interface NotificationRouterOptions {
  readonly notifier: PushNotifier;
  readonly directory: AudienceDirectory;
}

/**
 * Resolve one rule to a recipient set.
 *
 * The actor is REMOVED unless the rule names them as `requester`: nobody
 * needs a phone buzz telling them what they just did. That single subtraction
 * is why `requester` is a distinct flag instead of "the actor is always
 * included" — `run.finished` genuinely must reach the person who started it.
 */
/**
 * The organisations an event names as its own narrower scope. Only an
 * announcement carries this, and only for a segment narrower than "everyone".
 */
function scopedOrgIds(event: PlatformEvent): string[] | null {
  const value = event.detail?.['orgIds'];
  if (!Array.isArray(value)) return null;
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return ids.length > 0 ? ids : null;
}

export function resolveAudience(
  event: PlatformEvent,
  rule: AudienceRule,
  directory: AudienceDirectory
): string[] {
  const recipients = new Set<string>();
  if (rule.requester && event.actorId) recipients.add(event.actorId);
  if (rule.orgOwners && event.orgId) {
    for (const owner of directory.ownersOf(event.orgId)) recipients.add(owner);
  }
  if (rule.platformAdmins) {
    for (const admin of directory.platformAdmins()) recipients.add(admin);
  }
  // PRECEDENCE, stated once: an event may be NARROWER than its rule, never
  // wider. A rule allowing both reaches means "everyone, unless this event
  // named the organisations it is for" — so a segmented announcement can
  // never widen into a broadcast by way of an empty list, and a broadcast
  // never needs to enumerate every organisation to say "all of them".
  const scoped = rule.orgMembers ? scopedOrgIds(event) : null;
  if (scoped) {
    for (const member of directory.membersOf(scoped)) recipients.add(member);
  } else if (rule.everyone) {
    for (const principal of directory.allPrincipals()) recipients.add(principal);
  }
  if (!rule.requester && event.actorId) recipients.delete(event.actorId);
  return [...recipients];
}

export class NotificationRouter {
  private readonly notifier: PushNotifier;
  private readonly directory: AudienceDirectory;

  constructor(options: NotificationRouterOptions) {
    this.notifier = options.notifier;
    this.directory = options.directory;
  }

  /**
   * Handle one journaled event. Returns a promise so a caller can await it in
   * tests; the event log's bus never awaits, and a rejection there is caught
   * and warned about rather than propagated.
   */
  async handle(event: PlatformEvent): Promise<void> {
    // A foreign row from a newer build has no route here. Reading the table
    // defensively rather than indexing blindly keeps an unknown kind a no-op
    // instead of a crash inside the bus.
    const route = PUSH_ROUTES[event.kind] ?? null;
    if (!route) return;
    let recipients: string[];
    try {
      recipients = resolveAudience(event, route.audience, this.directory);
    } catch (error) {
      process.stderr.write(
        `[atoma push] failed to resolve the audience for ${event.kind}: ${String(error)}\n`
      );
      return;
    }
    if (recipients.length === 0) return;
    // A push with no TITLE is not a degraded notification, it is a blank one
    // in the reader's tray. Frozen copy can never be empty, so this can only
    // fire on a kind whose text comes from the event — an announcement row
    // that is malformed, or written by a build with a shape this one cannot
    // read. Tolerating the row means not crashing; it does not mean sending
    // nothing to everybody.
    if (!renderPush(event, DEFAULT_LOCALE, route).title) {
      process.stderr.write(
        `[atoma push] ${event.kind} #${event.seq} renders no title — not delivered\n`
      );
      return;
    }
    await this.notifier.notifyPrincipals(
      recipients,
      (locale) => renderPush(event, locale, route),
      // One tag per EVENT, so a device replaces an earlier notification about
      // the same fact instead of stacking duplicates.
      { tag: `atoma-${event.kind}-${event.seq}`, url: '/' }
    );
  }
}
