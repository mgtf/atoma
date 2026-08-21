import type { ProjectRunFinishedEvent } from '../../projects/coordinator.js';
import type { PushStore } from './store.js';
import { sendWebPush, type VapidKeys } from './webpush.js';

/**
 * RUN-COMPLETION PUSHES. The one server-side moment a run's outcome is known
 * is `ProjectRunCoordinator.finish`; it hands the terminal event here through
 * the `onRunFinished` hook. Delivery is fail-open like the ledger: a push
 * failure is stderr, never a run failure. Payloads stay boring on purpose —
 * a status title, a bounded goal excerpt, a same-origin path — because the
 * body crosses a third-party push service and lands on a lock screen.
 */

const GOAL_EXCERPT_MAX_CHARS = 140;

const TITLES: Record<ProjectRunFinishedEvent['status'], string> = {
  delivered: 'Atoma — run delivered',
  failed: 'Atoma — run failed',
  cancelled: 'Atoma — run cancelled',
};

export interface RunFinishedNotification {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
}

export function runFinishedNotification(
  event: ProjectRunFinishedEvent
): RunFinishedNotification {
  const goal = event.goal.trim().replace(/\s+/g, ' ');
  return {
    title: TITLES[event.status],
    body:
      goal.length > GOAL_EXCERPT_MAX_CHARS
        ? `${goal.slice(0, GOAL_EXCERPT_MAX_CHARS - 1)}…`
        : goal,
    tag: `atoma-run-${event.projectRunId}`,
    url: '/',
  };
}

export interface PushNotifierOptions {
  readonly store: PushStore;
  readonly vapid: VapidKeys;
  readonly subject: string;
  readonly fetchImpl?: typeof fetch;
}

export class PushNotifier {
  private readonly store: PushStore;
  private readonly vapid: VapidKeys;
  private readonly subject: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: PushNotifierOptions) {
    this.store = options.store;
    this.vapid = options.vapid;
    this.subject = options.subject;
    this.fetchImpl = options.fetchImpl;
  }

  /** Notify every subscription of the principal who requested the run. */
  async notifyRunFinished(event: ProjectRunFinishedEvent): Promise<void> {
    const subscriptions = this.store.listForPrincipal(event.principalId);
    if (subscriptions.length === 0) return;
    const payload = Buffer.from(JSON.stringify(runFinishedNotification(event)), 'utf8');
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          const result = await sendWebPush({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            payload,
            vapid: this.vapid,
            subject: this.subject,
            ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          });
          if (result.gone) {
            this.store.dropEndpoint(subscription.endpoint);
          } else if (!result.ok) {
            process.stderr.write(
              `[atoma push] push service answered ${result.status} for run ${event.projectRunId}\n`
            );
          }
        } catch (error) {
          process.stderr.write(
            `[atoma push] failed to notify run ${event.projectRunId}: ${String(error)}\n`
          );
        }
      })
    );
  }
}
