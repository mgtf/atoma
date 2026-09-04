import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  AuthStore,
  MAX_ACTIVE_OAUTH_STATES,
  TooManyPendingOauthStatesError,
  sha256Hex,
  type CompletedProviderIdentity,
  type LoginOutcome,
  type OrgRole,
} from '../src/auth/store.js';
import {
  issueSession,
  LOGGED_OUT_SESSION_VALUE,
  logoutSessionCandidatesFromCookieHeader,
  newSessionToken,
  parseCookieHeader,
  retireSessionCookie,
  SESSION_TTL_MS,
  serializeCookie,
  sessionTokenFromCookieHeader,
} from '../src/auth/sessions.js';
import { MAX_LOGOUT_SESSION_CANDIDATES } from '../src/auth/values.js';

let root: string;
let databases: Database.Database[];
let invitationSequence: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-auth-'));
  databases = [];
  invitationSequence = 0;
});

afterEach(() => {
  for (const db of databases) db.close();
  rmSync(root, { recursive: true, force: true });
});

function freshStore(filename = 'test.db'): AuthStore {
  const db = new Database(join(root, filename));
  databases.push(db);
  return new AuthStore(db);
}

function rawDb(store: AuthStore): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

/** Recreate the invitation table in the local pre-release, unscoped shape. */
function downgradeInvitationsToLegacy(store: AuthStore): void {
  rawDb(store).exec(`
    CREATE TABLE auth_invitations_legacy (
      token_hash  TEXT PRIMARY KEY,
      role        TEXT NOT NULL CHECK (role IN ('org:owner','org:admin','org:member','org:viewer')),
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      consumed_at TEXT
    );
    INSERT INTO auth_invitations_legacy
      (token_hash, role, created_at, expires_at, consumed_at)
    SELECT token_hash, role, created_at, expires_at, consumed_at
    FROM auth_invitations;
    DROP TABLE auth_invitations;
    ALTER TABLE auth_invitations_legacy RENAME TO auth_invitations;
    CREATE INDEX auth_invitations_expires_idx ON auth_invitations(expires_at);
  `);
}

function tableColumnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function identity(subject: string, overrides: Partial<CompletedProviderIdentity> = {}): CompletedProviderIdentity {
  return {
    provider: 'github',
    subject,
    displayName: `User ${subject}`,
    email: null,
    emailVerified: false,
    ...overrides,
  };
}

function admit(
  store: AuthStore,
  providerIdentity: CompletedProviderIdentity,
  role: OrgRole,
  ttlMs = 60_000
): LoginOutcome {
  const existingOrganisation = store.listOrganisations()[0];
  if (!existingOrganisation) {
    if (role !== 'org:owner') {
      throw new Error('a personal organisation always starts with an owner');
    }
    const outcome = store.completeLogin(providerIdentity, null);
    if (!outcome) throw new Error('expected open signup to succeed');
    return outcome;
  }
  const token = `invitation-${invitationSequence++}`;
  const invitation = store.createInvitation({
    orgId: existingOrganisation.orgId,
    token,
    role,
    ttlMs,
  });
  const outcome = store.completeLogin(providerIdentity, invitation.tokenHash);
  if (!outcome) throw new Error('expected invitation admission to succeed');
  return outcome;
}

