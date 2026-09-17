import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  OPTIONAL_TIERS_ENV,
  parseOptionalTiers,
  PROJECTS_TAR_EXCLUDES,
  runBackup,
  sha256File,
  SNAPSHOT_PREFIX,
  type DirectoryTierManifest,
} from '../src/cli/backup.js';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { verdictsDirPath } from '../src/supervisor/paths.js';

/**
 * The earned state (trust counters, skill bodies, traces) is what one disk
 * failure cannot regenerate — the 2026-08-14 review's highest-priority
 * non-code item. These tests prove the snapshot is REAL: the copied store
 * opens and answers queries (online backup, not a raw copy), the tars list
 * their content, pruning keeps exactly N, and the guards refuse the
 * destinations that only look like backups.
 *
 * Since 2026-09-14 the snapshot also carries the two gated corpora the value
 * audit found missing — org-scoped project runs and supervisor records — and
 * the manifest is an inventory: per-tier SHA-256, recursive file counts, the
 * recorded exclusions, and the `captured`/`skipped` lists themselves.
 */

const silent = (): void => {};

type Manifest = Record<string, unknown> & {
  captured?: string[];
  skipped?: string[];
  store?: { source: string; bytes: number; sha256: string };
};

function tarListing(archive: string): string {
  return spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;
}

