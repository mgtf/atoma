import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRunFinishedEvent } from '../src/projects/coordinator.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { PushNotifier, runFinishedNotification } from '../src/viz/push/notifier.js';
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

function event(overrides: Partial<ProjectRunFinishedEvent> = {}): ProjectRunFinishedEvent {
  return {
    orgId: 'org-1',
    projectId: 'proj-1',
    projectRunId: 'run-1',
    principalId: 'alice',
    goal: 'Build a clock in one index.html.',
    status: 'delivered',
    ...overrides,
  };
}

describe('runFinishedNotification', () => {
  it('bounds the goal excerpt and names the outcome', () => {
    const long = event({ goal: `${'x'.repeat(200)}   with   spaces`, status: 'failed' });
    const notification = runFinishedNotification(long);
    expect(notification.title).toBe('Atoma — run failed');
    expect(notification.body.length).toBeLessThanOrEqual(140);
    expect(notification.body.endsWith('…')).toBe(true);
    expect(notification.tag).toBe('atoma-run-run-1');
    expect(notification.url).toBe('/');
  });
});

describe('PushNotifier', () => {
  it('delivers a payload the subscribed browser can decrypt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-push-notifier-'));
    roots.push(root);
    const store = PushStore.open(join(root, 'atoma.db'));
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
    const notifier = new PushNotifier({
      store,
      vapid: store.vapidKeys(),
      subject: 'https://viz.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notifier.notifyRunFinished(event());

    expect(fetchImpl).toHaveBeenCalledOnce();
    const decrypted = JSON.parse(chrome.decrypt(bodies[0]!)) as Record<string, string>;
    expect(decrypted['title']).toBe('Atoma — run delivered');
    expect(decrypted['body']).toBe('Build a clock in one index.html.');
    expect(decrypted['tag']).toBe('atoma-run-run-1');
  });

  it('prunes gone endpoints and stays silent for unsubscribed principals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-push-notifier-'));
    roots.push(root);
    const store = PushStore.open(join(root, 'atoma.db'));
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-dead',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    const notifier = new PushNotifier({
      store,
      vapid: store.vapidKeys(),
      subject: 'https://viz.example',
      fetchImpl: fetchImpl,
    });

    await notifier.notifyRunFinished(event());
    expect(store.listForPrincipal('alice')).toEqual([]);

    await notifier.notifyRunFinished(event({ principalId: 'nobody' }));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('a throwing transport is contained, never rethrown into the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-push-notifier-'));
    roots.push(root);
    const store = PushStore.open(join(root, 'atoma.db'));
    const chrome = browser();
    store.saveSubscription({
      principalId: 'alice',
      endpoint: 'https://push.example.net/send/alice-1',
      p256dh: chrome.p256dh,
      auth: chrome.auth,
    });
    const notifier = new PushNotifier({
      store,
      vapid: store.vapidKeys(),
      subject: 'https://viz.example',
      fetchImpl: vi.fn(async () => {
        throw new Error('socket reset');
      }),
    });
    await expect(notifier.notifyRunFinished(event())).resolves.toBeUndefined();
    expect(store.listForPrincipal('alice')).toHaveLength(1);
  });
});