describe('auth store — identity linking (R11)', () => {
  it('creates a personal organisation and owner membership without an invitation', () => {
    const store = freshStore();
    const login = identity('12345', { displayName: 'Alice', email: 'alice@example.com' });
    const outcome = store.completeLogin(login, null);
    expect(outcome).not.toBeNull();
    const { viewer, createdPrincipal } = outcome!;
    expect(createdPrincipal).toBe(true);
    expect(viewer.role).toBe('org:owner');
    expect(viewer.orgName).toBe("Alice's organisation");
    expect(store.listOrganisationsForPrincipal(viewer.principalId)).toEqual([
      expect.objectContaining({
        orgId: viewer.orgId,
        orgName: "Alice's organisation",
        role: 'org:owner',
      }),
    ]);
  });

  it('creates a separate personal organisation for each uninvited identity', () => {
    const store = freshStore();
    const alice = store.completeLogin(identity('alice', { displayName: 'Alice' }), null)!;
    const bob = store.completeLogin(identity('bob', { displayName: 'Bob' }), null)!;
    expect(bob.viewer.orgId).not.toBe(alice.viewer.orgId);
    expect(store.listOrganisations()).toHaveLength(2);
    expect(alice.viewer.role).toBe('org:owner');
    expect(bob.viewer.role).toBe('org:owner');
  });

  it('refuses an explicit unknown invitation instead of falling back to personal signup', () => {
    const store = freshStore();
    expect(store.completeLogin(identity('not-admitted'), sha256Hex('missing-invitation')))
      .toBeNull();
    expect(store.listPrincipals()).toHaveLength(0);
    expect(store.listOrganisations()).toHaveLength(0);
  });

  it('known (provider, subject) re-authenticates without an invitation', () => {
    const store = freshStore();
    const first = admit(store, identity('1', { displayName: 'A', email: 'a@x.com' }), 'org:owner');
    const second = store.completeLogin(identity('1', { displayName: 'A2', email: 'other@y.com' }), null)!;
    expect(second.viewer.principalId).toBe(first.viewer.principalId);
    expect(second.createdPrincipal).toBe(false);
    // Display name follows the latest snapshot; the principal is stable.
    expect(second.viewer.displayName).toBe('A2');
  });

  it('a DIFFERENT subject with the SAME email is a DIFFERENT principal — email never joins (R11)', () => {
    const store = freshStore();
    const a = admit(store, identity('1', { displayName: 'A', email: 'shared@x.com', emailVerified: true }), 'org:owner');
    const b = admit(
      store,
      identity('g-77', { provider: 'google', displayName: 'B', email: 'shared@x.com', emailVerified: true }),
      'org:member'
    );
    expect(b.viewer.principalId).not.toBe(a.viewer.principalId);
    // And the second principal joins as member, not owner.
    expect(b.viewer.role).toBe('org:member');
    expect(b.viewer.orgId).toBe(a.viewer.orgId);
  });

  it('re-login never changes an existing role', () => {
    const store = freshStore();
    const owner = admit(store, identity('1', { displayName: 'A' }), 'org:owner');
    const member = admit(store, identity('2', { displayName: 'B' }), 'org:member');
    expect(member.viewer.role).toBe('org:member');
    const again = store.completeLogin(identity('2', { displayName: 'B' }), null);
    expect(again?.viewer.role).toBe('org:member');
    void owner;
  });

  it('a known identity joins the invitation target and makes it active', () => {
    const store = freshStore();
    const alice = store.completeLogin(identity('alice-known', { displayName: 'Alice' }), null)!;
    const bob = store.completeLogin(identity('bob-owner', { displayName: 'Bob' }), null)!;
    const invitation = store.createInvitation({
      orgId: bob.viewer.orgId,
      token: 'alice-joins-bob',
      role: 'org:member',
      ttlMs: 60_000,
    });

    const joined = store.completeLogin(identity('alice-known', { displayName: 'Alice' }), invitation.tokenHash);
    expect(joined).toMatchObject({
      createdPrincipal: false,
      viewer: { principalId: alice.viewer.principalId, orgId: bob.viewer.orgId, role: 'org:member' },
    });
    expect(store.listOrganisationsForPrincipal(alice.viewer.principalId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orgId: alice.viewer.orgId, role: 'org:owner' }),
        expect.objectContaining({ orgId: bob.viewer.orgId, role: 'org:member' }),
      ])
    );
  });

  it('a known identity with an invalid explicit invitation is not silently reauthenticated', () => {
    const store = freshStore();
    const alice = store.completeLogin(identity('known-invalid', { displayName: 'Alice' }), null)!;
    expect(
      store.completeLogin(
        identity('known-invalid', { displayName: 'Attacker-controlled update' }),
        sha256Hex('invalid-explicit-invitation')
      )
    ).toBeNull();
    expect(store.completeLogin(identity('known-invalid', { displayName: 'Alice' }), null)?.viewer)
      .toMatchObject({ principalId: alice.viewer.principalId, displayName: 'Alice' });
  });

  it('a known identity consumes a live invitation without adopting its role', () => {
    const store = freshStore();
    const owner = admit(store, identity('owner', { displayName: 'Owner' }), 'org:owner');
    const invitation = store.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'admin-invitation-for-known-user',
      role: 'org:admin',
      ttlMs: 60_000,
    });

    const again = store.completeLogin(
      identity('owner', { displayName: 'Owner again' }),
      invitation.tokenHash
    );
    expect(again).toMatchObject({
      createdPrincipal: false,
      viewer: { principalId: owner.viewer.principalId, role: 'org:owner' },
    });
    expect(
      store.listInvitations().find((candidate) => candidate.tokenHash === invitation.tokenHash)?.consumedAt
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.completeLogin(identity('stranger'), invitation.tokenHash)).toBeNull();
  });

  it('consumes an invitation exactly once across competing store handles', () => {
    const firstStore = freshStore();
    const secondStore = freshStore();
    const owner = admit(firstStore, identity('owner'), 'org:owner');
    const invitation = firstStore.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'one-shot',
      role: 'org:member',
      ttlMs: 60_000,
    });

    const first = firstStore.completeLogin(identity('candidate-a'), invitation.tokenHash);
    const second = secondStore.completeLogin(identity('candidate-b'), invitation.tokenHash);
    expect(first?.createdPrincipal).toBe(true);
    expect(second).toBeNull();
    expect(firstStore.listPrincipals().map((principal) => principal.displayName)).not.toContain('User candidate-b');
  });

  it('refuses expired invitations and sweeps them', () => {
    const store = freshStore();
    const owner = admit(store, identity('expiry-owner'), 'org:owner');
    const invitation = store.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'expired',
      role: 'org:member',
      ttlMs: -1,
    });
    expect(store.completeLogin(identity('late'), invitation.tokenHash)).toBeNull();
    expect(store.sweep().invitations).toBe(1);
  });

  it.each(['created_at', 'expires_at'] as const)(
    'refuses an invitation with malformed %s',
    (column) => {
      const store = freshStore();
      const owner = admit(store, identity(`malformed-owner-${column}`), 'org:owner');
      const invitation = store.createInvitation({
        orgId: owner.viewer.orgId,
        token: `malformed-${column}`,
        role: 'org:member',
        ttlMs: 60_000,
      });
      rawDb(store)
        .prepare(`UPDATE auth_invitations SET ${column} = ? WHERE token_hash = ?`)
        .run('not-a-date', invitation.tokenHash);

      expect(store.completeLogin(identity(column), invitation.tokenHash)).toBeNull();
    }
  );

  it('stores only invitation hashes and exposes only hashes to operators', () => {
    const store = freshStore();
    const owner = admit(store, identity('hash-owner'), 'org:owner');
    const token = 'clear-high-entropy-invitation';
    const invitation = store.createInvitation({
      orgId: owner.viewer.orgId,
      token,
      role: 'org:member',
      ttlMs: 60_000,
    });
    const rows = rawDb(store).prepare('SELECT * FROM auth_invitations').all();
    expect(invitation.tokenHash).toBe(sha256Hex(token));
    expect(store.listInvitations()).toEqual([invitation]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('lists principals with their linked identities', () => {
    const store = freshStore();
    admit(store, identity('1', { displayName: 'A', email: 'a@x.com' }), 'org:owner');
    const list = store.listPrincipals();
    expect(list).toHaveLength(1);
    expect(list[0]!.identities).toHaveLength(1);
    expect(list[0]!.identities[0]).toMatchObject({ provider: 'github', subject: '1' });
    expect(list[0]!.memberships).toEqual([
      expect.objectContaining({ role: 'org:owner', orgName: "A's organisation" }),
    ]);
  });
});

describe('auth store — pre-release invitation migration', () => {
  it('scopes legacy invitations to the only existing organisation and is idempotent', () => {
    const store = freshStore();
    const owner = store.completeLogin(identity('migration-owner', { displayName: 'Owner' }), null)!;
    const invitation = store.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'legacy-member-invitation',
      role: 'org:member',
      ttlMs: 60_000,
    });
    downgradeInvitationsToLegacy(store);

    const migrated = new AuthStore(rawDb(store));
    expect(migrated.listInvitations()).toEqual([
      expect.objectContaining({
        tokenHash: invitation.tokenHash,
        orgId: owner.viewer.orgId,
        role: 'org:member',
      }),
    ]);
    expect(() => new AuthStore(rawDb(store))).not.toThrow();
    expect(
      migrated.completeLogin(identity('migration-member'), invitation.tokenHash)?.viewer
    ).toMatchObject({ orgId: owner.viewer.orgId, role: 'org:member' });
  });

  it('preserves a fresh legacy bootstrap while requiring its first member to be owner', () => {
    const store = freshStore();
    downgradeInvitationsToLegacy(store);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const ownerHash = sha256Hex('legacy-owner');
    const memberHash = sha256Hex('legacy-member');
    rawDb(store)
      .prepare(
        `INSERT INTO auth_invitations
           (token_hash, role, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, NULL), (?, ?, ?, ?, NULL)`
      )
      .run(
        ownerHash,
        'org:owner',
        now.toISOString(),
        expiresAt,
        memberHash,
        'org:member',
        now.toISOString(),
        expiresAt
      );

    const migrated = new AuthStore(rawDb(store));
    expect(migrated.listOrganisations()).toEqual([
      expect.objectContaining({ name: 'Primary' }),
    ]);
    expect(migrated.completeLogin(identity('member-too-early'), memberHash)).toBeNull();
    const owner = migrated.completeLogin(identity('legacy-owner'), ownerHash);
    expect(owner?.viewer).toMatchObject({ role: 'org:owner', orgName: 'Primary' });
    expect(migrated.completeLogin(identity('legacy-member'), memberHash)?.viewer)
      .toMatchObject({ orgId: owner?.viewer.orgId, role: 'org:member' });
  });

  it('refuses to guess the target of an unscoped invitation across multiple organisations', () => {
    const store = freshStore();
    store.completeLogin(identity('migration-a'), null);
    store.completeLogin(identity('migration-b'), null);
    downgradeInvitationsToLegacy(store);
    const now = new Date();
    rawDb(store)
      .prepare(
        `INSERT INTO auth_invitations
           (token_hash, role, created_at, expires_at, consumed_at)
         VALUES (?, 'org:owner', ?, ?, NULL)`
      )
      .run(
        sha256Hex('ambiguous-invitation'),
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString()
      );

    expect(() => new AuthStore(rawDb(store))).toThrow(/across multiple organisations/);
    expect(tableColumnNames(rawDb(store), 'auth_invitations')).not.toContain('org_id');
  });

  it('reports a writable upgrade requirement without mutating through openReadOnly', () => {
    const filename = 'legacy-readonly.db';
    const store = freshStore(filename);
    downgradeInvitationsToLegacy(store);
    expect(() => AuthStore.openReadOnly(join(root, filename))).toThrow(/writable upgrade/);
    expect(tableColumnNames(rawDb(store), 'auth_invitations')).not.toContain('org_id');
  });
});

