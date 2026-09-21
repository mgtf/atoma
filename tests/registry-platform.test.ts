import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb, registryIsPartitioned } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import { closeStoreHandles } from '../src/core/stores.js';

/**
 * ONE registry, ONE trust, for every run on the platform
 * (`docs/platform-trust-2026-09-15.md`). What these hold:
 *   - two registries opened on one store see and bump the same rows, in one
 *     process and across processes;
 *   - a store still partitioned by owner (2026-09-09 layout) is folded back:
 *     same-name project rows are ABSORBED into the platform row with their
 *     counters added and the identity mapping recorded, other project rows
 *     join whole, the file is backed up first, and the fold is idempotent;
 *   - a fold that cannot complete leaves the partitioned store untouched.
 */

const seed = { description: 'Reads documented constraints', systemPrompt: 'Read authorized sources.',
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }],
  params: { temperature: 0 }, createdBy: 'seed' };
const roots: string[] = [];
// Skill trust is rows in the store (W4): a test's handle-less registry keeps
// the cached handle open, and Windows will not remove a directory holding an
// open database file.
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), 'atoma-registry-platform-')); roots.push(root); return root; }

// The 2026-09-09 partitioned schema, deliberately frozen rather than derived.
const PARTITIONED = `CREATE TABLE atom_types (
  owner_key TEXT NOT NULL DEFAULT 'operator', tier INTEGER NOT NULL, ordinal INTEGER NOT NULL, atom_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL DEFAULT '[]',
  params_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner_key, tier, ordinal), UNIQUE(owner_key, name));
CREATE TABLE atom_type_versions (owner_key TEXT NOT NULL DEFAULT 'operator', tier INTEGER NOT NULL, ordinal INTEGER NOT NULL, version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL, params_json TEXT NOT NULL,
  modified_by TEXT NOT NULL, modified_at TEXT NOT NULL, reason TEXT, PRIMARY KEY(owner_key, tier, ordinal, version));
CREATE UNIQUE INDEX idx_atom_types_atom_id ON atom_types(atom_id);`;

interface Owned { owner: string; tier: number; ordinal: number; atomId?: string; name: string; prompt?: string; successes?: number; failures?: number; at?: string }
function partitionedStore(path: string, rows: Owned[]): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); db.exec(PARTITIONED);
  const insert = db.prepare(`INSERT INTO atom_types(owner_key,tier,ordinal,atom_id,name,description,system_prompt,created_by,created_at,version,successes,failures)
    VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`);
  for (const row of rows) {
    insert.run(row.owner, row.tier, row.ordinal, row.atomId ?? randomUUID(), row.name, `${row.name} description`,
      row.prompt ?? `${row.name} prompt`, row.owner, row.at ?? '2026-09-10', row.successes ?? 0, row.failures ?? 0);
    db.prepare(`INSERT INTO atom_type_versions VALUES(?,?,?,1,?,'[]','{}','validator',?,'first version')`)
      .run(row.owner, row.tier, row.ordinal, `${row.name} old prompt`, row.at ?? '2026-09-10');
  }
  db.exec("CREATE TABLE unrelated_evidence(value TEXT); INSERT INTO unrelated_evidence VALUES('keep exactly');");
  return db;
}

