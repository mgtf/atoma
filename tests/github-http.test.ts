import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL, type Viewer } from '../src/auth/store.js';
import { GITHUB_COPY, startGitHubConnect } from '../src/github/http.js';
import {
  GitHubStore,
  isGitHubConnectState,
  newGitHubConnectState,
} from '../src/github/store.js';
import { githubAppInstallUrl, githubWebOrigin } from '../src/github/urls.js';
import { isOauthState } from '../src/auth/values.js';
import type { GitHubAppConfig } from '../src/github/config.js';

let db: Database.Database;
let github: GitHubStore;
let owner: Viewer;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  github = new GitHubStore(db);
  owner = seed('Ada', 'org:owner');
});

afterEach(() => {
  db.close();
});

function seed(label: string, role: Viewer['role']): Viewer {
  const orgId = randomUUID();
  const principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)')
    .run(orgId, `${label} Org`, now);
  db.prepare(
    `INSERT INTO auth_principals (principal_id, kind, display_name, created_at)
     VALUES (?, 'human', ?, ?)`
  ).run(principalId, label, now);
  db.prepare(
    `INSERT INTO auth_memberships (org_id, principal_id, role, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(orgId, principalId, role, now);
  return {
    principalId,
    displayName: label,
    kind: 'human',
    orgId,
    orgName: `${label} Org`,
    role,
  };
}

function config(): GitHubAppConfig {
  return {
    appId: '123456',
    appSlug: 'atoma-test',
    privateKey: {} as GitHubAppConfig['privateKey'],
    webhookSecret: 'w'.repeat(32),
    tokenEncryptionKey: {} as GitHubAppConfig['tokenEncryptionKey'],
    tokenEncryptionKeyId: 'keyidkeyidkeyidk',
    apiBaseUrl: 'https://api.github.com',
    clientId: 'client',
    clientSecret: 'secret',
  };
}

describe('GitHub App URLs', () => {
  it('maps api.github.com to github.com and keeps loopback/GHE origins', () => {
    expect(githubWebOrigin('https://api.github.com')).toBe('https://github.com');
    expect(githubWebOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(githubWebOrigin('https://github.example.com/api/v3')).toBe('https://github.example.com');
  });

  it('builds an install URL that carries connect state', () => {
    const state = newGitHubConnectState();
    expect(githubAppInstallUrl({
      appSlug: 'atoma-test',
      state,
      apiBaseUrl: 'https://api.github.com',
    })).toBe(`https://github.com/apps/atoma-test/installations/new?state=${state}`);
  });
});

describe('GitHub connect HTTP', () => {
  it('redirects an org:admin+ viewer to the App install URL with a pending connect state', () => {
    const result = startGitHubConnect({ viewer: owner, github, config: config() });
    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') return;
    const location = new URL(result.location);
    expect(location.origin).toBe('https://github.com');
    expect(location.pathname).toBe('/apps/atoma-test/installations/new');
    const state = location.searchParams.get('state');
    expect(isGitHubConnectState(state)).toBe(true);
    expect(isOauthState(state)).toBe(false);
    expect(github.hasPendingConnectState(state!)).toBe(true);
  });

  it('refuses org:viewer and org:member connect attempts', () => {
    const viewer = seed('View', 'org:viewer');
    const member = seed('Mem', 'org:member');
    expect(startGitHubConnect({ viewer, github, config: config() })).toEqual({
      kind: 'json',
      status: 403,
      body: { error: GITHUB_COPY.adminRequired },
    });
    expect(startGitHubConnect({ viewer: member, github, config: config() })).toEqual({
      kind: 'json',
      status: 403,
      body: { error: GITHUB_COPY.adminRequired },
    });
  });
});

describe('connect vs login state alphabets', () => {
  it('keeps 32-character login state disjoint from 43-character connect state', () => {
    const login = 'A'.repeat(32);
    const connect = newGitHubConnectState(() => Buffer.alloc(32, 7));
    expect(isOauthState(login)).toBe(true);
    expect(isGitHubConnectState(login)).toBe(false);
    expect(isOauthState(connect)).toBe(false);
    expect(isGitHubConnectState(connect)).toBe(true);
    expect(connect).toHaveLength(43);
  });
});
