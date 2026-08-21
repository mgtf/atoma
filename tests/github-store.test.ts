import { createSecretKey, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptGitHubToken } from '../src/github/crypto.js';
import {
  GitHubInstallationCrossOrgError,
  GitHubStore,
  GitHubWebhookDeliveryCollisionError,
  newGitHubConnectState,
  WEBHOOK_DELIVERY_RETENTION_MS,
} from '../src/github/store.js';

const AUTH_FIXTURE_DDL = `
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
`;

interface TenantFixture {
  principalId: string;
  orgId: string;
}

let db: Database.Database;
let store: GitHubStore;
let first: TenantFixture;
let second: TenantFixture;

function tenant(name: string): TenantFixture {
  const principalId = randomUUID();
  const orgId = randomUUID();
  const now = new Date(0).toISOString();
  db.prepare('INSERT INTO auth_principals VALUES (?, ?, ?, ?)')
    .run(principalId, 'human', `${name} user`, now);
  db.prepare('INSERT INTO auth_organisations VALUES (?, ?, ?)')
    .run(orgId, `${name} org`, now);
  db.prepare('INSERT INTO auth_memberships VALUES (?, ?, ?, ?)')
    .run(orgId, principalId, 'org:owner', now);
  return { principalId, orgId };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_FIXTURE_DDL);
  first = tenant('first');
  second = tenant('second');
  store = new GitHubStore(db);
});

afterEach(() => {
  db.close();
});

function link(overrides: Partial<Parameters<GitHubStore['linkInstallation']>[0]> = {}) {
  return store.linkInstallation({
    installationId: '501',
    orgId: first.orgId,
    accountId: '701',
    accountLogin: 'atoma-org',
    targetType: 'Organization',
    repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write' },
    connectedByPrincipalId: first.principalId,
    now: 1_700_000_000_000,
    ...overrides,
  });
}

describe('GitHub connect states', () => {
  it('stores only a hash and consumes a state exactly once', () => {
    const state = newGitHubConnectState(() => Buffer.alloc(32, 8));
    store.createConnectState({
      state,
      principalId: first.principalId,
      orgId: first.orgId,
      ttlMs: 60_000,
      now: 1_700_000_000_000,
    });
    const raw = db.prepare('SELECT state_hash FROM github_connect_states').get() as { state_hash: string };
    expect(raw.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.state_hash).not.toBe(state);

    expect(store.consumeConnectState({
      state,
      principalId: first.principalId,
      orgId: first.orgId,
      now: 1_700_000_001_000,
    })).toMatchObject({ principalId: first.principalId, orgId: first.orgId });
    expect(store.consumeConnectState({
      state,
      principalId: first.principalId,
      orgId: first.orgId,
      now: 1_700_000_001_000,
    })).toBeNull();
  });

  it('reports pending connect state without consuming it', () => {
    const state = newGitHubConnectState();
    expect(store.hasPendingConnectState(state, 1_700_000_000_000)).toBe(false);
    store.createConnectState({
      state,
      principalId: first.principalId,
      orgId: first.orgId,
      ttlMs: 60_000,
      now: 1_700_000_000_000,
    });
    expect(store.hasPendingConnectState(state, 1_700_000_030_000)).toBe(true);
    expect(store.hasPendingConnectState(state, 1_700_000_060_000)).toBe(false);
    expect(store.consumeConnectState({
      state,
      principalId: first.principalId,
      orgId: first.orgId,
      now: 1_700_000_030_000,
    })).not.toBeNull();
    expect(store.hasPendingConnectState(state, 1_700_000_030_000)).toBe(false);
  });

  it('burns a state presented by the wrong organisation and refuses expiry', () => {
    expect(() => store.createConnectState({
      state: newGitHubConnectState(),
      principalId: first.principalId,
      orgId: second.orgId,
      ttlMs: 1_000,
      now: 9_000,
    })).toThrow(/not a member/);

    const crossed = newGitHubConnectState();
    store.createConnectState({
      state: crossed,
      principalId: first.principalId,
      orgId: first.orgId,
      ttlMs: 1_000,
      now: 10_000,
    });
    expect(store.consumeConnectState({
      state: crossed,
      principalId: second.principalId,
      orgId: second.orgId,
      now: 10_100,
    })).toBeNull();
    expect(store.consumeConnectState({
      state: crossed,
      principalId: first.principalId,
      orgId: first.orgId,
      now: 10_100,
    })).toBeNull();

    const expired = newGitHubConnectState();
    store.createConnectState({
      state: expired,
      principalId: first.principalId,
      orgId: first.orgId,
      ttlMs: 1,
      now: 20_000,
    });
    expect(store.consumeConnectState({
      state: expired,
      principalId: first.principalId,
      orgId: first.orgId,
      now: 20_001,
    })).toBeNull();
  });
});

