import { api } from './data-api.js';
import { detectLocale } from './i18n.js';

/**
 * WEB PUSH — CLIENT SIDE.
 *
 * For MEMBERS the permission ask deliberately lives in the FIRST LIVE RUN,
 * not in the login or signup flow: a visitor who just launched work is the
 * one who understands why being pinged at delivery is worth a permission,
 * and login must stay a zero-friction surface. PLATFORM ADMINS are the
 * exception: the push routes target them for a curated set of instance-wide
 * platform events whether or not they ever launch a run, so an admin with no
 * subscription is an admin whose alerts silently go nowhere. Admins are
 * therefore asked at login, and a "not now" is remembered per browser
 * session rather than forever — the next login asks again, until the browser
 * permission itself settles.
 * `shouldOfferPushPrompt` encodes both gates; `enableWebPush` performs the
 * browser dance (permission → PushManager subscription → server save) and
 * cleans up after itself when the server never learned the subscription.
 *
 * Everything takes injectable dependencies so tests run in plain Node.
 */

export const PUSH_DISMISSED_KEY = 'atoma.viz.push.dismissed';

type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Where a dismissal is remembered decides when the question returns: members
 * dismiss into localStorage (once, for good), platform admins into
 * sessionStorage (this visit only — they must end up subscribed).
 */
export function pushPromptStorage(platformAdmin: boolean): PromptStorage | null {
  try {
    return (platformAdmin ? globalThis.sessionStorage : globalThis.localStorage) ?? null;
  } catch {
    return null;
  }
}

interface PushScope {
  readonly navigator?: { readonly serviceWorker?: unknown };
  readonly Notification?: { readonly permission?: string };
  readonly PushManager?: unknown;
}

/**
 * The one locale definition, borrowed rather than duplicated — but guarded:
 * `detectLocale` reads `location` and `localStorage`, which a non-browser
 * context does not have, and a language preference must never be the reason
 * a subscription fails.
 */
function browserLocale(): string {
  try {
    return detectLocale();
  } catch {
    return 'en';
  }
}

export function pushSupported(scope: PushScope = globalThis): boolean {
  return Boolean(scope.navigator?.serviceWorker && scope.Notification && scope.PushManager);
}

/**
 * Offer the prompt only when it can still mean something: a signed-in viewer,
 * a run currently alive, browser support, a permission still undecided, and
 * no earlier "not now". Platform admins skip the live-run gate — the offer is
 * part of their login — and their dismissal is read from sessionStorage, so a
 * fresh session asks again. The service worker registers in production builds
 * only, so a dev session never dangles an enable button that cannot finish.
 */
export function shouldOfferPushPrompt(input: {
  readonly authenticated: boolean;
  readonly hasLiveRun: boolean;
  readonly platformAdmin?: boolean;
  readonly scope?: PushScope;
  readonly storage?: PromptStorage | null;
  readonly prod?: boolean;
}): boolean {
  const prod = input.prod ?? import.meta.env.PROD;
  const admin = input.platformAdmin === true;
  if (!prod || !input.authenticated) return false;
  if (!admin && !input.hasLiveRun) return false;
  const scope = input.scope ?? (globalThis);
  if (!pushSupported(scope)) return false;
  if (scope.Notification?.permission !== 'default') return false;
  const storage = input.storage === undefined ? pushPromptStorage(admin) : input.storage;
  try {
    if (storage?.getItem(PUSH_DISMISSED_KEY)) return false;
  } catch {
    return false;
  }
  return true;
}

export function dismissPushPrompt(storage: PromptStorage | null = pushPromptStorage(false)): void {
  try {
    storage?.setItem(PUSH_DISMISSED_KEY, new Date().toISOString());
  } catch {
    // Private-mode storage failures degrade to asking again next session.
  }
}

/**
 * Logout ends the admin grace: sessionStorage survives a same-tab
 * logout/login, so without this the "not now" from before signing out would
 * silently swallow the next login's offer — "re-ask at login" means the
 * LOGIN, not the browser tab.
 */
export function clearSessionPushDismissal(
  storage: Pick<Storage, 'removeItem'> | null = sessionStorageOrNull()
): void {
  try {
    storage?.removeItem(PUSH_DISMISSED_KEY);
  } catch {
    // Nothing stored means nothing to clear.
  }
}

function sessionStorageOrNull(): Pick<Storage, 'removeItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A permission already GRANTED needs no prompt and no gesture: an admin whose
 * browser said yes once — perhaps as a member, before the flag, or whose
 * server row was pruned by a 410 — is silently re-subscribed at login.
 * Without this, "granted" is exactly the state the offer never fires in
 * (`permission !== 'default'`), and the admin who already agreed would be the
 * one admin who never hears anything.
 */
export function shouldEnsureAdminSubscription(input: {
  readonly authenticated: boolean;
  readonly platformAdmin: boolean;
  readonly scope?: PushScope;
  readonly prod?: boolean;
}): boolean {
  const prod = input.prod ?? import.meta.env.PROD;
  if (!prod || !input.authenticated || !input.platformAdmin) return false;
  const scope = input.scope ?? (globalThis);
  if (!pushSupported(scope)) return false;
  return scope.Notification?.permission === 'granted';
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
      locale: string;
    }) => Promise<unknown>;
    /** The language this browser reads, sent once with the subscription. */
    readonly locale?: string;
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
        // Sent at subscribe time because the server has no later chance to
        // learn it: a push is generated from an event, not from a request.
        locale: deps.locale ?? browserLocale(),
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
