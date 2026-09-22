import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuthStore, type Viewer } from '../src/auth/store.js';
import {
  declaredHostSubscriptionOrg,
  mayManageSubscriptionDelegations,
  setSubscriptionDelegate,
  SubscriptionDelegationError,
} from '../src/auth/subscriptionDelegates.js';
import { runAuthCli } from '../src/cli/auth.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';
import { PlatformEventLog } from '../src/platform/events.js';

/**
 * WHO, BESIDES A PLATFORM ADMIN, MAY SPEND THE MACHINE'S OWN LOGIN SESSION.
 *
 * The three doors (CLI, HTTP route, MCP tool) share `setSubscriptionDelegate`,
 * so the rules are proven ONCE here against that body plus the store it
 * writes, and each door is proven separately to be mounted on it — the HTTP
 * one in `viz-auth-gate.test.ts`, the MCP row's tier in `mcp-http.test.ts`,
 * and the CLI at the bottom of this file, through `runAuthCli` itself.
 */

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-subscription-delegation-'));
  roots.push(root);
  return join(root, 'atoma.db');
}

interface Fixture {
  dbPath: string;
  store: AuthStore;
  admin: Viewer;
  member: Viewer;
  outsider: Viewer;
  events: PlatformEventInput[];
  emit: (event: PlatformEventInput) => void;
}

function fixture(): Fixture {
  const dbPath = tempDb();
  const store = AuthStore.open(dbPath);
  const founder = store.completeLogin(
    { provider: 'github', subject: 'founder', displayName: 'Founder', email: null, emailVerified: false },
    null
  );
  if (!founder) throw new Error('founder bootstrap failed');
  const invitation = store.createInvitation({
    orgId: founder.viewer.orgId,
    token: 'member-joins-the-operator-org',
    role: 'org:member',
    ttlMs: 60_000,
  });
  const member = store.completeLogin(
    { provider: 'github', subject: 'member', displayName: 'Member', email: 'member@example.com', emailVerified: false },
    invitation.tokenHash
  );
  if (!member) throw new Error('member admission failed');
  // Their own organisation, created by their own first login: the shape a
  // second account has before anyone invites it anywhere.
  const outsider = store.completeLogin(
    { provider: 'github', subject: 'outsider', displayName: 'Outsider', email: null, emailVerified: false },
    null
  );
  if (!outsider) throw new Error('outsider bootstrap failed');
  store.grantPlatformAdmin(founder.viewer.principalId);
  const events: PlatformEventInput[] = [];
  return {
    dbPath,
    store,
    admin: { ...founder.viewer, platformAdmin: true },
    member: member.viewer,
    outsider: outsider.viewer,
    events,
    emit: (event) => events.push(event),
  };
}

describe('host-subscription delegation — the shared body', () => {
  it('lets a platform admin hand the host login to a member of the declared organisation', () => {
    const f = fixture();
    expect(f.store.isSubscriptionDelegate(f.member.principalId, f.admin.orgId)).toBe(false);

    const granted = setSubscriptionDelegate({
      auth: f.store,
      actor: { kind: 'principal', viewer: f.admin },
      principalRef: f.member.principalId,
      declaredOrg: f.admin.orgId,
      delegated: true,
      emit: f.emit,
    });
    expect(granted).toMatchObject({
      principalId: f.member.principalId,
      orgId: f.admin.orgId,
      delegated: true,
      already: false,
    });
    expect(f.store.isSubscriptionDelegate(f.member.principalId, f.admin.orgId)).toBe(true);
    // The delegate gains NO other operator power: that is the whole point of
    // not reusing the flag.
    expect(f.store.isPlatformAdmin(f.member.principalId)).toBe(false);
    expect(mayManageSubscriptionDelegations({ ...f.member })).toBe(false);
    expect(f.events).toEqual([
      expect.objectContaining({
        kind: 'admin.subscription_delegated',
        actorType: 'principal',
        actorId: f.admin.principalId,
        orgId: f.admin.orgId,
      }),
    ]);

    // Idempotent, and a no-op journals nothing: the row already said this.
    const again = setSubscriptionDelegate({
      auth: f.store,
      actor: { kind: 'principal', viewer: f.admin },
      principalRef: 'member@example.com',
      declaredOrg: f.admin.orgId,
      delegated: true,
      emit: f.emit,
    });
    expect(again).toMatchObject({ principalId: f.member.principalId, already: true });
    expect(f.events).toHaveLength(1);

    const withdrawn = setSubscriptionDelegate({
      auth: f.store,
      actor: { kind: 'principal', viewer: f.admin },
      principalRef: f.member.principalId,
      declaredOrg: f.admin.orgId,
      delegated: false,
      emit: f.emit,
    });
    expect(withdrawn).toMatchObject({ delegated: false, already: false });
    expect(f.store.isSubscriptionDelegate(f.member.principalId, f.admin.orgId)).toBe(false);
    expect(f.events[1]).toMatchObject({ kind: 'admin.subscription_revoked' });
    // Revocation leaves the member's own pins alone: they are data, refused
    // by name at the next launch rather than erased behind their back.
    expect(f.store.modelPins(f.member.principalId)).toBeTruthy();
  });

  it('refuses every way of minting an authority nobody could exercise', () => {
    const f = fixture();
    const attempt = (input: Partial<Parameters<typeof setSubscriptionDelegate>[0]>) =>
      setSubscriptionDelegate({
        auth: f.store,
        actor: { kind: 'principal', viewer: f.admin },
        principalRef: f.member.principalId,
        declaredOrg: f.admin.orgId,
        delegated: true,
        emit: f.emit,
        ...input,
      });

    // NOT A PLATFORM ADMIN: the authority to hand out operator spend is not
    // itself delegated, so a delegate can never widen the circle.
    expect(() => attempt({ actor: { kind: 'principal', viewer: f.member } })).toThrow(
      SubscriptionDelegationError
    );
    expect(() => attempt({ actor: { kind: 'principal', viewer: f.member } })).toThrow(
      /platform admin required/
    );
    // NO DECLARATION: there is no organisation whose runs could spend it.
    expect(() => attempt({ declaredOrg: null })).toThrow(/ATOMA_HOST_SUBSCRIPTION_ORG/);
    // ANOTHER ORGANISATION: the coordinator refuses a `sub:` pin there
    // anyway, so the row would be an authority nobody would think to revoke.
    expect(() => attempt({ orgId: f.outsider.orgId })).toThrow(
      /is not the one this deployment declares/
    );
    // NOT A MEMBER: they could not launch a run in this organisation at all.
    expect(() => attempt({ principalRef: f.outsider.principalId })).toThrow(/is not a member/);
    // UNKNOWN PRINCIPAL: the store never guesses an identity.
    expect(() => attempt({ principalRef: 'nobody@example.com' })).toThrow(/no principal matches/);

    expect(f.events).toEqual([]);
    expect(f.store.listSubscriptionDelegates()).toEqual([]);
  });

  it('reads as empty on a store written before the table existed', () => {
    const dbPath = tempDb();
    const seeded = AuthStore.open(dbPath);
    const founder = seeded.completeLogin(
      { provider: 'github', subject: 'founder', displayName: 'Founder', email: null, emailVerified: false },
      null
    );
    if (!founder) throw new Error('founder bootstrap failed');
    seeded.close();
    closeStoreHandles();

    // The shape an existing production store has: every older auth table, and
    // no delegation table. Reads must answer "nobody", not throw — the member
    // listing and `auth list` both walk this path on an unmigrated open.
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE auth_subscription_delegates');
      const store = new AuthStore(db, { initialize: false });
      expect(store.isSubscriptionDelegate(founder.viewer.principalId, founder.viewer.orgId)).toBe(false);
      expect(store.listSubscriptionDelegates()).toEqual([]);
      expect(store.listOrganisationsWithMembers(founder.viewer.orgId)[0]?.members).toEqual([
        expect.objectContaining({ subscriptionDelegate: false }),
      ]);
      expect(
        store.revokeSubscriptionDelegate(founder.viewer.principalId, founder.viewer.orgId)
      ).toMatchObject({ already: true });
    } finally {
      db.close();
    }
  });
});