describe('auth store — sessions', () => {
  it('issues, resolves and revokes an opaque session; only the hash is stored', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('1', { displayName: 'A' }), 'org:owner');
    const token = newSessionToken();
    store.createSession({ principalId: viewer.principalId, orgId: viewer.orgId, token, ttlMs: 60_000 });
    const resolved = store.resolveSession(token);
    expect(resolved?.principalId).toBe(viewer.principalId);
    expect(resolved?.role).toBe('org:owner');

    store.revokeSession(token);
    expect(store.resolveSession(token)).toBeNull();
  });

  it('changes the active organisation for one session only and only through membership', () => {
    const store = freshStore();
    const alice = store.completeLogin(identity('session-alice', { displayName: 'Alice' }), null)!;
    const bob = store.completeLogin(identity('session-bob', { displayName: 'Bob' }), null)!;
    const charlie = store.completeLogin(identity('session-charlie', { displayName: 'Charlie' }), null)!;
    const invitation = store.createInvitation({
      orgId: bob.viewer.orgId,
      token: 'session-switch-membership',
      role: 'org:member',
      ttlMs: 60_000,
    });
    expect(store.completeLogin(identity('session-alice'), invitation.tokenHash)).not.toBeNull();

    const first = newSessionToken();
    const second = newSessionToken();
    for (const token of [first, second]) {
      store.createSession({
        principalId: alice.viewer.principalId,
        orgId: alice.viewer.orgId,
        token,
        ttlMs: 60_000,
      });
    }

    expect(store.setSessionOrganisation(first, bob.viewer.orgId)).toMatchObject({
      principalId: alice.viewer.principalId,
      orgId: bob.viewer.orgId,
      role: 'org:member',
    });
    expect(store.resolveSession(first)?.orgId).toBe(bob.viewer.orgId);
    expect(store.resolveSession(second)).toMatchObject({
      orgId: alice.viewer.orgId,
      role: 'org:owner',
    });

    expect(store.setSessionOrganisation(first, charlie.viewer.orgId)).toBeNull();
    expect(store.resolveSession(first)?.orgId).toBe(bob.viewer.orgId);
  });

  it('bulk-revokes one bounded canonical session batch', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('bulk'), 'org:owner');
    const first = newSessionToken();
    const second = newSessionToken();
    for (const token of [first, second]) {
      store.createSession({
        principalId: viewer.principalId,
        orgId: viewer.orgId,
        token,
        ttlMs: 60_000,
      });
    }

    expect(store.revokeSessions([first, second])).toBe(2);
    expect(store.resolveSession(first)).toBeNull();
    expect(store.resolveSession(second)).toBeNull();
    expect(store.revokeSessions([])).toBe(0);
  });

  it('refuses non-canonical or over-limit bulk revocation before SQLite work', () => {
    const store = freshStore();
    expect(() => store.revokeSessions(['not-a-session-token'])).toThrow(/canonical tokens/);
    expect(() =>
      store.revokeSessions(
        Array.from({ length: MAX_LOGOUT_SESSION_CANDIDATES + 1 }, () => newSessionToken())
      )
    ).toThrow(/at most/);
  });

  it('an observed expired session resolves to null and is deleted eagerly', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('1', { displayName: 'A' }), 'org:owner');
    const token = newSessionToken();
    store.createSession({ principalId: viewer.principalId, orgId: viewer.orgId, token, ttlMs: -1 });
    expect(store.resolveSession(token)).toBeNull();
    expect(store.sweep().sessions).toBe(0);
  });

  it('sweeps an expired session that was never resolved', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('1'), 'org:owner');
    store.createSession({ principalId: viewer.principalId, orgId: viewer.orgId, token: 'expired', ttlMs: -1 });
    expect(store.sweep().sessions).toBe(1);
  });

  it.each(['created_at', 'expires_at', 'last_seen_at'] as const)(
    'rejects and eagerly deletes a session with malformed %s',
    (column) => {
      const store = freshStore();
      const { viewer } = admit(store, identity(column), 'org:owner');
      const token = `malformed-session-${column}`;
      store.createSession({
        principalId: viewer.principalId,
        orgId: viewer.orgId,
        token,
        ttlMs: 60_000,
      });
      rawDb(store)
        .prepare(`UPDATE auth_sessions SET ${column} = ? WHERE token_hash = ?`)
        .run('not-a-date', sha256Hex(token));

      expect(store.resolveSession(token)).toBeNull();
      expect(
        (rawDb(store).prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count
      ).toBe(0);
    }
  );

  it('a wrong token resolves to null without side effects', () => {
    const store = freshStore();
    expect(store.resolveSession('garbage')).toBeNull();
  });

  it('the store keeps only the SHA-256 of the token', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('1', { displayName: 'A' }), 'org:owner');
    const token = newSessionToken();
    store.createSession({ principalId: viewer.principalId, orgId: viewer.orgId, token, ttlMs: 60_000 });
    // Reach into the raw DB handle: no clear token anywhere.
    const rows = rawDb(store).prepare('SELECT token_hash FROM auth_sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('enforces foreign keys on every AuthStore handle', () => {
    const store = freshStore();
    expect(() =>
      store.createSession({ principalId: 'missing-principal', orgId: 'missing-org', token: 'orphan', ttlMs: 60_000 })
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('oauth state — single use', () => {
  it('a state transports only the invitation hash and is consumed exactly once', () => {
    const store = freshStore();
    const clearInvitation = 'oauth-clear-invitation';
    const invitationHash = sha256Hex(clearInvitation);
    store.createOauthState({
      state: 'st-1',
      provider: 'github',
      codeVerifier: 'v',
      invitationHash,
      ttlMs: 60_000,
    });
    const first = store.consumeOauthState('st-1');
    expect(first).toEqual({ provider: 'github', codeVerifier: 'v', invitationHash });
    expect(store.consumeOauthState('st-1')).toBeNull();
    expect(JSON.stringify(rawDb(store).prepare('SELECT * FROM auth_oauth_states').all())).not.toContain(clearInvitation);
  });

  it('an expired state is consumed-but-rejected', () => {
    const store = freshStore();
    store.createOauthState({
      state: 'st-2',
      provider: 'github',
      codeVerifier: 'v',
      invitationHash: null,
      ttlMs: -1,
    });
    expect(store.consumeOauthState('st-2')).toBeNull();
  });

  it.each(['created_at', 'expires_at'] as const)(
    'consumes but rejects a state with malformed %s',
    (column) => {
      const store = freshStore();
      store.createOauthState({
        state: `malformed-${column}`,
        provider: 'github',
        codeVerifier: 'v',
        invitationHash: null,
        ttlMs: 60_000,
      });
      rawDb(store)
        .prepare(`UPDATE auth_oauth_states SET ${column} = ? WHERE state = ?`)
        .run('not-a-date', `malformed-${column}`);

      expect(store.consumeOauthState(`malformed-${column}`)).toBeNull();
      expect(store.consumeOauthState(`malformed-${column}`)).toBeNull();
    }
  );

  it('sweeps malformed dates from every expiring auth table', () => {
    const store = freshStore();
    const owner = admit(store, identity('sweep-owner'), 'org:owner');
    const invitation = store.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'sweep-bad-invite',
      role: 'org:member',
      ttlMs: 60_000,
    });
    store.createSession({
      principalId: owner.viewer.principalId,
      orgId: owner.viewer.orgId,
      token: 'sweep-bad-session',
      ttlMs: 60_000,
    });
    store.createOauthState({
      state: 'sweep-bad-state',
      provider: 'github',
      codeVerifier: 'v',
      invitationHash: null,
      ttlMs: 60_000,
    });
    rawDb(store)
      .prepare('UPDATE auth_invitations SET expires_at = ? WHERE token_hash = ?')
      .run('not-a-date', invitation.tokenHash);
    rawDb(store)
      .prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run('not-a-date', sha256Hex('sweep-bad-session'));
    rawDb(store)
      .prepare('UPDATE auth_oauth_states SET created_at = ? WHERE state = ?')
      .run('not-a-date', 'sweep-bad-state');

    expect(store.sweep()).toEqual({ sessions: 1, invitations: 1, states: 1 });
  });

  it('caps active states, sweeping expired rows before rejecting with a typed error', () => {
    const store = freshStore();
    for (let i = 0; i < MAX_ACTIVE_OAUTH_STATES; i += 1) {
      store.createOauthState({
        state: `active-${i}`,
        provider: 'github',
        codeVerifier: `v-${i}`,
        invitationHash: null,
        ttlMs: 60_000,
      });
    }
    expect(() =>
      store.createOauthState({
        state: 'over-cap',
        provider: 'github',
        codeVerifier: 'v',
        invitationHash: null,
        ttlMs: 60_000,
      })
    ).toThrow(TooManyPendingOauthStatesError);

    rawDb(store)
      .prepare('UPDATE auth_oauth_states SET expires_at = ? WHERE state = ?')
      .run(new Date(0).toISOString(), 'active-0');
    expect(() =>
      store.createOauthState({
        state: 'replacement',
        provider: 'github',
        codeVerifier: 'v',
        invitationHash: null,
        ttlMs: 60_000,
      })
    ).not.toThrow();
    const count = rawDb(store).prepare('SELECT COUNT(*) AS count FROM auth_oauth_states').get() as { count: number };
    expect(count.count).toBe(MAX_ACTIVE_OAUTH_STATES);
  });
});

describe('session cookies', () => {
  it('serialize + parse round-trip, HttpOnly and SameSite always present', () => {
    const cookie = serializeCookie('atoma_session', 'tok', { secure: true, maxAgeSeconds: 60 });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=60');
    const parsed = parseCookieHeader(cookie);
    expect(parsed).toEqual([{ name: 'atoma_session', value: 'tok' }]);
  });

  it('sessionTokenFromCookieHeader finds the token among siblings', () => {
    const token = 'A'.repeat(43);
    expect(sessionTokenFromCookieHeader(`other=1; atoma_session=${token}; x=2`)).toBe(token);
    expect(sessionTokenFromCookieHeader(undefined)).toBeNull();
    expect(sessionTokenFromCookieHeader('other=1')).toBeNull();
    expect(sessionTokenFromCookieHeader('atoma_session=not-a-token')).toBeNull();
  });

  it('fails closed when duplicate session cookies make precedence ambiguous', () => {
    expect(
      sessionTokenFromCookieHeader('atoma_session=first; other=1; atoma_session=second')
    ).toBeNull();
  });

  it('collects unique canonical logout candidates despite ambiguous cookies', () => {
    const first = 'A'.repeat(43);
    const second = 'B'.repeat(43);
    expect(
      logoutSessionCandidatesFromCookieHeader(
        `atoma_session=invalid; atoma_session=${first}; other=1; ` +
          `atoma_session=${first}; atoma_session=${second}`
      )
    ).toEqual({ overflow: false, tokens: [first, second] });
  });

  it('returns no partial logout batch when unique candidates exceed the bound', () => {
    const header = Array.from(
      { length: MAX_LOGOUT_SESSION_CANDIDATES + 1 },
      (_, index) => `atoma_session=${String(index).padStart(2, '0')}${'A'.repeat(41)}`
    ).join('; ');
    expect(logoutSessionCandidatesFromCookieHeader(header)).toEqual({
      overflow: true,
      tokens: [],
    });
  });

  it('issueSession returns a Set-Cookie header carrying the clear token', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('1', { displayName: 'A' }), 'org:owner');
    const issued = issueSession(store, viewer, { secure: false });
    expect(issued.setCookie).toContain('atoma_session=');
    expect(issued.setCookie).toContain('HttpOnly');
    expect(store.resolveSession(issued.token)?.principalId).toBe(viewer.principalId);
  });

  it('keeps an inert root tombstone after logout to shadow narrower cookies', () => {
    const cookie = retireSessionCookie({ secure: true });
    expect(cookie).toContain(`atoma_session=${LOGGED_OUT_SESSION_VALUE}`);
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Max-Age=0');
  });
});

