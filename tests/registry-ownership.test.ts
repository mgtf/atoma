import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import type { RegistryOwner } from '../src/contracts/registryOwner.js';

const seed = { description: 'Private price is 731 euros', systemPrompt: 'Private routing guidance',
  tools: [{ name: 'read_file', description: 'Private tool description', inputSchema: { type: 'object', properties: {} } }],
  params: { temperature: 0 }, createdBy: 'private-provenance' };
const owner = (orgId: string = randomUUID()): RegistryOwner => ({ kind: 'project', orgId, projectId: randomUUID() });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), 'atoma-registry-owner-')); roots.push(root); return root; }

// The historical schema, deliberately frozen rather than derived from the migration.
const LEGACY = `CREATE TABLE atom_types (
  tier INTEGER NOT NULL, ordinal INTEGER NOT NULL, atom_id TEXT NOT NULL, name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL, system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL DEFAULT '[]',
  params_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tier, ordinal));
CREATE TABLE atom_type_versions (tier INTEGER NOT NULL, ordinal INTEGER NOT NULL, version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL, tools_json TEXT NOT NULL, params_json TEXT NOT NULL,
  modified_by TEXT NOT NULL, modified_at TEXT NOT NULL, reason TEXT, PRIMARY KEY(tier, ordinal, version));`;

function legacyStore(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); db.exec(LEGACY);
  db.prepare(`INSERT INTO atom_types(tier,ordinal,atom_id,name,description,system_prompt,created_by,created_at,version,successes)
    VALUES(1,1,?,'Water',?,?,?, ?,2,4)`).run(randomUUID(), seed.description, seed.systemPrompt, seed.createdBy, '2026-09-08');
  db.prepare(`INSERT INTO atom_type_versions VALUES(1,1,1,?,'[]','{}','validator','2026-09-08','private reason')`).run('private old prompt');
  db.exec("CREATE TABLE unrelated_evidence(value TEXT); INSERT INTO unrelated_evidence VALUES('keep exactly');");
  return db;
}

describe('project-owned registry', () => {
  it.each([1, 2, 3] as const)('isolates tier %s identities, all mutation paths, tombstones and trust with colliding labels', tier => {
    const db = openDb(':memory:');
    try {
      const firstOwner = owner();
      const scopes = [firstOwner, owner(firstOwner.kind === 'project' ? firstOwner.orgId : undefined), owner(), { kind: 'operator' } as const];
      const registries = scopes.map(scope => new AtomRegistry(db, scope));
      const originals = registries.map(registry => registry.create(tier, seed));
      expect(new Set(originals.map(type => type.name)).size).toBe(1);
      expect(new Set(originals.map(type => type.atomId)).size).toBe(4);
      const a = registries[0]!; const target = originals[0]!;
      a.recordSuccess(target.name); a.recordSuccess(target.name); a.recordFailure(target.name);
      a.compensateCounters(target.name, { successes: -1, reason: 'correct private observation' });
      expect(projectCounters(readLedger(db)).get(target.atomId)).toEqual({ successes: 1, failures: 1 });
      a.patch(target.name, { systemPromptReplace: 'changed private prompt', addTools: [{ ...seed.tools[0]!, name: 'private_tool' }] }, 'private validator', 'private reason');
      expect(a.listVersions(target.name)[0]?.systemPrompt).toBe(seed.systemPrompt);
      expect(a.rollback(target.name, 1).systemPrompt).toBe(seed.systemPrompt);
      const branch = a.branch(target.name, {}, 'private parent', 'Private-731');
      a.recordSuccess(branch.name);
      a.mergeInto(target.name, [branch.name]);
      expect(a.getByName(target.name)?.successes).toBe(1);
      expect(projectCounters(readLedger(db)).get(target.atomId)).toEqual({ successes: 1, failures: 0 });
      a.remove(target.name);
      const next = a.create(tier, seed);
      expect(next.ordinal).toBeGreaterThan(target.ordinal);
      for (const [index, other] of registries.entries()) {
        if (index === 0) continue;
        expect(other.listByTier(tier)).toEqual([originals[index]]);
        expect(other.getByAtomId(target.atomId)).toBeNull();
        expect(other.getByTierOrdinal(tier, target.ordinal)).toEqual(originals[index]);
        expect(other.listVersions(target.name)).toEqual([]);
        expect(other.versionsOf(target.name)).toEqual([]);
        expect(other.getByName('Private-731')).toBeNull();
        expect(() => other.patch('Private-731', {}, 'foreign')).toThrow();
      }
    } finally { db.close(); }
  });

  it('retains project identities, full metadata, version history and trust in a fresh process', () => {
    const dbPath = join(directory(), 'store.db');
    const db = openDb(dbPath); const scope = owner();
    const registry = new AtomRegistry(db, scope);
    const atom = registry.create(2, seed);
    registry.patch(atom.name, { systemPromptAppend: 'Private fact 731' }, 'owner', 'private reason');
    registry.recordSuccess(atom.name);
    const expected = { type: registry.getByAtomId(atom.atomId), history: registry.listVersions(atom.name) };
    db.close();
    const source = String.raw`import { readFileSync } from 'node:fs';
      import { AtomRegistry } from './src/registry/atomRegistry.ts'; import { openDb } from './src/registry/db.ts';
      const {dbPath,scope,id,name}=JSON.parse(readFileSync(0,'utf8')); const db=openDb(dbPath);
      const r=new AtomRegistry(db,scope); process.stdout.write(JSON.stringify({type:r.getByAtomId(id),history:r.listVersions(name)})); db.close();`;
    expect(JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      input: JSON.stringify({ dbPath, scope, id: atom.atomId, name: atom.name }), encoding: 'utf8', timeout: 10_000,
    }))).toEqual(expected);
  });

  it('refuses reads and writes when the host revokes the registry grant', () => {
    const db = openDb(':memory:'); let allowed = true;
    const registry = new AtomRegistry(db, owner(), () => allowed);
    const atom = registry.create(1, seed); allowed = false;
    for (const operation of [() => registry.listByTier(1), () => registry.getByAtomId(atom.atomId),
      () => registry.patch(atom.name, { systemPromptAppend: 'x' }, 'validator'), () => registry.create(2, seed),
      () => registry.recordSuccess(atom.name), () => registry.listVersions(atom.name)]) expect(operation).toThrow('access denied');
    db.close();
  });
});

