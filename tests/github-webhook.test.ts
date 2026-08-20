import { createHmac, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  GitHubWebhookError,
  processGitHubWebhook,
  verifyGitHubWebhookSignature,
} from '../src/github/webhook.js';
import {
  GitHubStore,
  GitHubWebhookDeliveryCollisionError,
} from '../src/github/store.js';

const WEBHOOK_SECRET = 'correct horse battery staple 2026';
const APP_ID = '123456';

let db: Database.Database;
let store: GitHubStore;
let principalId: string;
let orgId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE auth_principals (
      principal_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE auth_organisations (
      org_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE auth_memberships (
      org_id TEXT NOT NULL REFERENCES auth_organisations(org_id),
      principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, principal_id)
    );
  `);
  principalId = randomUUID();
  orgId = randomUUID();
  const now = new Date(0).toISOString();
  db.prepare('INSERT INTO auth_principals VALUES (?, ?, ?, ?)')
    .run(principalId, 'human', 'Webhook User', now);
  db.prepare('INSERT INTO auth_organisations VALUES (?, ?, ?)')
    .run(orgId, 'Webhook Org', now);
  db.prepare('INSERT INTO auth_memberships VALUES (?, ?, ?, ?)')
    .run(orgId, principalId, 'org:owner', now);
  store = new GitHubStore(db);
  store.linkInstallation({
    installationId: '501',
    orgId,
    accountId: '701',
    accountLogin: 'atoma-org',
    targetType: 'Organization',
    repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write' },
    connectedByPrincipalId: principalId,
    now: 1_700_000_000_000,
  });
});

afterEach(() => {
  db.close();
});

function signature(body: Buffer, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function installationBody(action: string, installationId = '501', appId = APP_ID): Buffer {
  return Buffer.from(JSON.stringify({
    action,
    installation: { id: installationId, app_id: appId },
  }), 'utf8');
}

function deliver(input: {
  action: string;
  deliveryId: string;
  event?: string;
  installationId?: string;
  appId?: string;
  receivedAt?: number;
}) {
  const body = installationBody(
    input.action,
    input.installationId ?? '501',
    input.appId ?? APP_ID
  );
  return processGitHubWebhook({
    store,
    appId: APP_ID,
    webhookSecret: WEBHOOK_SECRET,
    rawBody: body,
    signature: signature(body),
    deliveryId: input.deliveryId,
    event: input.event ?? 'installation',
    receivedAt: input.receivedAt ?? 1_700_000_001_000,
  });
}

describe('GitHub webhook HMAC', () => {
  it('matches GitHub\'s documented SHA-256 test vector over raw bytes', () => {
    const body = Buffer.from('Hello, World!', 'utf8');
    expect(verifyGitHubWebhookSignature(
      "It's a Secret to Everybody",
      body,
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
    )).toBe(true);
    expect(verifyGitHubWebhookSignature(
      "It's a Secret to Everybody",
      Buffer.from('Hello, World?'),
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
    )).toBe(false);
    expect(verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, 'sha256=bad')).toBe(false);
  });

  it('rejects invalid signatures and oversized bodies before JSON processing', () => {
    const body = installationBody('suspend');
    expect(() => processGitHubWebhook({
      store,
      appId: APP_ID,
      webhookSecret: WEBHOOK_SECRET,
      rawBody: body,
      signature: signature(body, 'wrong secret'),
      deliveryId: 'bad-signature',
      event: 'installation',
    })).toThrow(GitHubWebhookError);
    expect(store.getInstallation('501')?.status).toBe('active');

    const oversized = Buffer.alloc(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1, 1);
    try {
      processGitHubWebhook({
        store,
        appId: APP_ID,
        webhookSecret: WEBHOOK_SECRET,
        rawBody: oversized,
        signature: 'malformed',
        deliveryId: 'oversized',
        event: 'installation',
      });
      throw new Error('expected oversized webhook to be refused');
    } catch (error) {
      expect(error).toMatchObject({ code: 'body_too_large' });
    }
  });
});

describe('GitHub installation webhook transitions', () => {
  it('applies suspend once and returns an idempotent duplicate result on replay', () => {
    expect(deliver({ action: 'suspend', deliveryId: 'delivery-suspend' }))
      .toEqual({ accepted: true, duplicate: false, applied: true });
    expect(store.getInstallation('501')?.status).toBe('suspended');
    expect(deliver({ action: 'suspend', deliveryId: 'delivery-suspend' }))
      .toEqual({ accepted: true, duplicate: true, applied: false });
  });

  it('rejects a reused delivery id carrying different signed content', () => {
    deliver({ action: 'suspend', deliveryId: 'delivery-collision' });
    expect(() => deliver({ action: 'unsuspend', deliveryId: 'delivery-collision' }))
      .toThrow(GitHubWebhookDeliveryCollisionError);
    expect(store.getInstallation('501')?.status).toBe('suspended');
  });

  it('keeps deletion terminal against a delayed unsuspend', () => {
    expect(deliver({ action: 'deleted', deliveryId: 'delivery-delete' }).applied).toBe(true);
    expect(store.getInstallation('501')?.status).toBe('deleted');
    expect(deliver({ action: 'unsuspend', deliveryId: 'delivery-late' }).applied).toBe(false);
    expect(store.getInstallation('501')?.status).toBe('deleted');
  });

  it('touches repository-selection events without changing suspension state', () => {
    deliver({ action: 'suspend', deliveryId: 'delivery-suspend-first' });
    const before = store.getInstallation('501')?.updatedAt;
    const result = deliver({
      action: 'ignored-by-event',
      event: 'installation_repositories',
      deliveryId: 'delivery-repositories',
      receivedAt: 1_700_000_010_000,
    });
    expect(result).toEqual({ accepted: true, duplicate: false, applied: true });
    expect(store.getInstallation('501')).toMatchObject({
      status: 'suspended',
      updatedAt: new Date(1_700_000_010_000).toISOString(),
    });
    expect(store.getInstallation('501')?.updatedAt).not.toBe(before);
  });

  it('records an unknown installation event without trusting it as an org link', () => {
    expect(deliver({
      action: 'created',
      deliveryId: 'delivery-unknown',
      installationId: '999',
    })).toEqual({ accepted: true, duplicate: false, applied: false });
    expect(store.getInstallation('999')).toBeNull();
  });

  it('refuses a correctly signed payload for another App without consuming delivery id', () => {
    expect(() => deliver({
      action: 'suspend',
      deliveryId: 'delivery-app-check',
      appId: '654321',
    })).toThrow(/another App/);
    expect(store.getInstallation('501')?.status).toBe('active');
    expect(deliver({ action: 'suspend', deliveryId: 'delivery-app-check' }).applied).toBe(true);
  });
});