// ---------------------------------------------------------------------------
// Account self-care: the display name, avatars and per-tier model pins.
// ---------------------------------------------------------------------------

describe('auth store — display name ownership', () => {
  it('stops provider re-synchronisation once the viewer renames the account', () => {
    const store = freshStore();
    const login = identity('rename-me', { displayName: 'ada-l' });
    const { viewer } = admit(store, login, 'org:owner');
    expect(viewer.displayNameSource).toBe('provider');

    // A provider that changes its own idea of the name still wins here.
    const renamedUpstream = store.completeLogin(
      identity('rename-me', { displayName: 'Ada L.' }),
      null
    );
    expect(renamedUpstream?.viewer.displayName).toBe('Ada L.');

    expect(store.setDisplayName(viewer.principalId, '  Ada Lovelace  ')).toBe('Ada Lovelace');

    // THE REGRESSION: a re-login must not silently revert the chosen name.
    const afterRelogin = store.completeLogin(
      identity('rename-me', { displayName: 'ada-l' }),
      null
    );
    expect(afterRelogin?.viewer.displayName).toBe('Ada Lovelace');
    expect(afterRelogin?.viewer.displayNameSource).toBe('user');
    // ...and the session-resolved viewer agrees with the login outcome.
    const issued = issueSession(store, afterRelogin!.viewer, { secure: false });
    expect(store.resolveSession(issued.token)).toMatchObject({
      displayName: 'Ada Lovelace',
      displayNameSource: 'user',
    });
  });

  it('refuses an empty, oversized or control-laden name, and an unknown principal', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('bounds'), 'org:owner');
    expect(() => store.setDisplayName(viewer.principalId, '   ')).toThrow(/1 to 120/);
    expect(() => store.setDisplayName(viewer.principalId, 'x'.repeat(121))).toThrow(/1 to 120/);
    expect(() => store.setDisplayName(viewer.principalId, 'Ada\u0007Lovelace')).toThrow(
      /control characters/
    );
    expect(() => store.setDisplayName('not-a-principal', 'Ada')).toThrow(/unknown principal/);
  });

  it('adds display_name_source to a store that predates it', () => {
    const store = freshStore('legacy-name.db');
    const { viewer } = admit(store, identity('legacy'), 'org:owner');
    const db = rawDb(store);
    // Rebuild auth_principals without the column, as a pre-release store had it.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE auth_principals_legacy (
        principal_id TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('human','service','system')),
        display_name TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      INSERT INTO auth_principals_legacy (principal_id, kind, display_name, created_at)
      SELECT principal_id, kind, display_name, created_at FROM auth_principals;
      DROP TABLE auth_principals;
      ALTER TABLE auth_principals_legacy RENAME TO auth_principals;
      PRAGMA foreign_keys = ON;
    `);
    expect(tableColumnNames(db, 'auth_principals')).not.toContain('display_name_source');

    const reopened = new AuthStore(db);
    expect(tableColumnNames(db, 'auth_principals')).toContain('display_name_source');
    // Existing rows default to provider-owned, which is what they were.
    expect(reopened.setDisplayName(viewer.principalId, 'Renamed')).toBe('Renamed');
  });
});

describe('auth store — avatars', () => {
  it('stores, replaces and reads back the bytes with a content etag', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('face'), 'org:owner');
    expect(store.readAvatar(viewer.principalId)).toBeNull();
    expect(store.avatarMeta(viewer.principalId)).toBeNull();

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const etag = store.saveAvatar({
      principalId: viewer.principalId,
      mime: 'image/png',
      bytes: png,
      sourceUrl: 'https://avatars.example/a.png',
    });
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect(store.readAvatar(viewer.principalId)).toMatchObject({ mime: 'image/png', etag });
    expect(store.readAvatar(viewer.principalId)?.bytes.equals(png)).toBe(true);
    expect(store.avatarMeta(viewer.principalId)).toEqual({
      etag,
      sourceUrl: 'https://avatars.example/a.png',
    });

    // Same URL, different bytes: a new etag, so the client cache cannot serve
    // the old face.
    const next = store.saveAvatar({
      principalId: viewer.principalId,
      mime: 'image/jpeg',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 9]),
      sourceUrl: 'https://avatars.example/a.png',
    });
    expect(next).not.toBe(etag);
    expect(store.readAvatar(viewer.principalId)?.mime).toBe('image/jpeg');
  });

  it('refuses a mime the avatar pipeline never produces', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('svg'), 'org:owner');
    expect(() =>
      store.saveAvatar({
        principalId: viewer.principalId,
        // Cast past the compile-time union: the CHECK constraint is the
        // runtime guard, and a foreign writer would arrive exactly like this.
        mime: 'image/svg+xml' as 'image/png',
        bytes: Buffer.from('<svg/>'),
        sourceUrl: null,
      })
    ).toThrow();
  });
});

describe('auth store — per-tier model pins', () => {
  it('round-trips a partial pin set and defaults the rest', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('pins'), 'org:owner');
    expect(store.modelPins(viewer.principalId)).toEqual({ l1: null, l2: null, l3: null });

    const saved = store.setModelPins(viewer.principalId, {
      l1: 'claude-haiku-4-5-20251001',
      l2: 'claude-sonnet-5',
      l3: null,
    });
    expect(saved).toEqual({
      l1: 'claude-haiku-4-5-20251001',
      l2: 'claude-sonnet-5',
      l3: null,
    });
    expect(store.modelPins(viewer.principalId)).toEqual(saved);

    // An upsert, not an insert: a second write replaces the row.
    store.setModelPins(viewer.principalId, { l1: null, l2: null, l3: 'claude-opus-5' });
    expect(store.modelPins(viewer.principalId)).toEqual({
      l1: null,
      l2: null,
      l3: 'claude-opus-5',
    });
  });

  it('refuses anything outside the closed choice list, including a selector', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('bad-pins'), 'org:owner');
    for (const pins of [
      { l1: 'gpt-5', l2: null, l3: null },
      { l1: 'ollama:llama3', l2: null, l3: null },
      { l1: '', l2: null, l3: null },
      { l2: null, l3: null },
    ]) {
      expect(() => store.setModelPins(viewer.principalId, pins)).toThrow();
    }
    expect(store.modelPins(viewer.principalId)).toEqual({ l1: null, l2: null, l3: null });
  });

  it('degrades a retired model id to the operator default instead of throwing', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('retired'), 'org:owner');
    store.setModelPins(viewer.principalId, { l1: 'claude-sonnet-5', l2: null, l3: null });
    // A model that existed when the pin was written and no longer does.
    rawDb(store)
      .prepare('UPDATE auth_principal_model_pins SET model_l1 = ? WHERE principal_id = ?')
      .run('claude-sonnet-4', viewer.principalId);
    expect(store.modelPins(viewer.principalId)).toEqual({ l1: null, l2: null, l3: null });
  });

  it('stores ChatGPT subscription pins for supervisors, never for L1', () => {
    const store = freshStore();
    const { viewer } = admit(store, identity('chatgpt-pins'), 'org:owner');
    expect(() =>
      store.setModelPins(viewer.principalId, {
        l1: 'chatgpt-subscription:gpt-5.4-mini',
        l2: null,
        l3: null,
      })
    ).toThrow();
    const pins = store.setModelPins(viewer.principalId, {
      l1: null,
      l2: 'chatgpt-subscription:gpt-5.6-terra',
      l3: 'chatgpt-subscription:gpt-5.6-sol',
    });
    expect(store.modelPins(viewer.principalId)).toEqual(pins);
  });
});

describe('auth store — organisation directory', () => {
  it('narrows the member projection to one organisation and carries the chips', () => {
    const store = freshStore();
    const owner = admit(store, identity('dir-owner', { displayName: 'Owner' }), 'org:owner');
    const member = admit(store, identity('dir-member', { displayName: 'Member' }), 'org:member');
    store.grantPlatformAdmin(owner.viewer.principalId);
    store.saveAvatar({
      principalId: member.viewer.principalId,
      mime: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]),
      sourceUrl: null,
    });

    const one = store.getOrganisationWithMembers(owner.viewer.orgId);
    // Order is `created_at, principal_id` — two admissions in the same
    // millisecond tie on the timestamp and fall back to the surrogate id, so
    // the row set is the contract here, not who lands first.
    expect(one?.members.map((entry) => entry.displayName).sort()).toEqual([
      'Member',
      'Owner',
    ]);
    const ownerRow = one?.members.find((entry) => entry.displayName === 'Owner');
    const memberRow = one?.members.find((entry) => entry.displayName === 'Member');
    expect(ownerRow).toMatchObject({ role: 'org:owner', platformAdmin: true });
    expect(memberRow).toMatchObject({ role: 'org:member', platformAdmin: false });
    expect(memberRow?.avatarEtag).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerRow?.avatarEtag).toBeNull();
    // Emails are display attributes, never directory data.
    expect(JSON.stringify(one)).not.toContain('@');

    expect(store.getOrganisationWithMembers('unknown-org')).toBeNull();
    // The unfiltered admin inventory keeps the same projection.
    expect(store.listOrganisationsWithMembers()).toHaveLength(1);
  });

  it('answers organisation sharing and counts only live invitations', () => {
    const store = freshStore();
    const owner = admit(store, identity('share-owner'), 'org:owner');
    const member = admit(store, identity('share-member'), 'org:member');
    expect(store.sharesOrganisation(owner.viewer.principalId, member.viewer.principalId)).toBe(true);
    expect(store.sharesOrganisation(owner.viewer.principalId, owner.viewer.principalId)).toBe(true);
    expect(store.sharesOrganisation(owner.viewer.principalId, 'stranger')).toBe(false);

    // `admit` consumed one invitation for the member above; a consumed token is
    // not pending.
    expect(store.countLiveInvitations(owner.viewer.orgId)).toBe(0);
    store.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'live-invitation',
      role: 'org:member',
      ttlMs: 60_000,
    });
    // Backdated rather than given a 1ms TTL: a short TTL is a race with the
    // clock, and this assertion must be about expiry, not about timing.
    const expired = store.createInvitation({
      orgId: owner.viewer.orgId,
      token: 'expired-invitation',
      role: 'org:member',
      ttlMs: 60_000,
    });
    rawDb(store)
      .prepare('UPDATE auth_invitations SET created_at = ?, expires_at = ? WHERE token_hash = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', expired.tokenHash);
    expect(store.countLiveInvitations(owner.viewer.orgId)).toBe(1);
    expect(store.countLiveInvitations('unknown-org')).toBe(0);
  });
});