describe('legacy ownership migration', () => {
  it('backs up the whole WAL store, preserves old IDs/history/counters and never imports legacy content into projects', () => {
    const root = directory(); const path = join(root, 'store.db');
    const legacy = legacyStore(path);
    const original = legacy.prepare('SELECT * FROM atom_types').all();
    const history = legacy.prepare('SELECT * FROM atom_type_versions').all();
    const legacyReader = new AtomRegistry(legacy);
    expect(legacyReader.listByTier(1)[0]?.systemPrompt).toBe(seed.systemPrompt);
    expect(new AtomRegistry(legacy).listVersions('Water')[0]?.systemPrompt).toBe('private old prompt');
    const migrated = openDb(path);
    try {
      const row = migrated.prepare('SELECT * FROM atom_types').get() as Record<string, unknown>;
      const { owner_key, ...unchanged } = row;
      expect(() => legacyReader.listByTier(1)).toThrow('schema changed');
      expect(owner_key).toBe('operator'); expect([unchanged]).toEqual(original);
      expect(new AtomRegistry(migrated, owner()).listByTier(1)).toEqual([]);
      expect(new AtomRegistry(migrated).listByTier(1)[0]?.successes).toBe(4);
      const backups = readdirSync(root).filter(file => file.includes('.before-registry-ownership-'));
      expect(backups).toHaveLength(1);
      expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600);
      const backup = new Database(join(root, backups[0]!), { readonly: true });
      expect(backup.prepare('SELECT * FROM atom_types').all()).toEqual(original);
      expect(backup.prepare('SELECT * FROM atom_type_versions').all()).toEqual(history);
      expect(backup.prepare('SELECT * FROM unrelated_evidence').all()).toEqual([{ value: 'keep exactly' }]); backup.close();
      openDb(path).close();
      expect(readdirSync(root).filter(file => file.includes('.before-registry-ownership-'))).toEqual(backups);
    } finally { migrated.close(); legacy.close(); }
  });

  it('rolls the entire schema back on an incompatible old store and retains the backup', () => {
    const root = directory(); const path = join(root, 'store.db'); const legacy = legacyStore(path);
    legacy.exec(`INSERT INTO atom_types SELECT tier,2,atom_id,'Methane',description,system_prompt,tools_json,params_json,
      created_by,created_at,version,successes,failures FROM atom_types`); // corrupt duplicate surrogate ID
    const original = legacy.prepare('SELECT * FROM atom_types').all();
    expect(() => openDb(path)).toThrow();
    expect(legacy.prepare('SELECT * FROM atom_types').all()).toEqual(original);
    expect(legacy.prepare('PRAGMA table_info(atom_types)').all()).not.toContainEqual(expect.objectContaining({ name: 'owner_key' }));
    expect(readdirSync(root).filter(file => file.includes('.before-registry-ownership-'))).toHaveLength(1);
    legacy.close();
  });
});
