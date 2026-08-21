import type { PushStore } from './store.js';
import type { PushLocale } from './routes.js';
import { sendWebPush, type VapidKeys } from './webpush.js';

/**
 * DELIVERY. One way to put a notification on somebody's device.
 *
 * The notifier knows nothing about events or audiences — it takes principals
 * and a per-locale renderer, and fans out to every browser those principals
 * have subscribed. Deciding WHO and WHAT is the router's job (`router.ts`),
 * and keeping the two apart is what let the run-completion path and every
 * later kind share one delivery implementation.
 *
 * Fail-open like the ledger: a push failure is stderr, never a run failure.
 * A 404/410 from the push service means the browser dropped the subscription,
 * so the row is pruned — that is the only way stale endpoints ever leave.
 */

/** Rendered per subscriber, because two devices may read two languages. */
export type PushRenderer = (locale: PushLocale) => {
  readonly title: string;
  readonly body: string;
};

export interface PushNotification {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
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

  /**
   * Notify every subscribed browser of every named principal, each in its own
   * language. Duplicate principals are collapsed so one person is not pinged
   * twice because they are both the requester and an owner.
   */
  async notifyPrincipals(
    principalIds: readonly string[],
    render: PushRenderer,
    meta: { readonly tag: string; readonly url?: string }
  ): Promise<void> {
    const unique = [...new Set(principalIds.filter(Boolean))];
    if (unique.length === 0) return;
    // One endpoint can only belong to one principal (it is the PRIMARY KEY),
    // so collecting across principals cannot duplicate a device.
    const subscriptions = unique.flatMap((principalId) =>
      this.store.listForPrincipal(principalId)
    );
    if (subscriptions.length === 0) return;
    await Promise.all(
      subscriptions.map(async (subscription) => {
        const copy = render(subscription.locale);
        const payload = Buffer.from(
          JSON.stringify({
            title: copy.title,
            body: copy.body,
            tag: meta.tag,
            url: meta.url ?? '/',
          }),
          'utf8'
        );
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
              `[atoma push] push service answered ${result.status} for ${meta.tag}\n`
            );
          }
        } catch (error) {
          process.stderr.write(`[atoma push] failed to notify ${meta.tag}: ${String(error)}\n`);
        }
      })
    );
  }
}
