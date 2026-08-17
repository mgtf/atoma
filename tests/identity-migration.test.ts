import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { appendLedger, projectCounters, readLedger } from '../src/core/ledger.js';
import {
  applyIdentityMigration,
  identityVersion,
  IDENTITY_VERSION,
  planIdentityMigration,
} from '../src/registry/identityMigration.js';

/**
 * Skill namespaces move from the atom NAME to its surrogate id (T4).
 *
 * The design property under test is CONVERGENCE rather than rollback: both
 * halves are idempotent and the version stamp is written last, so an
 * interruption anywhere leaves a store that re-runs cleanly. Each interruption
 * window gets its own test, because that is precisely what the pre-existing
 * taxonomy harness does not survive.
 */

const seed = {
  description: 'builder',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

function makeStore(): {
  dir: string;
  dbPath: string;
  skillsDir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-identity-'));
  const skillsDir = join(dir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return {
    dir,
    dbPath: join(dir, 'store.db'),
    skillsDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedSkill(skillsDir: string, ns: string, id: string): void {
  const d = join(skillsDir, ns, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nid: ${id}\n---\nbody\n`);
  writeFileSync(join(d, '_meta.json'), JSON.stringify({ successes: 3, failures: 0 }));
}

describe('identity migration — name-keyed namespaces become id-keyed', () => {
  it('moves each namespace onto its atom id and rewrites the ledger prefix', () => {
    const s = makeStore();
    try {
      const db = openDb(s.dbPath);
      const reg = new AtomRegistry(db);
      const water = reg.create(1, seed);
      seedSkill(s.skillsDir, water.name, 'build-widget');
      appendLedger({ kind: 'skill-success', entity: `${water.name}/build-widget` }, db);
      appendLedger({ kind: 'skill-success', entity: `${water.name}/build-widget` }, db);
      // An ATOM entity must be left alone: it is the display label and
      // `ledger check` projects type counters against it.
      appendLedger({ kind: 'type-success', entity: water.name }, db);
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('identity_version');

      const plan = planIdentityMigration(db, s.skillsDir);
      expect(plan.alreadyCurrent).toBe(false);
      expect(plan.namespaceMoves).toHaveLength(1);
      expect(plan.ledgerRows).toBe(2);

      const result = applyIdentityMigration(db, s.skillsDir, plan);
      expect(result.movedNamespaces).toBe(1);
      expect(result.rewrittenLedgerRows).toBe(2);

      expect(existsSync(join(s.skillsDir, water.atomId, 'build-widget', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(s.skillsDir, water.name))).toBe(false);

      const entities = readLedger(db).map((e) => e.entity);
      expect(entities).toContain(`${water.atomId}/build-widget`);
      expect(entities).toContain(water.name); // the type event, untouched
      expect(identityVersion(db)).toBe(IDENTITY_VERSION);
      db.close();
    } finally {
      s.cleanup();
    }
  });

  it('keeps counter projection intact — no skill reads as drift afterwards', () => {
    // The failure this guards: leaving history keyed by name while the store
    // moves to ids makes every skill's projection compare against a key that
    // no longer exists, and `ledger check` reports the lot as IMPOSSIBLE.
    const s = makeStore();
    try {
      const db = openDb(s.dbPath);
      const reg = new AtomRegistry(db);
      const water = reg.create(1, seed);
      seedSkill(s.skillsDir, water.name, 'build-widget');
      for (let i = 0; i < 3; i++) {
        appendLedger({ kind: 'skill-success', entity: `${water.name}/build-widget` }, db);
      }
      appendLedger({ kind: 'skill-failure', entity: `${water.name}/build-widget` }, db);
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('identity_version');

      applyIdentityMigration(db, s.skillsDir, planIdentityMigration(db, s.skillsDir));

      const projected = projectCounters(readLedger(db));
      const after = projected.get(`${water.atomId}/build-widget`);
      expect(after).toEqual({ successes: 3, failures: 1 });
      expect(projected.has(`${water.name}/build-widget`)).toBe(false);
      db.close();
    } finally {
      s.cleanup();
    }
  });

  it('is idempotent: a second apply is a no-op', () => {
    const s = makeStore();
    try {
      const db = openDb(s.dbPath);
      const reg = new AtomRegistry(db);
      const water = reg.create(1, seed);
      seedSkill(s.skillsDir, water.name, 'build-widget');
      appendLedger({ kind: 'skill-success', entity: `${water.name}/build-widget` }, db);
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('identity_version');

      applyIdentityMigration(db, s.skillsDir, planIdentityMigration(db, s.skillsDir));
      const second = planIdentityMigration(db, s.skillsDir);
      expect(second.alreadyCurrent).toBe(true);
      expect(applyIdentityMigration(db, s.skillsDir, second)).toEqual({
        movedNamespaces: 0,
        rewrittenLedgerRows: 0,
      });
      db.close();
    } finally {
      s.cleanup();
    }
  });

  it('converges after an interruption BETWEEN the move and the stamp', () => {
    // The window the taxonomy harness corrupts: filesystem done, DB not. A
    // re-plan must see the already-moved directory as a non-source and still
    // finish the ledger half.
    const s = makeStore();
    try {
      const db = openDb(s.dbPath);
      const reg = new AtomRegistry(db);
      const water = reg.create(1, seed);
      seedSkill(s.skillsDir, water.name, 'build-widget');
      appendLedger({ kind: 'skill-success', entity: `${water.name}/build-widget` }, db);
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('identity_version');

      // Simulate: the rename happened, then the process died before the stamp.
      const plan = planIdentityMigration(db, s.skillsDir);
      const move = plan.namespaceMoves[0]!;
      renameSync(move.fromPath, move.toPath);

      const replanned = planIdentityMigration(db, s.skillsDir);
      expect(replanned.alreadyCurrent).toBe(false);
      expect(replanned.namespaceMoves).toHaveLength(0); // already moved
      // …but the ledger half is still outstanding, and it is planned off the
      // atom table rather than off the moves, so it still happens. Deriving it
      // from the filesystem stamped the store here with history unconverted.
      expect(replanned.ledgerRenames.length).toBeGreaterThan(0);

      const result = applyIdentityMigration(db, s.skillsDir, replanned);
      expect(result.movedNamespaces).toBe(0);
      expect(result.rewrittenLedgerRows).toBe(1);
      expect(identityVersion(db)).toBe(IDENTITY_VERSION);
      expect(readLedger(db).map((e) => e.entity)).toContain(`${water.atomId}/build-widget`);
      db.close();
    } finally {
      s.cleanup();
    }
  });

  it('leaves a namespace whose atom is gone strictly alone', () => {
    const s = makeStore();
    try {
      const db = openDb(s.dbPath);
      const reg = new AtomRegistry(db);
      const water = reg.create(1, seed);
      seedSkill(s.skillsDir, water.name, 'build-widget');
      seedSkill(s.skillsDir, 'Ghost', 'orphan-recipe');
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('identity_version');

      const plan = planIdentityMigration(db, s.skillsDir);
      expect(plan.unmatchedNamespaces).toEqual(['Ghost']);
      applyIdentityMigration(db, s.skillsDir, plan);
      expect(existsSync(join(s.skillsDir, 'Ghost', 'orphan-recipe', 'SKILL.md'))).toBe(true);
      db.close();
    } finally {
      s.cleanup();
    }
  });

  it('refuses to merge two namespaces if the target already exists', () => {
    const s = makeStore();
    try {
      const db = openDb(s.dbPath);
      const reg = new AtomRegistry(db);
      const water = reg.create(1, seed);
      seedSkill(s.skillsDir, water.name, 'build-widget');
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('identity_version');
      const plan = planIdentityMigration(db, s.skillsDir);
      // A half-finished earlier run left the target in place.
      mkdirSync(join(s.skillsDir, water.atomId), { recursive: true });

      expect(() => applyIdentityMigration(db, s.skillsDir, plan)).toThrow(/refusing to merge/);
      db.close();
    } finally {
      s.cleanup();
    }
  });
});
