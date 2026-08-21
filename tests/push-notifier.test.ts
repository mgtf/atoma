import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { PushNotifier } from '../src/viz/push/notifier.js';
import type { PushLocale } from '../src/viz/push/routes.js';
import { PushStore } from '../src/viz/push/store.js';
import { toBase64Url } from '../src/viz/push/webpush.js';

const roots: string[] = [];

afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A browser-side keypair plus the RFC 8291 decryption it would perform. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const decrypt = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    expect(body.readUInt8(20)).toBe(65);
    const asPublic = body.subarray(21, 86);
    const sealed = body.subarray(86);
    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      ecdh.getPublicKey(),
      asPublic,
    ]);
    const ikm = Buffer.from(
      hkdfSync('sha256', ecdh.computeSecret(asPublic), authSecret, keyInfo, 32)
    );
    const key = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
    );
    const nonce = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
    );
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const padded = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);
    expect(padded[padded.length - 1]).toBe(0x02);
    return padded.subarray(0, padded.length - 1).toString('utf8');
  };
  return {
    p256dh: toBase64Url(ecdh.getPublicKey()),
    auth: toBase64Url(authSecret),
    decrypt,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-push-notifier-'));
  roots.push(root);
  return PushStore.open(join(root, 'atoma.db'));
}

function notifierFor(
  store: PushStore,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
) {
  return new PushNotifier({
    store,
    vapid: store.vapidKeys(),
    subject: 'https://viz.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

/** Localised copy, the shape the router hands the notifier. */
const render = (locale: PushLocale) =>
  locale === 'fr'
    ? { title: 'Atoma — run livré', body: 'Construire une horloge' }
    : { title: 'Atoma — run delivered', body: 'Build a clock' };

describe('PushNotifier.notifyPrincipals', () => {
  it('delivers a payload the subscribed browser can decrypt', async () => {
    const store = fixture();
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-1',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    const bodies: Buffer[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(Buffer.from(init!.body as Buffer));
      return new Response(null, { status: 201 });
    });

    await notifierFor(store, fetchImpl).notifyPrincipals(['alice'], render, {
      tag: 'atoma-run.finished-7',
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const decrypted = JSON.parse(chrome.decrypt(bodies[0]!)) as Record<string, string>;
    expect(decrypted).toEqual({
      title: 'Atoma — run delivered',
      body: 'Build a clock',
      tag: 'atoma-run.finished-7',
      url: '/',
    });
  });

  it('renders each device in the language it subscribed with', async () => {
    const store = fixture();
    const english = browser();
    const french = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-en',
      p256dh: english.p256dh,
      auth: english.auth,
      locale: 'en',
    });
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-fr',
      p256dh: french.p256dh,
      auth: french.auth,
      locale: 'fr',
    });
    const sent = new Map<string, Buffer>();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      sent.set(url, Buffer.from(init!.body as Buffer));
      return new Response(null, { status: 201 });
    });

    await notifierFor(store, fetchImpl).notifyPrincipals(['alice'], render, { tag: 'tag-1' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const enPayload = JSON.parse(
      english.decrypt(sent.get('https://push.example.net/send/alice-en')!)
    ) as Record<string, string>;
    const frPayload = JSON.parse(
      french.decrypt(sent.get('https://push.example.net/send/alice-fr')!)
    ) as Record<string, string>;
    expect(enPayload['title']).toBe('Atoma — run delivered');
    expect(frPayload['title']).toBe('Atoma — run livré');
    expect(frPayload['body']).toBe('Construire une horloge');
  });

  it('collapses a principal named twice into one device notification', async () => {
    const store = fixture();
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-1',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    // Alice is both the requester and an org owner: one buzz, not two.
    await notifierFor(store, fetchImpl).notifyPrincipals(['alice', 'alice'], render, {
      tag: 'tag-1',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('prunes gone endpoints and stays silent for unsubscribed principals', async () => {
    const store = fixture();
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-dead',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    const notifier = notifierFor(store, fetchImpl);

    await notifier.notifyPrincipals(['alice'], render, { tag: 'tag-1' });
    expect(store.listForPrincipal('alice')).toEqual([]);

    await notifier.notifyPrincipals(['nobody'], render, { tag: 'tag-2' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('a throwing transport is contained, never rethrown into the caller', async () => {
    const store = fixture();
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-1',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const notifier = notifierFor(store, async () => {
      throw new Error('socket reset');
    });
    await expect(
      notifier.notifyPrincipals(['alice'], render, { tag: 'tag-1' })
    ).resolves.toBeUndefined();
    stderr.mockRestore();
    // A transport error is not evidence the subscription is gone.
    expect(store.listForPrincipal('alice')).toHaveLength(1);
  });

  it('does no work at all when nobody is named', async () => {
    const store = fixture();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await notifierFor(store, fetchImpl).notifyPrincipals([], render, { tag: 'tag-1' });
    await notifierFor(store, fetchImpl).notifyPrincipals([''], render, { tag: 'tag-1' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('PushStore locale', () => {
  it('defaults an absent or unknown locale to English', () => {
    const store = fixture();
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/a',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/b',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
      locale: 'klingon',
    });
    expect(store.listForPrincipal('alice').map((row) => row.locale)).toEqual(['en', 'en']);
  });

  it('re-subscribing the same endpoint updates its language', () => {
    const store = fixture();
    const chrome = browser();
    const subscription = {
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/a',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    };
    store.saveSubscription({ ...subscription, locale: 'en' });
    store.saveSubscription({ ...subscription, locale: 'fr' });
    expect(store.listForPrincipal('alice')).toHaveLength(1);
    expect(store.listForPrincipal('alice')[0]?.locale).toBe('fr');
  });
});
