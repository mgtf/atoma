import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretKey } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthStore } from '../src/auth/store.js';
import {
  resolveSecretEncryption,
  type SecretEncryptionContext,
} from '../src/auth/secretEncryption.js';

const roots: string[] = [];
const databases: Database.Database[] = [];

afterAll(() => {
  for (const db of databases) db.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshStore(filename = 'org-models.db'): AuthStore {
  const root = mkdtempSync(join(tmpdir(), 'atoma-org-models-'));
  roots.push(root);
  const db = new Database(join(root, filename));
  databases.push(db);
  return new AuthStore(db);
}

function encryption(): SecretEncryptionContext {
  return { key: createSecretKey(Buffer.alloc(32, 11)), keyId: 'test-key' };
}

function seedOrg(store: AuthStore): string {
  const outcome = store.completeLogin(
    {
      provider: 'github',
      subject: `owner-${Math.random()}`,
      displayName: 'Owner',
      email: null,
      emailVerified: false,
    },
    null
  )!;
  return outcome.viewer.orgId;
}

describe('organisation tier model defaults', () => {
  it('store, read back and clear per-tier selections', () => {
    const store = freshStore();
    const orgId = seedOrg(store);
    expect(store.orgTierModels(orgId)).toEqual({ l1: null, l2: null, l3: null });

    store.setOrgTierModels(orgId, {
      l1: 'api:anthropic:claude-haiku-4-5',
      l2: 'api:anthropic:claude-sonnet-5',
      l3: null,
    });
    expect(store.orgTierModels(orgId)).toEqual({
      l1: 'api:anthropic:claude-haiku-4-5',
      l2: 'api:anthropic:claude-sonnet-5',
      l3: null,
    });

    expect(() => store.setOrgTierModels(orgId, { l1: 'sub:openai:gpt-5.6-sol', l2: null, l3: null })).toThrow();
    // A second org is untouched.
    const other = freshStore();
    const otherOrg = seedOrg(other);
    expect(other.orgTierModels(otherOrg)).toEqual({ l1: null, l2: null, l3: null });
  });

  it('degrades retired stored selections to null instead of throwing', () => {
    const store = freshStore();
    const orgId = seedOrg(store);
    store.setOrgTierModels(orgId, { l1: 'api:zai:glm-4.5-air', l2: null, l3: null });
    const raw = (store as unknown as { db: Database.Database }).db;
    raw.prepare("UPDATE auth_org_tier_models SET model_l1 = 'retired:model-x'").run();
    expect(store.orgTierModels(orgId)).toEqual({ l1: null, l2: null, l3: null });
  });

  it('refuses an unknown organisation', () => {
    const store = freshStore();
    expect(() =>
      store.setOrgTierModels('no-such-org', { l1: null, l2: null, l3: null })
    ).toThrow(/organisation not found/);
  });
});

describe('organisation provider keys', () => {
  it('encrypts at rest, decrypts for the owning org only, and never lists material', () => {
    const store = freshStore();
    const orgId = seedOrg(store);
    const context = encryption();

    store.setOrgProviderKey({ orgId, provider: 'zai', plaintext: 'sk-zai-live-key', encryption: context });
    const raw = (store as unknown as { db: Database.Database }).db;
    const row = raw.prepare('SELECT envelope FROM auth_org_provider_keys').get() as {
      envelope: string;
    };
    expect(row.envelope).not.toContain('sk-zai-live-key');
    expect(
      store.decryptOrgProviderKey(orgId, 'zai', context)
    ).toBe('sk-zai-live-key');

    // Presence listing carries no bytes.
    const listed = store.listOrgProviderKeys(orgId);
    expect(JSON.stringify(listed)).not.toContain('sk-zai-live-key');
    expect(listed).toEqual([{ provider: 'zai', configuredAt: expect.any(String) }]);

    // Another org (same key material) must not decrypt this row's binding.
    const otherRoot = mkdtempSync(join(tmpdir(), 'atoma-org-models-'));
    roots.push(otherRoot);
    const otherDb = new Database(join(otherRoot, 'other.db'));
    databases.push(otherDb);
    const other = new AuthStore(otherDb);
    const otherOrg = seedOrg(other);
    other.setOrgProviderKey({
      orgId: otherOrg,
      provider: 'anthropic',
      plaintext: 'sk-anthropic-other',
      encryption: context,
    });
    // Cross-org copy attempt: same crypto key but the wrong org binding fails.
    const copied = raw
      .prepare('SELECT envelope FROM auth_org_provider_keys WHERE provider = ?')
      .get('zai') as { envelope: string };
    otherDb
      .prepare("INSERT OR REPLACE INTO auth_org_provider_keys (org_id, provider, envelope, updated_at) VALUES (?, 'zai', ?, ?)")
      .run(
        otherOrg,
        copied.envelope,
        new Date().toISOString()
      );
    expect(
      other.decryptOrgProviderKey(otherOrg, 'zai', context)
    ).toBeNull();
  });

  it('degrades without an encryption context and survives removal', () => {
    const store = freshStore();
    const orgId = seedOrg(store);
    store.setOrgProviderKey({
      orgId,
      provider: 'ollama',
      plaintext: 'unused-but-shaped-like-a-key',
      encryption: encryption(),
    });
    expect(store.decryptOrgProviderKey(orgId, 'ollama', null)).toBeNull();
    expect(
      store.deleteOrgProviderKey(orgId, 'ollama')
    ).toBe(true);
    expect(store.listOrgProviderKeys(orgId)).toEqual([]);
  });
});

describe('resolveSecretEncryption', () => {
  it('is null without any wrapping key', () => {
    expect(resolveSecretEncryption({})).toBeNull();
  });

  it('falls back to the GitHub token wrapping key', () => {
    const github = 'g'.repeat(32);
    const dedicated = 'd'.repeat(32);
    const fromGithub = resolveSecretEncryption({
      ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY: github,
    });
    expect(fromGithub).not.toBeNull();
    const fromDedicated = resolveSecretEncryption({
      ATOMA_SECRET_ENCRYPTION_KEY: dedicated,
      ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY: github,
    });
    expect(fromDedicated).not.toBeNull();
    expect(fromDedicated!.keyId).not.toBe(fromGithub!.keyId);
  });
});
