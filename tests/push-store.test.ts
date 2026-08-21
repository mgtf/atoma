import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  MAX_SUBSCRIPTIONS_PER_PRINCIPAL,
  PushStore,
} from '../src/viz/push/store.js';
import { fromBase64Url, generateVapidKeys, toBase64Url } from '../src/viz/push/webpush.js';

const roots: string[] = [];

afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(): { store: PushStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-push-store-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  return { store: PushStore.open(dbPath), dbPath };
}

function subscription(principalId: string, endpoint: string) {
  const keys = generateVapidKeys();
  return {
    principalId,
    endpoint,
    p256dh: keys.publicKey,
    auth: toBase64Url(Buffer.alloc(16, 7)),
  };
}

describe('PushStore', () => {
  it('generates the VAPID keypair once and persists it across reopens', () => {
    const { store, dbPath } = openStore();
    const first = store.vapidKeys();
    expect(fromBase64Url(first.publicKey)).toHaveLength(65);
    expect(fromBase64Url(first.privateKey)).toHaveLength(32);
    expect(store.vapidKeys()).toEqual(first);
    closeStoreHandles();
    expect(PushStore.open(dbPath).vapidKeys()).toEqual(first);
  });

  it('upserts by endpoint, lists per principal, and self-service deletes', () => {
    const { store } = openStore();
    const alice = subscription('alice', 'https://push.example.net/send/a1');
    store.saveSubscription(alice);
    store.saveSubscription(subscription('alice', 'https://push.example.net/send/a2'));
    store.saveSubscription(subscription('bob', 'https://push.example.net/send/b1'));
    expect(store.listForPrincipal('alice').map((row) => row.endpoint).sort()).toEqual([
      'https://push.example.net/send/a1',
      'https://push.example.net/send/a2',
    ]);
    // Re-saving an endpoint under another principal moves ownership: the
    // latest authenticated browser owns its own endpoint.
    store.saveSubscription({ ...alice, principalId: 'bob' });
    expect(store.listForPrincipal('alice').map((row) => row.endpoint)).toEqual([
      'https://push.example.net/send/a2',
    ]);
    // A principal cannot delete someone else's row.
    expect(store.deleteSubscription('alice', 'https://push.example.net/send/b1')).toBe(false);
    expect(store.deleteSubscription('bob', alice.endpoint)).toBe(true);
    store.dropEndpoint('https://push.example.net/send/a2');
    expect(store.listForPrincipal('alice')).toEqual([]);
  });

  it('rejects malformed endpoints and key material before persisting', () => {
    const { store } = openStore();
    const valid = subscription('alice', 'https://push.example.net/send/a1');
    expect(() => store.saveSubscription({ ...valid, endpoint: 'not a url' })).toThrow(/URL/);
    expect(() =>
      store.saveSubscription({ ...valid, endpoint: 'http://push.example.net/send/a1' })
    ).toThrow(/HTTPS/);
    expect(() =>
      store.saveSubscription({ ...valid, endpoint: `https://x.example/${'a'.repeat(2_100)}` })
    ).toThrow(/out of bounds/);
    expect(() =>
      store.saveSubscription({ ...valid, p256dh: toBase64Url(Buffer.alloc(65)) })
    ).toThrow(/uncompressed/);
    expect(() =>
      store.saveSubscription({ ...valid, auth: toBase64Url(Buffer.alloc(20)) })
    ).toThrow(/16 bytes/);
    expect(() => store.saveSubscription({ ...valid, principalId: '' })).toThrow(/principal/);
    expect(store.listForPrincipal('alice')).toEqual([]);
  });

  it('bounds subscriptions per principal by evicting the oldest', () => {
    const { store } = openStore();
    for (let index = 0; index <= MAX_SUBSCRIPTIONS_PER_PRINCIPAL; index++) {
      store.saveSubscription(
        subscription('alice', `https://push.example.net/send/a${String(index).padStart(2, '0')}`)
      );
    }
    const kept = store.listForPrincipal('alice');
    expect(kept).toHaveLength(MAX_SUBSCRIPTIONS_PER_PRINCIPAL);
    expect(kept.map((row) => row.endpoint)).not.toContain('https://push.example.net/send/a00');
  });
});