describe('host-subscription delegation — every run launcher asks BOTH authorities', () => {
  /**
   * Source presence, deliberately, and the ONE case AGENTS.md admits it for.
   * Two processes construct a `ProjectRunCoordinator` — the viz server and
   * the projects CLI — and each passes the authorities as QUESTIONS. An
   * absent resolver means "no", so a launcher that wires only
   * `platformAdmins` refuses every delegate AFTER its own early guard let
   * them through. Observing that behaviourally through the CLI means
   * reaching `coordinator.start`, which spawns a real runner and spends
   * quota; the coordinator's own two answers are already proven in
   * `project-coordinator.test.ts`. What is left, and what this asserts, is
   * that neither construction site forgets the second question.
   */
  it.each([
    ['src/viz/server.ts', 'the browser and MCP path'],
    ['src/cli/projects.ts', 'npm run projects -- run --as'],
  ])('%s wires both authorities (%s)', (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source).toMatch(/platformAdmins:/);
    expect(source).toMatch(/subscriptionDelegates:/);
  });
});

describe('host-subscription delegation — the operator CLI door', () => {
  it('grants, lists and withdraws through runAuthCli, journaling each decision', () => {
    const f = fixture();
    f.store.close();
    closeStoreHandles();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { ATOMA_HOST_SUBSCRIPTION_ORG: f.admin.orgId };

    // --principal is required, and the declared organisation is the default.
    expect(runAuthCli(['node', 'auth', 'grant-subscription', '--db', f.dbPath], env)).toBe(1);
    expect(
      runAuthCli(
        ['node', 'auth', 'grant-subscription', '--principal', 'member@example.com', '--db', f.dbPath],
        env
      )
    ).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Host subscription delegated to Member');

    // Without the declaration the CLI refuses rather than writing a row whose
    // authority no run could ever use.
    expect(
      runAuthCli(
        ['node', 'auth', 'grant-subscription', '--principal', 'member@example.com', '--db', f.dbPath],
        {}
      )
    ).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('ATOMA_HOST_SUBSCRIPTION_ORG');

    log.mockClear();
    expect(runAuthCli(['node', 'auth', 'list', '--db', f.dbPath], env)).toBe(0);
    const listing = log.mock.calls.flat().join('\n');
    expect(listing).toContain('1 host-subscription delegate(s)');
    expect(listing).toContain(`Member (${f.member.principalId}) @ ${f.admin.orgId}`);

    const journal = PlatformEventLog.open(f.dbPath);
    expect(
      journal.list({ limit: 10 }).events.filter(
        (event) => event.kind === 'admin.subscription_delegated'
      )
    ).toEqual([
      expect.objectContaining({ actorType: 'cli', orgId: f.admin.orgId, severity: 'security' }),
    ]);

    log.mockClear();
    expect(
      runAuthCli(
        ['node', 'auth', 'revoke-subscription', '--principal', f.member.principalId, '--db', f.dbPath],
        env
      )
    ).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Host subscription withdrawn from Member');
    const reopened = AuthStore.open(f.dbPath);
    try {
      expect(reopened.listSubscriptionDelegates()).toEqual([]);
    } finally {
      reopened.close();
    }
    expect(declaredHostSubscriptionOrg(env)).toBe(f.admin.orgId);
    expect(declaredHostSubscriptionOrg({})).toBeNull();
  });
});
