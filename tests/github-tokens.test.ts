import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { providerFromEnv } from '../src/auth/providers.js';
import { GITHUB_APP_ENV, snapshotGitHubAppConfig } from '../src/github/config.js';
import { decryptGitHubToken } from '../src/github/crypto.js';
import { GitHubStore } from '../src/github/store.js';
import {
  persistGitHubUserTokens,
  resolveGitHubUserAccessToken,
} from '../src/github/tokens.js';

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

let db: Database.Database;
let github: GitHubStore;
let principalId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  github = new GitHubStore(db);
  principalId = randomUUID();
  const orgId = randomUUID();
  const now = new Date(0).toISOString();
  db.prepare('INSERT INTO auth_principals VALUES (?, ?, ?, ?)')
    .run(principalId, 'human', 'Token User', now);
  db.prepare('INSERT INTO auth_organisations VALUES (?, ?, ?)')
    .run(orgId, 'Token Org', now);
  db.prepare('INSERT INTO auth_memberships VALUES (?, ?, ?, ?)')
    .run(orgId, principalId, 'org:owner', now);
});

afterEach(() => {
  db.close();
});

function rsaPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

function appConfig() {
  return snapshotGitHubAppConfig({
    [GITHUB_APP_ENV.appId]: '123456',
    [GITHUB_APP_ENV.appSlug]: 'atoma-test',
    [GITHUB_APP_ENV.privateKey]: rsaPem(),
    [GITHUB_APP_ENV.webhookSecret]: 'w'.repeat(32),
    [GITHUB_APP_ENV.tokenEncryptionKey]: randomBytes(32).toString('hex'),
    [GITHUB_APP_ENV.oauthClientId]: 'client-id',
    [GITHUB_APP_ENV.oauthClientSecret]: 'client-secret',
  });
}

function githubProvider() {
  const provider = providerFromEnv('github', {
    ATOMA_AUTH_GITHUB_CLIENT_ID: 'client-id',
    ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
    ATOMA_AUTH_GITHUB_TOKEN_URL: 'http://127.0.0.1:9/token',
    ATOMA_AUTH_GITHUB_USERINFO_URL: 'http://127.0.0.1:9/user',
  });
  if (!provider) throw new Error('test GitHub provider missing');
  return provider;
}

describe('GitHub user-to-server tokens', () => {
  it('encrypts at rest and decrypts a still-valid access token without refreshing', async () => {
    const config = appConfig();
    persistGitHubUserTokens({
      github,
      config,
      principalId,
      githubSubject: '4242',
      tokens: {
        accessToken: 'ghu_live-access',
        accessTokenExpiresInSeconds: 3600,
        refreshToken: 'ghr_live-refresh',
        refreshTokenExpiresInSeconds: 86_400,
      },
      now: NOW,
    });
    const stored = github.getUserAuthorization(principalId);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain('ghu_live-access');
    expect(decryptGitHubToken({
      envelope: stored!.accessToken,
      expectedKind: 'access',
      principalId,
      key: config.tokenEncryptionKey,
      keyId: config.tokenEncryptionKeyId,
    })).toBe('ghu_live-access');

    const resolved = await resolveGitHubUserAccessToken({
      github,
      config,
      provider: githubProvider(),
      principalId,
      now: NOW + 1_000,
    });
    expect(resolved).toBe('ghu_live-access');
  });

  it('refreshes inside the expiry margin and persists the rotated pair', async () => {
    const config = appConfig();
    persistGitHubUserTokens({
      github,
      config,
      principalId,
      githubSubject: '4242',
      tokens: {
        accessToken: 'ghu_stale',
        accessTokenExpiresInSeconds: 30,
        refreshToken: 'ghr_stale',
        refreshTokenExpiresInSeconds: 86_400,
      },
      now: NOW,
    });
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (!(body instanceof URLSearchParams)) throw new Error('expected form body');
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('ghr_stale');
      expect(body.get('client_secret')).toBe('client-secret');
      return new Response(JSON.stringify({
        access_token: 'ghu_rotated',
        expires_in: 3600,
        refresh_token: 'ghr_rotated',
        refresh_token_expires_in: 86_400,
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const resolved = await resolveGitHubUserAccessToken({
      github,
      config,
      provider: githubProvider(),
      principalId,
      now: NOW + 1_000,
      fetchImpl: fakeFetch,
    });
    expect(resolved).toBe('ghu_rotated');
    const stored = github.getUserAuthorization(principalId)!;
    expect(decryptGitHubToken({
      envelope: stored.accessToken,
      expectedKind: 'access',
      principalId,
      key: config.tokenEncryptionKey,
      keyId: config.tokenEncryptionKeyId,
    })).toBe('ghu_rotated');
  });

  it('refuses to persist an access token that GitHub did not stamp with expiry', () => {
    expect(() => persistGitHubUserTokens({
      github,
      config: appConfig(),
      principalId,
      githubSubject: '4242',
      tokens: {
        accessToken: 'ghu_no-expiry',
        accessTokenExpiresInSeconds: null,
        refreshToken: null,
        refreshTokenExpiresInSeconds: null,
      },
    })).toThrow(/no expiry/);
  });
});
