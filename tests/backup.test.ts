import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runBackup, SNAPSHOT_PREFIX } from '../src/cli/backup.js';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';

/**
 * The earned state (trust counters, skill bodies, traces) is what one disk
 * failure cannot regenerate — the 2026-08-14 review's highest-priority
 * non-code item. These tests prove the snapshot is REAL: the copied store
 * opens and answers queries (online backup, not a raw copy), the tars list
 * their content, pruning keeps exactly N, and the guards refuse the
 * destinations that only look like backups.
 */

const silent = (): void => {};

describe('state backup CLI', () => {
  let root: string;
  let dest: string;
  let storeDb: string;
  let skillsDir: string;
  let runsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-backup-'));
    dest = join(root, 'offsite');
    storeDb = join(root, 'state', 'atoma.db');
    skillsDir = join(root, 'state', 'skills');
    runsDir = join(root, 'state', 'runs');
    mkdirSync(join(root, 'state'), { recursive: true });
    // A real store with one row, through the real schema.
    const reg = new AtomRegistry(openDb(storeDb));
    reg.create(1, {
      description: 'seed',
      systemPrompt: 'sys',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), 'body', 'utf8');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'run-1.json'), '{"id":"run-1"}', 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const opts = (over: Partial<Parameters<typeof runBackup>[0]> = {}) => ({
    dest,
    keep: 14,
    storeDb,
    skillsDir,
    runsDir,
    archiveDir: join(root, 'no-archive-here'),
    repoRoot: join(root, 'fake-repo'),
    log: silent,
    ...over,
  });

  it('produces a snapshot whose store COPY opens and answers queries', async () => {
    const res = await runBackup(opts());
    expect(res.captured).toEqual(['store.db', 'skills.tar.gz', 'runs.tar.gz']);
    expect(res.skipped.join(',')).toMatch(/archive/);

    const copied = new Database(join(res.snapshotDir, 'store.db'), { readonly: true });
    try {
      const row = copied.prepare('SELECT COUNT(*) AS n FROM atom_types').get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      copied.close();
    }
    // The tars actually contain the state, not just exist.
    const listing = spawnSync('tar', ['-tzf', join(res.snapshotDir, 'runs.tar.gz')], {
      encoding: 'utf8',
    });
    expect(listing.stdout).toMatch(/run-1\.json/);
    const manifest = JSON.parse(
      readFileSync(join(res.snapshotDir, 'manifest.json'), 'utf8')
    ) as Record<string, { entries?: number }>;
    expect(manifest['runs']?.entries).toBe(1);
  });

  it('prunes oldest-first down to --keep, touching ONLY its own prefix', async () => {
    mkdirSync(join(dest, `${SNAPSHOT_PREFIX}2020-01-01T00-00-00-000`), { recursive: true });
    mkdirSync(join(dest, `${SNAPSHOT_PREFIX}2021-01-01T00-00-00-000`), { recursive: true });
    mkdirSync(join(dest, 'unrelated-backup'), { recursive: true });
    const res = await runBackup(opts({ keep: 2 }));
    expect(res.pruned).toEqual([`${SNAPSHOT_PREFIX}2020-01-01T00-00-00-000`]);
    expect(existsSync(join(dest, 'unrelated-backup'))).toBe(true);
    expect(existsSync(join(dest, `${SNAPSHOT_PREFIX}2021-01-01T00-00-00-000`))).toBe(true);
    expect(existsSync(res.snapshotDir)).toBe(true);
  });

  it('refuses a destination inside the repository — a same-tree backup protects nothing', async () => {
    await expect(
      runBackup(opts({ dest: join(root, 'fake-repo', 'backups'), repoRoot: join(root, 'fake-repo') }))
    ).rejects.toThrow(/inside the repository/);
  });

  it('resolves the archive tier against the real home, not an empty HOME', async () => {
    // `join(process.env['HOME'] ?? '', '.atoma', 'archive')` resolved to the
    // RELATIVE `.atoma/archive` wherever HOME is unset — always on Windows —
    // so `existsSync` was false and the tier was skipped under a line reading
    // "backup complete". Deleting HOME reproduces that state on any host:
    // `homedir()` still answers an absolute path (passwd entry on POSIX,
    // USERPROFILE on win32), an empty-string join never can.
    const saved = process.env['HOME'];
    delete process.env['HOME'];
    try {
      const res = await runBackup({ ...opts(), archiveDir: undefined });
      const archive = res.skipped.find((entry) => entry.startsWith('archive'));
      // Nothing here has an ~/.atoma/archive, so a skip is the right outcome;
      // WHICH path it skipped is the assertion.
      expect(archive).toBeDefined();
      const named = /archive \((.*) missing\)/.exec(archive!)?.[1] ?? '';
      expect(named, archive).not.toBe('');
      expect(isAbsolute(named), `archive tier resolved to a relative path: ${named}`).toBe(true);
      expect(named).toContain('.atoma');
    } finally {
      if (saved === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved;
    }
  });

  it('a missing store is a loud skip, never a silent empty snapshot', async () => {
    const res = await runBackup(opts({ storeDb: join(root, 'nope.db') }));
    expect(res.captured).not.toContain('store.db');
    expect(res.skipped.join(',')).toMatch(/store/);
  });

  it('is import-safe: loading the module never runs main()', async () => {
    // The friction.ts lesson — an unconditional main() failed test collection
    // on a fresh checkout. Importing at the top of this file already proves
    // it, but pin the guard explicitly.
    const mod = await import('../src/cli/backup.js');
    expect(typeof mod.runBackup).toBe('function');
  });
});