describe('GitHub user authorization storage', () => {
  it('stores encrypted access and refresh envelopes and returns strict records', () => {
    const key = createSecretKey(Buffer.alloc(32, 4));
    const accessToken = encryptGitHubToken({
      token: 'ghu_plaintext-access',
      kind: 'access',
      principalId: first.principalId,
      key,
      keyId: 'test-key',
    });
    const refreshToken = encryptGitHubToken({
      token: 'ghr_plaintext-refresh',
      kind: 'refresh',
      principalId: first.principalId,
      key,
      keyId: 'test-key',
    });
    const authorization = store.saveUserAuthorization({
      principalId: first.principalId,
      githubSubject: '9007199254740992',
      accessToken,
      accessExpiresAt: 1_700_000_100_000,
      refreshToken,
      refreshExpiresAt: 1_700_100_000_000,
      now: 1_700_000_000_000,
    });
    expect(authorization).toMatchObject({
      principalId: first.principalId,
      githubSubject: '9007199254740992',
      accessToken: { kind: 'access' },
      refreshToken: { kind: 'refresh' },
    });
    const raw = JSON.stringify(db.prepare('SELECT * FROM github_user_authorizations').get());
    expect(raw).not.toContain('plaintext-access');
    expect(raw).not.toContain('plaintext-refresh');
  });

  it('refuses an incomplete refresh pair and corrupt stored envelopes', () => {
    const key = createSecretKey(Buffer.alloc(32, 4));
    const accessToken = encryptGitHubToken({
      token: 'ghu_access',
      kind: 'access',
      principalId: first.principalId,
      key,
      keyId: 'test-key',
    });
    expect(() => store.saveUserAuthorization({
      principalId: first.principalId,
      githubSubject: '801',
      accessToken,
      accessExpiresAt: 2_000,
      refreshExpiresAt: 3_000,
      now: 1_000,
    })).toThrow(/together/);

    store.saveUserAuthorization({
      principalId: first.principalId,
      githubSubject: '801',
      accessToken,
      accessExpiresAt: 2_000,
      now: 1_000,
    });
    db.prepare("UPDATE github_user_authorizations SET access_envelope = '{\"version\":0}'")
      .run();
    expect(() => store.getUserAuthorization(first.principalId)).toThrow(/invalid shape/);
  });
});

describe('GitHub installation ownership and webhook deliveries', () => {
  it('links idempotently inside one org and rejects global cross-org reuse', () => {
    expect(link()).toMatchObject({
      installationId: '501',
      orgId: first.orgId,
      status: 'active',
    });
    expect(link({ accountLogin: 'renamed-org', now: 1_700_000_001_000 })).toMatchObject({
      accountLogin: 'renamed-org',
      orgId: first.orgId,
    });
    expect(() => link({
      orgId: second.orgId,
      connectedByPrincipalId: second.principalId,
    })).toThrow(GitHubInstallationCrossOrgError);
    expect(() => link({ accountId: '702' })).toThrow(/identity changed/);
    expect(store.listInstallations(first.orgId)).toHaveLength(1);
    expect(store.listInstallations(second.orgId)).toHaveLength(0);
  });

  it('deduplicates delivery ids and applies each transition atomically', () => {
    link();
    const digest = 'a'.repeat(64);
    expect(store.recordWebhookDelivery({
      deliveryId: 'delivery-1',
      event: 'installation',
      payloadSha256: digest,
      mutation: { kind: 'transition', installationId: '501', status: 'suspended' },
      receivedAt: 1_700_000_002_000,
    })).toEqual({ duplicate: false, applied: true });
    expect(store.getInstallation('501')?.status).toBe('suspended');
    expect(store.recordWebhookDelivery({
      deliveryId: 'delivery-1',
      event: 'installation',
      payloadSha256: digest,
      mutation: { kind: 'transition', installationId: '501', status: 'active' },
      receivedAt: 1_700_000_003_000,
    })).toEqual({ duplicate: true, applied: false });
    expect(store.getInstallation('501')?.status).toBe('suspended');
    expect(() => store.recordWebhookDelivery({
      deliveryId: 'delivery-1',
      event: 'installation',
      payloadSha256: 'b'.repeat(64),
      receivedAt: 1_700_000_004_000,
    })).toThrow(GitHubWebhookDeliveryCollisionError);
  });

  it('prunes deliveries past the replay-dedup window instead of growing forever', () => {
    link();
    const digest = 'c'.repeat(64);
    const first = 1_700_000_000_000;
    expect(store.recordWebhookDelivery({
      deliveryId: 'old-delivery',
      event: 'installation',
      payloadSha256: digest,
      receivedAt: first,
    })).toEqual({ duplicate: false, applied: false });
    // Inside the window the row still deduplicates…
    expect(store.recordWebhookDelivery({
      deliveryId: 'old-delivery',
      event: 'installation',
      payloadSha256: digest,
      receivedAt: first + WEBHOOK_DELIVERY_RETENTION_MS - 1,
    })).toEqual({ duplicate: true, applied: false });
    // …and past it the insert prunes the stale row, so the same id records
    // as a fresh delivery: dedup is bounded by traffic, not deployment age.
    expect(store.recordWebhookDelivery({
      deliveryId: 'old-delivery',
      event: 'installation',
      payloadSha256: digest,
      receivedAt: first + WEBHOOK_DELIVERY_RETENTION_MS + 1,
    })).toEqual({ duplicate: false, applied: false });
  });

  it('treats deleted as terminal and records unknown installations without linking them', () => {
    link();
    expect(store.transitionInstallation('501', 'deleted')).toBe(true);
    expect(store.transitionInstallation('501', 'active')).toBe(false);
    expect(store.getInstallation('501')?.status).toBe('deleted');

    expect(store.recordWebhookDelivery({
      deliveryId: 'unknown-installation',
      event: 'installation',
      payloadSha256: 'c'.repeat(64),
      mutation: { kind: 'transition', installationId: '999', status: 'active' },
    })).toEqual({ duplicate: false, applied: false });
    expect(store.getInstallation('999')).toBeNull();
  });
});
