import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL, type Viewer } from '../src/auth/store.js';
import { completeGitHubSetup, GITHUB_COPY, prepareGitHubConnect, startGitHubConnect } from '../src/github/http.js';
import type { GitHubAppClient, GitHubInstallationView } from '../src/github/client.js';
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
    platformAdmin: false,
    displayNameSource: 'provider',
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

/**
 * THE SUBSTITUTION CAPTURE, and the hop that makes closing it possible.
 *
 * `/auth/github/setup` receives `installation_id` from a URL the viewer can
 * type, and the connect state binds a principal and an org — never an
 * installation, the table has no such column. Linking from the App-JWT view
 * alone therefore proved only "some installation of this App", so an
 * authenticated admin could paste a stranger's id onto their own state and
 * bind it: the cross-org guard fires only once a row exists, so the first
 * binder wins, permanently, and nothing in the product can unbind it. Open
 * signup makes org:admin free, and installation ids are not secret.
 */
describe('the setup callback verifies the installation against the connecting user', () => {
  const STRANGER: GitHubInstallationView = Object.freeze({
    installationId: '99887766',
    appId: '123456',
    accountId: '424242',
    accountLogin: 'someone-else',
    targetType: 'Organization',
    repositorySelection: 'all',
    permissions: Object.freeze({ contents: 'write', administration: 'write' }),
    suspended: false,
  });

  function mintedState(viewer: Viewer): string {
    const state = newGitHubConnectState();
    github.createConnectState({
      state,
      principalId: viewer.principalId,
      orgId: viewer.orgId,
      ttlMs: 60_000,
    });
    return state;
  }

  /** The App-JWT view SUCCEEDS — that is exactly what the old code trusted. */
  function clientRefusingUserView(): GitHubAppClient {
    return {
      getAppInstallation: async () => STRANGER,
      verifyInstallation: async () => {
        throw new Error('GitHub installation is not accessible to the authenticated user');
      },
    } as unknown as GitHubAppClient;
  }

  it('writes nothing when the viewer cannot administer the installation', async () => {
    const result = await completeGitHubSetup({
      viewer: owner,
      github,
      client: clientRefusingUserView(),
      state: mintedState(owner),
      installationId: STRANGER.installationId,
      setupAction: 'install',
      resolveUserAccessToken: async () => 'gho_attacker',
      homePath: '/',
    });

    // The refusal itself matters less than the absence of a row: this is the
    // assertion that fails against the code this test was written for.
    expect(github.getInstallation(STRANGER.installationId)).toBeNull();
    expect(result.kind).toBe('html');
    if (result.kind !== 'html') return;
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it('links, and journals which door it came through, when the user can administer it', async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = {
      getAppInstallation: async () => STRANGER,
      verifyInstallation: async () => STRANGER,
    } as unknown as GitHubAppClient;

    const result = await completeGitHubSetup({
      viewer: owner,
      github,
      client,
      state: mintedState(owner),
      installationId: STRANGER.installationId,
      setupAction: 'install',
      resolveUserAccessToken: async () => 'gho_owner',
      homePath: '/',
      events: (event) => events.push(event),
    });

    expect(result).toEqual({ kind: 'redirect', location: '/' });
    const linked = github.getInstallation(STRANGER.installationId);
    expect(linked?.orgId).toBe(owner.orgId);
    expect(linked?.status).toBe('active');
    // `via` is what lets an operator tell an install from an adoption later.
    const [event] = events;
    expect(event?.['kind']).toBe('github.installation_linked');
    expect((event?.['detail'] as Record<string, unknown>)['via']).toBe('setup');
  });

  it('refuses a suspended installation rather than binding a dead one', async () => {
    const suspended = { ...STRANGER, suspended: true };
    const client = {
      getAppInstallation: async () => suspended,
      verifyInstallation: async () => suspended,
    } as unknown as GitHubAppClient;

    const result = await completeGitHubSetup({
      viewer: owner,
      github,
      client,
      state: mintedState(owner),
      installationId: suspended.installationId,
      setupAction: 'install',
      resolveUserAccessToken: async () => 'gho_owner',
      homePath: '/',
    });

    expect(result).toEqual({ kind: 'html', status: 409, body: GITHUB_COPY.suspended });
    expect(github.getInstallation(suspended.installationId)).toBeNull();
  });

  /**
   * The token is a PRECONDITION of connecting, not a consequence: a flow whose
   * callback could not verify must not start. An ordinary GitHub login already
   * stores the authorization, so this hop is only ever seen by an admin who
   * signed in with another provider.
   */
  it('sends a viewer with no stored GitHub authorization to authorize first', () => {
    const result = startGitHubConnect({
      viewer: owner,
      github,
      config: config(),
      authorizePath: '/auth/github/authorize',
    });
    expect(result).toEqual({ kind: 'redirect', location: '/auth/github/authorize' });
    // And it costs no connect state: nothing was started.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM github_connect_states').get()
    ).toEqual({ n: 0 });
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


describe('existing GitHub installation discovery', () => {
  const installation: GitHubInstallationView = {
    installationId: '99887766', appId: '123456', accountId: '44',
    accountLogin: 'existing-account', targetType: 'User', repositorySelection: 'all',
    permissions: {}, suspended: false,
  };

  it('offers every matching account without binding any, excluding other Apps', async () => {
    const result = await prepareGitHubConnect({
      viewer: owner, github, config: config(),
      resolveUserAccessToken: async () => 'user-token',
      client: { listUserInstallations: async () => [installation,
        { ...installation, installationId: '2', accountLogin: 'second' },
        { ...installation, installationId: '3', appId: '999' },
      ] } as unknown as GitHubAppClient,
    });
    expect(result.kind).toBe('installations');
    if (result.kind !== 'installations') return;
    expect(result.accounts.map(account => account.accountLogin)).toEqual(['existing-account', 'second']);
    expect(github.getInstallation(installation.installationId)).toBeNull();
    expect(github.hasPendingConnectState(result.state)).toBe(true);
  });

  it('keeps the ordinary install flow when GitHub returns no installations', async () => {
    const result = await prepareGitHubConnect({
      viewer: owner, github, config: config(), resolveUserAccessToken: async () => 'user-token',
      client: { listUserInstallations: async () => [] } as unknown as GitHubAppClient,
    });
    expect(result.kind).toBe('redirect');
    if (result.kind === 'redirect') expect(result.location).toContain('/installations/new?state=');
  });

  it('does not disguise a discovery failure as a missing installation', async () => {
    const result = await prepareGitHubConnect({
      viewer: owner, github, config: config(),
      resolveUserAccessToken: async () => { throw new Error('token unavailable'); },
      client: {} as GitHubAppClient,
    });
    expect(result).toEqual({ kind: 'html', status: 502, body: GITHUB_COPY.providerFailure });
  });
});
