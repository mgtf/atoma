import { api } from './data-api.js';

/**
 * WEB PUSH — CLIENT SIDE.
 *
 * The permission ask deliberately lives in the FIRST LIVE RUN, not in the
 * login or signup flow: a visitor who just launched work is the one who
 * understands why being pinged at delivery is worth a permission. Login must
 * stay a zero-friction surface. `shouldOfferPushPrompt` encodes that gate;
 * `enableWebPush` performs the browser dance (permission → PushManager
 * subscription → server save) and cleans up after itself when the server
 * never learned the subscription.
 *
 * Everything takes injectable dependencies so tests run in plain Node.
 */

export const PUSH_DISMISSED_KEY = 'atoma.viz.push.dismissed';

type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): PromptStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

interface PushScope {
  readonly navigator?: { readonly serviceWorker?: unknown };
  readonly Notification?: { readonly permission?: string };
  readonly PushManager?: unknown;
}

export function pushSupported(scope: PushScope = globalThis): boolean {
  return Boolean(scope.navigator?.serviceWorker && scope.Notification && scope.PushManager);
}

/**
 * Offer the prompt only when it can still mean something: a signed-in viewer,
 * a run currently alive, browser support, a permission still undecided, and
 * no earlier "not now". The service worker registers in production builds
 * only, so a dev session never dangles an enable button that cannot finish.
 */
export function shouldOfferPushPrompt(input: {
  readonly authenticated: boolean;
  readonly hasLiveRun: boolean;
  readonly scope?: PushScope;
  readonly storage?: PromptStorage | null;
  readonly prod?: boolean;
}): boolean {
  const prod = input.prod ?? import.meta.env.PROD;
  if (!prod || !input.authenticated || !input.hasLiveRun) return false;
  const scope = input.scope ?? (globalThis);
  if (!pushSupported(scope)) return false;
  if (scope.Notification?.permission !== 'default') return false;
  const storage = input.storage === undefined ? safeStorage() : input.storage;
  try {
    if (storage?.getItem(PUSH_DISMISSED_KEY)) return false;
  } catch {
    return false;
  }
  return true;
}

export function dismissPushPrompt(storage: PromptStorage | null = safeStorage()): void {
  try {
    storage?.setItem(PUSH_DISMISSED_KEY, new Date().toISOString());
  } catch {
    // Private-mode storage failures degrade to asking again next session.
  }
}

/** `applicationServerKey` wants raw bytes; the server speaks base64url. */
export function applicationServerKeyBytes(publicKey: string): Uint8Array {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export interface PushSubscriptionLike {
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushRegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    }): Promise<PushSubscriptionLike>;
  };
}

export type EnablePushOutcome = 'enabled' | 'denied' | 'unsupported' | 'error';

export async function enableWebPush(
  deps: {
    readonly requestPermission?: () => Promise<NotificationPermission>;
    readonly registration?: () => Promise<PushRegistrationLike>;
    readonly fetchConfig?: () => Promise<{ enabled: boolean; publicKey?: string }>;
    readonly save?: (body: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    }) => Promise<unknown>;
  } = {}
): Promise<EnablePushOutcome> {
  if (!deps.registration && !pushSupported()) return 'unsupported';
  const requestPermission =
    deps.requestPermission ?? (() => Notification.requestPermission());
  const resolveRegistration =
    deps.registration ??
    (async () => (await navigator.serviceWorker.ready) as unknown as PushRegistrationLike);
  const fetchConfig = deps.fetchConfig ?? api.pushConfig;
  const save = deps.save ?? api.subscribePush;

  let permission: NotificationPermission;
  try {
    permission = await requestPermission();
  } catch {
    return 'error';
  }
  if (permission !== 'granted') return 'denied';
  try {
    const config = await fetchConfig();
    if (!config.enabled || !config.publicKey) return 'unsupported';
    const registration = await resolveRegistration();
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKeyBytes(config.publicKey),
      }));
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
      if (!existing) await subscription.unsubscribe().catch(() => false);
      return 'error';
    }
    try {
      await save({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
    } catch (error) {
      // The server never learned this subscription: do not leave the browser
      // holding an orphan that would push into the void forever.
      if (!existing) await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    return 'enabled';
  } catch {
    return 'error';
  }
}
