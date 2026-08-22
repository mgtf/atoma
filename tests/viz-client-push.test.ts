import { describe, expect, it, vi } from 'vitest';
import {
  applicationServerKeyBytes,
  clearSessionPushDismissal,
  dismissPushPrompt,
  enableWebPush,
  PUSH_DISMISSED_KEY,
  pushPromptStorage,
  pushSupported,
  shouldEnsureAdminSubscription,
  shouldOfferPushPrompt,
  type PushRegistrationLike,
  type PushSubscriptionLike,
} from '../src/viz/client/push.js';
import { generateVapidKeys, toBase64Url } from '../src/viz/push/webpush.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const supportedScope = {
  navigator: { serviceWorker: {} },
  Notification: { permission: 'default' },
  PushManager: function PushManager() {},
};

describe('shouldOfferPushPrompt', () => {
  const eligible = {
    authenticated: true,
    hasLiveRun: true,
    scope: supportedScope,
    storage: memoryStorage(),
    prod: true,
  };

  it('offers exactly when a signed-in viewer has a live run in a capable browser', () => {
    expect(shouldOfferPushPrompt(eligible)).toBe(true);
  });

  it('never offers members at login time or without a live run — the run is the moment', () => {
    expect(shouldOfferPushPrompt({ ...eligible, authenticated: false })).toBe(false);
    expect(shouldOfferPushPrompt({ ...eligible, hasLiveRun: false })).toBe(false);
  });

  it('offers a platform admin at login, run or no run — admins must end up subscribed', () => {
    expect(
      shouldOfferPushPrompt({ ...eligible, hasLiveRun: false, platformAdmin: true })
    ).toBe(true);
    // Authentication and the browser permission still gate everyone.
    expect(
      shouldOfferPushPrompt({
        ...eligible,
        hasLiveRun: false,
        platformAdmin: true,
        authenticated: false,
      })
    ).toBe(false);
    expect(
      shouldOfferPushPrompt({
        ...eligible,
        hasLiveRun: false,
        platformAdmin: true,
        scope: { ...supportedScope, Notification: { permission: 'denied' } },
      })
    ).toBe(false);
  });

  it("an admin's dismissal lives in sessionStorage, so the next session asks again", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    try {
      const memberStorage = pushPromptStorage(false);
      const adminStorage = pushPromptStorage(true);
      expect(memberStorage).toBe(local);
      expect(adminStorage).toBe(session);

      // A member's forever-dismissal never silences the admin login offer.
      dismissPushPrompt(memberStorage);
      expect(
        shouldOfferPushPrompt({
          ...eligible,
          hasLiveRun: false,
          platformAdmin: true,
          storage: adminStorage,
        })
      ).toBe(true);
      dismissPushPrompt(adminStorage);
      expect(
        shouldOfferPushPrompt({
          ...eligible,
          hasLiveRun: false,
          platformAdmin: true,
          storage: adminStorage,
        })
      ).toBe(false);

      // Logout ends the grace: the cleared store re-offers on the next login,
      // even in the same tab (sessionStorage survives a same-tab re-login).
      clearSessionPushDismissal();
      expect(
        shouldOfferPushPrompt({
          ...eligible,
          hasLiveRun: false,
          platformAdmin: true,
          storage: adminStorage,
        })
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    // No sessionStorage at all (plain Node) is a quiet no-op.
    expect(() => clearSessionPushDismissal()).not.toThrow();
  });

  it('silently re-subscribes an admin whose permission is already granted', () => {
    const granted = { ...supportedScope, Notification: { permission: 'granted' } };
    const base = { authenticated: true, platformAdmin: true, scope: granted, prod: true };
    expect(shouldEnsureAdminSubscription(base)).toBe(true);
    // Only a signed-in admin, in prod, in a capable browser, with a granted
    // permission — anything else is either the prompt's job or nobody's.
    expect(shouldEnsureAdminSubscription({ ...base, platformAdmin: false })).toBe(false);
    expect(shouldEnsureAdminSubscription({ ...base, authenticated: false })).toBe(false);
    expect(shouldEnsureAdminSubscription({ ...base, prod: false })).toBe(false);
    expect(shouldEnsureAdminSubscription({ ...base, scope: supportedScope })).toBe(false);
    expect(
      shouldEnsureAdminSubscription({ ...base, scope: { ...granted, PushManager: undefined } })
    ).toBe(false);
  });

  it('respects an earlier decision: dismissal, denial or a granted permission', () => {
    const storage = memoryStorage();
    dismissPushPrompt(storage);
    expect(storage.data.has(PUSH_DISMISSED_KEY)).toBe(true);
    expect(shouldOfferPushPrompt({ ...eligible, storage })).toBe(false);
    for (const permission of ['granted', 'denied']) {
      expect(
        shouldOfferPushPrompt({
          ...eligible,
          scope: { ...supportedScope, Notification: { permission } },
        })
      ).toBe(false);
    }
  });

  it('stays silent in dev builds and unsupported browsers', () => {
    expect(shouldOfferPushPrompt({ ...eligible, prod: false })).toBe(false);
    expect(
      shouldOfferPushPrompt({ ...eligible, scope: { ...supportedScope, PushManager: undefined } })
    ).toBe(false);
    expect(pushSupported({})).toBe(false);
  });
});

describe('applicationServerKeyBytes', () => {
  it('round-trips the server key from base64url to raw bytes', () => {
    const keys = generateVapidKeys();
    const bytes = applicationServerKeyBytes(keys.publicKey);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
    expect(toBase64Url(bytes)).toBe(keys.publicKey);
  });
});

describe('enableWebPush', () => {
  function fakeSubscription(overrides: Partial<ReturnType<PushSubscriptionLike['toJSON']>> = {}) {
    const unsubscribe = vi.fn(async () => true);
    const subscription: PushSubscriptionLike = {
      toJSON: () => ({
        endpoint: 'https://push.example.net/send/abc',
        keys: { p256dh: generateVapidKeys().publicKey, auth: toBase64Url(Buffer.alloc(16)) },
        ...overrides,
      }),
      unsubscribe,
    };
    return { subscription, unsubscribe };
  }

  /**
   * Typed so `save.mock.calls[0][0]` is the BODY rather than a zero-length
   * tuple: an untyped `vi.fn(async () => …)` infers no parameters and makes
   * every argument assertion silently unreachable.
   */
  const saveSpy = async (_body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    locale: string;
  }) => ({ subscribed: true });

  function fakeRegistration(existing: PushSubscriptionLike | null, minted?: PushSubscriptionLike) {
    const subscribe = vi.fn(async () => {
      if (!minted) throw new Error('unexpected subscribe');
      return minted;
    });
    const registration: PushRegistrationLike = {
      pushManager: { getSubscription: async () => existing, subscribe },
    };
    return { registration, subscribe };
  }

  it('subscribes with the server key and saves the subscription', async () => {
    const { subscription } = fakeSubscription();
    const { registration, subscribe } = fakeRegistration(null, subscription);
    const save = vi.fn(saveSpy);
    const keys = generateVapidKeys();
    const outcome = await enableWebPush({
      requestPermission: async () => 'granted',
      registration: async () => registration,
      fetchConfig: async () => ({ enabled: true, publicKey: keys.publicKey }),
      save,
      locale: 'fr',
    });
    expect(outcome).toBe('enabled');
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKeyBytes(keys.publicKey),
    });
    expect(save).toHaveBeenCalledOnce();
    // The language rides the subscription: the server has no later chance to
    // learn it, because a push is generated from an event, not a request.
    expect(save.mock.calls[0]?.[0]).toMatchObject({ locale: 'fr' });
  });

  it('falls back to English when no browser locale can be read', async () => {
    const { subscription } = fakeSubscription();
    const { registration } = fakeRegistration(null, subscription);
    const save = vi.fn(saveSpy);
    // No `locale` dep and no DOM: `detectLocale` throws on `location`, and a
    // language preference must never be why a subscription fails.
    await enableWebPush({
      requestPermission: async () => 'granted',
      registration: async () => registration,
      fetchConfig: async () => ({ enabled: true, publicKey: generateVapidKeys().publicKey }),
      save,
    });
    expect(save.mock.calls[0]?.[0]).toMatchObject({ locale: 'en' });
  });

  it('reuses an existing browser subscription instead of minting a second one', async () => {
    const { subscription } = fakeSubscription();
    const { registration, subscribe } = fakeRegistration(subscription);
    const outcome = await enableWebPush({
      requestPermission: async () => 'granted',
      registration: async () => registration,
      fetchConfig: async () => ({ enabled: true, publicKey: generateVapidKeys().publicKey }),
      save: async () => ({ subscribed: true }),
    });
    expect(outcome).toBe('enabled');
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('a refused permission is denied, an ungated server is unsupported', async () => {
    await expect(
      enableWebPush({
        requestPermission: async () => 'denied',
        registration: async () => fakeRegistration(null).registration,
        fetchConfig: async () => ({ enabled: true, publicKey: 'x' }),
        save: async () => ({}),
      })
    ).resolves.toBe('denied');
    await expect(
      enableWebPush({
        requestPermission: async () => 'granted',
        registration: async () => fakeRegistration(null).registration,
        fetchConfig: async () => ({ enabled: false }),
        save: async () => ({}),
      })
    ).resolves.toBe('unsupported');
  });

  it('unsubscribes a freshly minted subscription the server never learned', async () => {
    const { subscription, unsubscribe } = fakeSubscription();
    const { registration } = fakeRegistration(null, subscription);
    const outcome = await enableWebPush({
      requestPermission: async () => 'granted',
      registration: async () => registration,
      fetchConfig: async () => ({ enabled: true, publicKey: generateVapidKeys().publicKey }),
      save: async () => {
        throw new Error('HTTP 500');
      },
    });
    expect(outcome).toBe('error');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
