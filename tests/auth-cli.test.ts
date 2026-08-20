import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuthStore } from '../src/auth/store.js';
import { runAuthCli } from '../src/cli/auth.js';
import { closeStoreHandles } from '../src/core/stores.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-auth-cli-'));
  roots.push(root);
  return join(root, 'atoma.db');
}

function seedOrganisation(dbPath: string): string {
  const store = AuthStore.open(dbPath);
  const outcome = store.completeLogin({
    provider: 'github',
    subject: `owner-${Math.random()}`,
    displayName: 'Owner',
    email: null,
    emailVerified: false,
  }, null);
  if (!outcome) throw new Error('failed to seed organisation');
  return outcome.viewer.orgId;
}

describe('auth operator CLI', () => {
  it('shows help for --help and rejects unknown commands/flags', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runAuthCli(['node', 'auth', '--help'], {})).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('atoma auth');

    expect(runAuthCli(['node', 'auth', 'destroy'], {})).toBe(1);
    expect(runAuthCli(['node', 'auth', 'list', '--mystery'], {})).toBe(1);
    expect(runAuthCli(['node', 'auth', 'list', '--db'], {})).toBe(1);
    expect(runAuthCli(['node', 'auth', 'list', '--role', 'org:viewer'], {})).toBe(1);
    // Platform-admin commands: --principal is required there and only there.
    expect(runAuthCli(['node', 'auth', 'grant-admin'], {})).toBe(1);
    expect(runAuthCli(['node', 'auth', 'revoke-admin'], {})).toBe(1);
    expect(runAuthCli(['node', 'auth', 'list', '--principal', 'x@y.z'], {})).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toMatch(/unknown auth command|unknown flag/);
  });

  it('lists a missing store without creating it', () => {
    const dbPath = tempDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(runAuthCli(['node', 'auth', 'list', '--db', dbPath], {})).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('nothing to read');
  });

  it('creates a one-use targeted invitation and persists only its hash', () => {
    const dbPath = tempDb();
    const orgId = seedOrganisation(dbPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = { ATOMA_VIZ_PUBLIC_ORIGIN: 'https://viz.example' };

    expect(
      runAuthCli(
        ['node', 'auth', 'invite', '--db', dbPath, '--org', orgId, '--ttl-hours', '1'],
        env
      )
    ).toBe(0);
    const output = log.mock.calls.flat().join('\n');
    const token = output.match(/Token \(shown once\): ([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    expect(output).toContain(`https://viz.example/?invite=${token}`);
    expect(output).toContain('org:member');
    expect(output).toContain(orgId);

    closeStoreHandles();
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT * FROM auth_invitations').all();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
    } finally {
      db.close();
    }
  });

  it('refuses an invitation before the first user has created an organisation', () => {
    const dbPath = tempDb();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      runAuthCli(
        ['node', 'auth', 'invite', '--db', dbPath, '--org', 'missing-org'],
        {}
      )
    ).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('first user must sign in');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('uses the injected ATOMA_DB_PATH instead of ambient process state', () => {
    const dbPath = tempDb();
    const orgId = seedOrganisation(dbPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      runAuthCli(['node', 'auth', 'invite', '--org', orgId], { ATOMA_DB_PATH: dbPath })
    ).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    closeStoreHandles();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM auth_invitations').get() as { count: number }).count
      ).toBe(1);
    } finally {
      db.close();
    }

    expect(runAuthCli(['node', 'auth', 'list'], { ATOMA_DB_PATH: dbPath })).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('1 active invitation');
  });

  it('lists an existing product DB with no auth schema without mutating it', () => {
    const dbPath = tempDb();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'kept\')');
    db.close();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runAuthCli(['node', 'auth', 'list', '--db', dbPath], {})).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('no principals');

    const after = new Database(dbPath, { readonly: true });
    try {
      expect(
        (after.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB 'auth_*'").get() as { count: number }).count
      ).toBe(0);
      expect(after.prepare('SELECT value FROM sentinel').pluck().get()).toBe('kept');
    } finally {
      after.close();
    }
  });

  it.each([
    ['missing db value', ['invite', '--db']],
    ['missing org value', ['invite', '--org']],
    ['missing role value', ['invite', '--role']],
    ['missing ttl value', ['invite', '--ttl-hours']],
    ['invalid role', ['invite', '--role', 'owner']],
    ['invalid ttl', ['invite', '--ttl-hours', 'NaN']],
  ] as const)('rejects %s before opening the database', (_label, args) => {
    const dbPath = tempDb();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      runAuthCli(['node', 'auth', ...args], { ATOMA_DB_PATH: dbPath })
    ).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects an invalid configured public origin before opening the database', () => {
    const dbPath = tempDb();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      runAuthCli(['node', 'auth', 'invite', '--db', dbPath, '--org', 'org'], {
        ATOMA_VIZ_PUBLIC_ORIGIN: 'http://viz.example',
      })
    ).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
    expect(error.mock.calls.flat().join('\n')).toContain('ATOMA_VIZ_PUBLIC_ORIGIN');
  });

  it.each(['0', '-1', 'NaN', '721'])('rejects unsafe invitation lifetime %s', (hours) => {
    const dbPath = tempDb();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      runAuthCli(
        ['node', 'auth', 'invite', '--db', dbPath, '--org', 'org', '--ttl-hours', hours],
        {}
      )
    ).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
  });
});