function readManifest(snapshotDir: string): Manifest {
  return JSON.parse(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8')) as Manifest;
}

describe('state backup CLI', () => {
  let root: string;
  let dest: string;
  let storeDb: string;
  let skillsDir: string;
  let runsDir: string;
  let projectsRoot: string;
  let supervisorDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-backup-'));
    dest = join(root, 'offsite');
    storeDb = join(root, 'state', 'atoma.db');
    skillsDir = join(root, 'state', 'skills');
    runsDir = join(root, 'state', 'runs');
    projectsRoot = join(root, 'state', 'projects');
    supervisorDir = join(root, 'state', 'supervisor');
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
    // One org-scoped project run, laid out by the production helper so the
    // test follows the coordinator if the layout ever moves.
    const layout = projectRunHostLayout(projectsRoot, 'org-1', 'proj-1', 'run-p1');
    mkdirSync(layout.runsPath, { recursive: true });
    writeFileSync(join(layout.runsPath, 'run-p1.json'), '{"id":"run-p1"}', 'utf8');
    writeFileSync(layout.logPath, 'run log', 'utf8');
    mkdirSync(join(layout.workspacePath, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(layout.workspacePath, 'index.js'), 'export {}', 'utf8');
    writeFileSync(
      join(layout.workspacePath, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = 1',
      'utf8'
    );
    // Things that share the projects ROOT but are not the project corpus.
    mkdirSync(join(projectsRoot, 'workspaces', 'build'), { recursive: true });
    writeFileSync(join(projectsRoot, 'mcp-run-lock.db'), '', 'utf8');
    // One analyst verdict.
    mkdirSync(verdictsDirPath(supervisorDir), { recursive: true });
    writeFileSync(join(verdictsDirPath(supervisorDir), 'run-p1.json'), '{"grade":"ok"}', 'utf8');
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
    projectsRoot,
    supervisorDir,
    repoRoot: join(root, 'fake-repo'),
    log: silent,
    ...over,
  });

  it('produces a snapshot whose store COPY opens and answers queries', async () => {
    const res = await runBackup(opts());
    expect(res.captured).toEqual([
      'store.db',
      'skills.tar.gz',
      'runs.tar.gz',
      'projects.tar.gz',
      'supervisor.tar.gz',
    ]);
    expect(res.skipped.join(',')).toMatch(/archive/);

    const copied = new Database(join(res.snapshotDir, 'store.db'), { readonly: true });
    try {
      const row = copied.prepare('SELECT COUNT(*) AS n FROM atom_types').get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      copied.close();
    }
    // The tars actually contain the state, not just exist.
    expect(tarListing(join(res.snapshotDir, 'runs.tar.gz'))).toMatch(/run-1\.json/);
    const manifest = readManifest(res.snapshotDir);
    expect((manifest['runs'] as DirectoryTierManifest).entries).toBe(1);
  });

  it('captures the org-scoped project corpus under orgs/, minus node_modules, and records the exclusion', async () => {
    const res = await runBackup(opts());
    const listing = tarListing(join(res.snapshotDir, 'projects.tar.gz'));
    // Evidence the audit needs: trace, log, the workspace with its own files.
    expect(listing).toMatch(/orgs\/org-1\/projects\/proj-1\/runs\/run-p1\/traces\/run-p1\.json/);
    expect(listing).toMatch(/orgs\/org-1\/projects\/proj-1\/runs\/run-p1\/run\.log/);
    expect(listing).toMatch(/runs\/run-p1\/workspace\/index\.js/);
    // Regenerable dependency trees stay out — and the manifest SAYS so.
    expect(listing).not.toMatch(/node_modules/);
    // Siblings of orgs/ under the projects root are not the project corpus.
    expect(listing).not.toMatch(/workspaces|mcp-run-lock/);

    const manifest = readManifest(res.snapshotDir);
    const projects = manifest['projects'] as DirectoryTierManifest;
    expect(projects.source).toBe(join(projectsRoot, 'orgs'));
    expect(projects.excluded).toEqual([...PROJECTS_TAR_EXCLUDES]);
    // traces/run-p1.json, run.log, workspace/index.js — the excluded file is not counted.
    expect(projects.files).toBe(3);
    expect(projects.sha256).toBe(await sha256File(join(res.snapshotDir, 'projects.tar.gz')));
  });

  it('captures the supervisor records tier', async () => {
    const res = await runBackup(opts());
    const listing = tarListing(join(res.snapshotDir, 'supervisor.tar.gz'));
    expect(listing).toMatch(/supervisor\/verdicts\/run-p1\.json/);
    const manifest = readManifest(res.snapshotDir);
    const tier = manifest['supervisor'] as DirectoryTierManifest;
    expect(tier.files).toBe(1);
    expect(tier.excluded).toBeUndefined();
    expect(tier.sha256).toBe(await sha256File(join(res.snapshotDir, 'supervisor.tar.gz')));
  });

  it('writes an inventory manifest: captured and skipped lists plus a store fingerprint', async () => {
    const res = await runBackup(opts({ supervisorDir: join(root, 'no-supervisor') }));
    const manifest = readManifest(res.snapshotDir);
    expect(manifest.captured).toEqual(res.captured);
    expect(manifest.skipped).toEqual(res.skipped);
    expect(manifest.skipped).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^archive \(/),
        expect.stringMatching(/^supervisor \(.*no-supervisor missing\)$/),
      ])
    );
    expect(manifest['supervisor']).toBeUndefined();
    expect(manifest.store?.sha256).toBe(await sha256File(join(res.snapshotDir, 'store.db')));
  });

  it('resolves the two gated tiers from the product env vars, orgs/ child included', async () => {
    const savedProjects = process.env['ATOMA_PROJECTS_ROOT'];
    const savedSupervisor = process.env['ATOMA_SUPERVISOR_DIR'];
    const envProjects = join(root, 'env-projects');
    const envSupervisor = join(root, 'env-supervisor');
    process.env['ATOMA_PROJECTS_ROOT'] = envProjects;
    process.env['ATOMA_SUPERVISOR_DIR'] = envSupervisor;
    try {
      const res = await runBackup({ ...opts(), projectsRoot: undefined, supervisorDir: undefined });
      // Neither exists here, so both skip — WHICH path they name is the assertion.
      expect(res.skipped).toEqual(
        expect.arrayContaining([
          `projects (${join(envProjects, 'orgs')} missing)`,
          `supervisor (${envSupervisor} missing)`,
        ])
      );
    } finally {
      if (savedProjects === undefined) delete process.env['ATOMA_PROJECTS_ROOT'];
      else process.env['ATOMA_PROJECTS_ROOT'] = savedProjects;
      if (savedSupervisor === undefined) delete process.env['ATOMA_SUPERVISOR_DIR'];
      else process.env['ATOMA_SUPERVISOR_DIR'] = savedSupervisor;
    }
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

  it('separates a tier this deployment does not have from one expected and lost', async () => {
    // The deployed shape has no ~/.atoma/archive: it holds pre/post-benchmark
    // store archives and a server runs no benchmarks. DECLARED, that absence
    // is a shape fact. Undeclared, the identical absence is the only signal
    // that earned state went missing — so the two must not share a list.
    const lines: string[] = [];
    const res = await runBackup(
      opts({ optionalTiers: ['archive'], log: (line: string) => lines.push(line) })
    );
    expect(res.skipped).toEqual([]);
    expect(res.notApplicable).toEqual([
      expect.stringMatching(/^archive \(.*declared not applicable\)$/),
    ]);
    expect(lines.join('\n')).toContain('✓ backup complete');

    const manifest = readManifest(res.snapshotDir);
    expect(manifest['optionalTiers']).toEqual(['archive']);
    expect(manifest['notApplicable']).toEqual(res.notApplicable);
    expect(manifest.skipped).toEqual([]);
  });

  it('reports an undeclared missing tier as a loss and never calls that complete', async () => {
    const lines: string[] = [];
    const res = await runBackup(
      opts({
        supervisorDir: join(root, 'supervisor-gone'),
        optionalTiers: ['archive'],
        log: (line: string) => lines.push(line),
      })
    );
    expect(res.skipped).toEqual([
      expect.stringMatching(/^supervisor \(.*supervisor-gone missing\)$/),
    ]);
    const summary = lines.join('\n');
    expect(summary).toContain('backup INCOMPLETE');
    expect(summary).not.toContain('✓ backup complete');
    // The message has to say how a real shape fact gets declared, or the next
    // operator silences the tier the only way left to them.
    expect(summary).toContain(OPTIONAL_TIERS_ENV);
  });

  it('reads the declaration from the deployment env', async () => {
    const saved = process.env[OPTIONAL_TIERS_ENV];
    process.env[OPTIONAL_TIERS_ENV] = 'archive';
    try {
      const res = await runBackup({ ...opts(), optionalTiers: undefined });
      expect(res.skipped).toEqual([]);
      expect(res.notApplicable).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env[OPTIONAL_TIERS_ENV];
      else process.env[OPTIONAL_TIERS_ENV] = saved;
    }
  });

  it('refuses an unknown tier name and refuses to make the store optional', () => {
    expect(parseOptionalTiers('archive, supervisor')).toEqual(['archive', 'supervisor']);
    expect(parseOptionalTiers(undefined)).toEqual([]);
    // A typo must fail loudly: silently ignored, it would leave the tier the
    // operator meant to declare mandatory, and they would read the next red
    // drill as the bug rather than as their own typo.
    expect(() => parseOptionalTiers('archives')).toThrow(/unknown tier/);
    expect(() => parseOptionalTiers('store')).toThrow(/cannot be optional/);
  });

  it('records the host-held key the copied store still needs, and never the key', async () => {
    const res = await runBackup(opts());
    const secrets = readManifest(res.snapshotDir)['secrets'] as Record<string, unknown>;
    expect(secrets['keyMaterialIncluded']).toBe(false);
    expect(secrets['keyEnvVars']).toContain('ATOMA_SECRET_ENCRYPTION_KEY');
    // Naming the dependency is not proving recovery, and the note says so.
    expect(String(secrets['note'])).toMatch(/does not do that and does not prove it/);
    // This fixture's store has no auth tables, so the dependency does not bite
    // here — which is the fact a reader needs, not a boilerplate warning.
    expect(secrets['encryptedOrgProviderKeys']).toBe(0);
  });

  it('is import-safe: loading the module never runs main()', async () => {
    // The friction.ts lesson — an unconditional main() failed test collection
    // on a fresh checkout. Importing at the top of this file already proves
    // it, but pin the guard explicitly.
    const mod = await import('../src/cli/backup.js');
    expect(typeof mod.runBackup).toBe('function');
  });
});