describe('one platform registry', () => {
  it('lets every handle on one store read the same rows and bump the same counters', () => {
    const db = openDb(':memory:');
    try {
      const first = new AtomRegistry(db); const second = new AtomRegistry(db);
      const type = first.create(1, seed);
      expect(second.getByAtomId(type.atomId)).toEqual(type);
      first.recordSuccess(type.name); second.recordSuccess(type.name); second.recordFailure(type.name);
      expect(first.getByName(type.name)).toMatchObject({ successes: 2, failures: 1 });
      expect(projectCounters(readLedger(db)).get(type.atomId)).toEqual({ successes: 2, failures: 1 });
      second.patch(type.name, { systemPromptAppend: 'shared coaching' }, 'validator', 'reason');
      expect(first.getByName(type.name)?.systemPrompt).toContain('shared coaching');
      expect(first.listVersions(type.name)).toHaveLength(1);
      expect(() => second.create(1, seed)).not.toThrow();
      expect(new Set(first.listByTier(1).map((row) => row.name)).size).toBe(2);
    } finally { db.close(); }
  });

  it('keeps identity, history and trust across processes with no owner to name', () => {
    const dbPath = join(directory(), 'store.db');
    const db = openDb(dbPath);
    const registry = new AtomRegistry(db);
    const atom = registry.create(2, seed);
    registry.patch(atom.name, { systemPromptAppend: 'Shared fact 731' }, 'owner', 'reason');
    registry.recordSuccess(atom.name);
    const expected = { type: registry.getByAtomId(atom.atomId), history: registry.listVersions(atom.name) };
    db.close();
    const source = String.raw`import { readFileSync } from 'node:fs';
      import { AtomRegistry } from './src/registry/atomRegistry.ts'; import { openDb } from './src/registry/db.ts';
      const {dbPath,id,name}=JSON.parse(readFileSync(0,'utf8')); const db=openDb(dbPath);
      const r=new AtomRegistry(db); process.stdout.write(JSON.stringify({type:r.getByAtomId(id),history:r.listVersions(name)})); db.close();`;
    expect(JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      input: JSON.stringify({ dbPath, id: atom.atomId, name: atom.name }), encoding: 'utf8', timeout: 10_000,
    }))).toEqual(expected);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Poll until the spawned server answers, so a slow boot is not a failure. */
async function waitForJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no response from ${url}`);
}

describe('folding the per-owner partition back into the platform', () => {
  it('absorbs same-name project rows with their trust, keeps the others whole, backs the file up once', () => {
    const root = directory(); const path = join(root, 'store.db');
    const operatorWater = randomUUID(); const projectWater = randomUUID(); const otherWater = randomUUID();
    const projectBranch = randomUUID(); const projectTracheid = randomUUID();
    const projectA = `project:${randomUUID()}:${randomUUID()}`; const projectB = `project:${randomUUID()}:${randomUUID()}`;
    const legacy = partitionedStore(path, [
      { owner: 'operator', tier: 1, ordinal: 1, atomId: operatorWater, name: 'Water', successes: 4, failures: 1 },
      // Same name as the platform row: absorbed, counters added, history left to the backup.
      { owner: projectA, tier: 1, ordinal: 1, atomId: projectWater, name: 'Water', prompt: 'Project A coaching', successes: 2, failures: 0, at: '2026-09-11' },
      { owner: projectB, tier: 1, ordinal: 1, atomId: otherWater, name: 'Water', successes: 1, failures: 3, at: '2026-09-12' },
      // A branch only project A has: joins whole; its ordinal 2 is free, so it keeps it.
      { owner: projectA, tier: 1, ordinal: 2, atomId: projectBranch, name: 'Water-Reader', prompt: 'Branch prompt', successes: 5, at: '2026-09-11' },
      // A tier-2 type only project B has, on an ordinal the operator's tier-2 history already used.
      { owner: 'operator', tier: 2, ordinal: 1, name: 'Tracheid', successes: 3 },
      { owner: projectB, tier: 2, ordinal: 1, atomId: projectTracheid, name: 'Sclereid', successes: 1, at: '2026-09-12' },
    ]);
    const original = legacy.prepare('SELECT * FROM atom_types ORDER BY owner_key, tier, ordinal').all();
    const history = legacy.prepare('SELECT * FROM atom_type_versions ORDER BY owner_key, tier, ordinal, version').all();
    expect(registryIsPartitioned(legacy)).toBe(true);
    legacy.close();

    const db = openDb(path);
    try {
      expect(registryIsPartitioned(db)).toBe(false);
      const registry = new AtomRegistry(db);
      const water = registry.getByName('Water')!;
      expect(water.consecutiveSuccesses).toBe(0);
      expect(water).toMatchObject({ atomId: operatorWater, tier: 1, ordinal: 1, successes: 7, failures: 4, systemPrompt: 'Water prompt' });
      expect(registry.getByAtomId(projectWater)).toBeNull();
      expect(registry.getByName('Water-Reader')).toMatchObject({ atomId: projectBranch, ordinal: 2, successes: 5, systemPrompt: 'Branch prompt' });
      expect(registry.listVersions('Water-Reader')).toEqual([expect.objectContaining({ version: 1, systemPrompt: 'Water-Reader old prompt' })]);
      // Ordinal 1 of tier 2 is the operator's: Sclereid takes the next free one.
      expect(registry.getByName('Sclereid')).toMatchObject({ atomId: projectTracheid, tier: 2, ordinal: 2, successes: 1 });
      expect(registry.getByName('Tracheid')).toMatchObject({ ordinal: 1, successes: 3 });
      expect(registry.getByName('Tracheid')?.consecutiveSuccesses).toBe(3);
      expect(registry.listByTier(1).map((row) => row.name)).toEqual(['Water', 'Water-Reader']);
      expect(db.prepare('SELECT absorbed_atom_id, kept_atom_id, absorbed_name, absorbed_owner FROM atom_id_merges ORDER BY absorbed_owner').all())
        .toEqual([
          { absorbed_atom_id: projectWater, kept_atom_id: operatorWater, absorbed_name: 'Water', absorbed_owner: projectA },
          { absorbed_atom_id: otherWater, kept_atom_id: operatorWater, absorbed_name: 'Water', absorbed_owner: projectB },
        ].sort((a, b) => a.absorbed_owner.localeCompare(b.absorbed_owner)));
      expect(db.prepare('SELECT * FROM unrelated_evidence').all()).toEqual([{ value: 'keep exactly' }]);
      // Absorbed rows' history is not carried: the kept row's history is its own.
      expect(db.prepare('SELECT COUNT(*) AS n FROM atom_type_versions WHERE tier = 1 AND ordinal = 1').pluck().get()).toBe(1);
      // Everything the fold displaced is in the backup, byte for byte.
      const backups = readdirSync(root).filter((file) => file.includes('.before-platform-registry-'));
      expect(backups).toHaveLength(1);
      if (process.platform !== 'win32') expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600);
      const backup = new Database(join(root, backups[0]!), { readonly: true });
      expect(backup.prepare('SELECT * FROM atom_types ORDER BY owner_key, tier, ordinal').all()).toEqual(original);
      expect(backup.prepare('SELECT * FROM atom_type_versions ORDER BY owner_key, tier, ordinal, version').all()).toEqual(history);
      backup.close();
      // Idempotent: a second open neither folds nor backs up again.
      openDb(path).close();
      expect(readdirSync(root).filter((file) => file.includes('.before-platform-registry-'))).toEqual(backups);
      // And the platform row keeps earning from here, whoever runs.
      registry.recordSuccess('Water');
      expect(registry.getByName('Water')?.successes).toBe(8);
    } finally { db.close(); }
  });

  it('suffixes a project name another tier already holds instead of failing the fold', () => {
    const path = join(directory(), 'store.db');
    partitionedStore(path, [
      { owner: 'operator', tier: 1, ordinal: 1, name: 'Water' },
      { owner: `project:${randomUUID()}:${randomUUID()}`, tier: 2, ordinal: 1, name: 'Water', successes: 2 },
    ]).close();
    const db = openDb(path);
    try {
      const registry = new AtomRegistry(db);
      expect(registry.getByName('Water')).toMatchObject({ tier: 1 });
      expect(registry.getByName('Water-2')).toMatchObject({ tier: 2, ordinal: 1, successes: 2 });
    } finally { db.close(); }
  });

  it('leaves a store it cannot fold untouched, beside its backup', () => {
    const root = directory(); const path = join(root, 'store.db');
    const legacy = partitionedStore(path, [{ owner: 'operator', tier: 1, ordinal: 1, name: 'Water' }]);
    // A row the platform schema refuses (its tier CHECK) fails the fold mid-way.
    legacy.prepare(`INSERT INTO atom_types(owner_key,tier,ordinal,atom_id,name,description,system_prompt,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(`project:${randomUUID()}:${randomUUID()}`, 4, 1, randomUUID(), 'Methane', 'd', 'p', 'project', '2026-09-11');
    const original = legacy.prepare('SELECT * FROM atom_types ORDER BY owner_key').all();
    expect(() => openDb(path)).toThrow();
    expect(legacy.prepare('SELECT * FROM atom_types ORDER BY owner_key').all()).toEqual(original);
    expect(registryIsPartitioned(legacy)).toBe(true);
    expect(readdirSync(root).filter((file) => file.includes('.before-platform-registry-'))).toHaveLength(1);
    legacy.close();
  });

  it('folds the store the VIZ SERVER serves, at startup, before anything reads it', async () => {
    // THE PRODUCTION FAILURE, 2026-09-15. Every store access in the server is
    // a READ-ONLY handle, and only `openDb` folds — so on a deployed host the
    // fold waited for a run that never came, while the readers, which no
    // longer filter by owner, published one row per owner. The live Registry
    // listed 23 agents for a 12-agent catalogue. This crosses the same process
    // boundary the bug did: a real server, spawned on a partitioned store.
    const root = directory();
    const path = join(root, 'atoma.db');
    const project = `project:${randomUUID()}:${randomUUID()}`;
    partitionedStore(path, [
      { owner: 'operator', tier: 1, ordinal: 1, name: 'Water', successes: 1, failures: 2 },
      { owner: project, tier: 1, ordinal: 1, name: 'Water', prompt: 'Project coaching', successes: 4, at: '2026-09-11' },
    ]).close();
    mkdirSync(join(root, 'runs'), { recursive: true });

    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', String(port),
        '--dir', join(root, 'runs'), '--db', path, '--skills-dir', join(root, 'skills'), '--no-sentinel'],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      const payload = await waitForJson(`http://127.0.0.1:${port}/api/registry/atoma`) as {
        registry: { counts: Record<string, number> };
        types: Array<{ name: string; successes: number; failures: number }>;
      };
      // ONE Water, carrying both owners' trust — not one row per owner.
      expect(payload.types.map((type) => type.name)).toEqual(['Water']);
      expect(payload.types[0]).toMatchObject({ successes: 5, failures: 2 });
      expect(payload.registry.counts).toMatchObject({ 1: 1, total: 1 });
    } finally {
      child.kill('SIGKILL');
    }

    // And the store on disk is genuinely folded, not merely filtered on read.
    const db = new Database(path, { readonly: true });
    try {
      expect(registryIsPartitioned(db)).toBe(false);
      expect(db.prepare('SELECT COUNT(*) FROM atom_types').pluck().get()).toBe(1);
      expect(db.prepare('SELECT absorbed_owner FROM atom_id_merges').pluck().all()).toEqual([project]);
    } finally { db.close(); }
  }, 60_000);

  it('opens a pre-partition store as it is: the platform schema is its schema', () => {
    const root = directory(); const path = join(root, 'store.db');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE atom_types (
      tier INTEGER NOT NULL, ordinal INTEGER NOT NULL, atom_id TEXT NOT NULL, name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL, system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL DEFAULT '[]',
      params_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(tier, ordinal));
    CREATE TABLE atom_type_versions (tier INTEGER NOT NULL, ordinal INTEGER NOT NULL, version INTEGER NOT NULL,
      system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL, params_json TEXT NOT NULL,
      modified_by TEXT NOT NULL, modified_at TEXT NOT NULL, reason TEXT, PRIMARY KEY(tier, ordinal, version));`);
    legacy.prepare(`INSERT INTO atom_types(tier,ordinal,atom_id,name,description,system_prompt,created_by,created_at,version,successes)
      VALUES(1,1,?,'Water','d','p','legacy','2026-09-08',2,4)`).run(randomUUID());
    legacy.close();
    const db = openDb(path);
    try {
      expect(new AtomRegistry(db).getByName('Water')).toMatchObject({ successes: 4, version: 2 });
    } finally { db.close(); }
    expect(readdirSync(root).filter((file) => file.includes('before-'))).toEqual([]);
  });

  it('serves a merged identity\'s historical skill URLs through the kept namespace', async () => {
    // THE PRODUCTION FAILURE, 2026-09-18. The fold absorbs a project atom,
    // reconcilePlatformSkills moves its recipes under the kept identity, and
    // every trace and bookmark still carrying the absorbed id answered
    // /api/skills/<absorbed>/<skill> with 404 —
    // 5412001e-43f6-439c-b6ce-95bd4f41c21b/recover-missing-live-browser-proof
    // on atoma.run. Traces stay byte-honest, so the typed viz boundary must
    // resolve the alias. The merge is seeded two hops deep (absorbed → mid →
    // kept) to hold the chain-follow, not just the single rename.
    const root = directory();
    const path = join(root, 'atoma.db');
    const db = openDb(path);
    let keptId = '';
    try {
      const registry = new AtomRegistry(db);
      keptId = registry.create(1, seed).atomId;
      const absorbed = '5412001e-43f6-439c-b6ce-95bd4f41c21b';
      const mid = randomUUID();
      const merge = db.prepare(`INSERT INTO atom_id_merges (absorbed_atom_id, kept_atom_id, absorbed_name, absorbed_owner, merged_at)
        VALUES (?, ?, 'Water', ?, ?)`);
      merge.run(absorbed, mid, `project:${randomUUID()}:${randomUUID()}`, '2026-09-15T18:00:00.000Z');
      merge.run(mid, keptId, `project:${randomUUID()}:${randomUUID()}`, '2026-09-16T18:00:00.000Z');
    } finally { db.close(); }
    // The post-fold catalog: the recipe lives under the KEPT identity, nothing
    // remains under the absorbed one (foldMergedNamespaces set it aside).
    const skillId = 'recover-missing-live-browser-proof';
    new SkillRegistry(join(root, 'skills')).save(keptId, {
      id: skillId,
      description: 'Restore browser proof',
      whenToUse: 'When live browser proof is missing',
      kind: 'llm',
      body: 'Inspect the browser probe result and re-run the browser phase.',
    });
    mkdirSync(join(root, 'runs'), { recursive: true });

    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', String(port),
        '--dir', join(root, 'runs'), '--db', path, '--skills-dir', join(root, 'skills'), '--no-sentinel'],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForJson(`http://127.0.0.1:${port}/api/registry/atoma`);
      // The historical URL resolves through both hops to the kept namespace.
      const detail = await fetch(`http://127.0.0.1:${port}/api/skills/5412001e-43f6-439c-b6ce-95bd4f41c21b/${skillId}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: skillId, body: 'Inspect the browser probe result and re-run the browser phase.' });
      const list = await fetch(`http://127.0.0.1:${port}/api/skills/5412001e-43f6-439c-b6ce-95bd4f41c21b`);
      expect(await list.json()).toEqual([expect.objectContaining({ id: skillId })]);
      // An identity with no folder and no merge row keeps its ordinary 404.
      const missing = await fetch(`http://127.0.0.1:${port}/api/skills/${randomUUID()}/no-such-recipe`);
      expect(missing.status).toBe(404);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});
