import { describe, expect, it, vi } from 'vitest';
import {
  applicationServerKeyBytes,
  dismissPushPrompt,
  enableWebPush,
  PUSH_DISMISSED_KEY,
  pushSupported,
  shouldOfferPushPrompt,
  type PushRegistrationLike,
  type PushSubscriptionLike,
} from '../src/viz/client/push.js';
import { generateVapidKeys, toBase64Url } from '../src/viz/push/webpush.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
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

  it('never offers at login time or without a live run — the run is the moment', () => {
    expect(shouldOfferPushPrompt({ ...eligible, authenticated: false })).toBe(false);
    expect(shouldOfferPushPrompt({ ...eligible, hasLiveRun: false })).toBe(false);
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
    const save = vi.fn(async () => ({ subscribed: true }));
    const keys = generateVapidKeys();
    const outcome = await enableWebPush({
      requestPermission: async () => 'granted',
      registration: async () => registration,
      fetchConfig: async () => ({ enabled: true, publicKey: keys.publicKey }),
      save,
    });
    expect(outcome).toBe('enabled');
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKeyBytes(keys.publicKey),
    });
    expect(save).toHaveBeenCalledOnce();
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
