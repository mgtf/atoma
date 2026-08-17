import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { isAtomId, newAtomId } from '../src/registry/atomId.js';

/**
 * Surrogate atom identity — invariant T4 in docs/saas-architecture.md.
 *
 * A taxonomy name has been doing triple duty (display label, identity,
 * filesystem namespace) and that coupling produced two confirmed defects. The
 * id introduced here is what lets the three be separated; these tests pin the
 * properties the later namespace and ledger work will rely on.
 */

const seed = {
  description: 'orchestrator',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'SomeParent',
};

describe('atom identity — a surrogate that never collides and never returns', () => {
  it('assigns a well-formed, unique id at creation', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed);
    const b = reg.create(1, seed);
    expect(isAtomId(a.atomId)).toBe(true);
    expect(isAtomId(b.atomId)).toBe(true);
    expect(a.atomId).not.toBe(b.atomId);
  });

  it('keeps the id stable across patch and rollback — identity is not content', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const created = reg.create(1, seed);
    reg.patch(created.name, { systemPromptAppend: 'v2' }, 'test');
    const patched = reg.getByName(created.name)!;
    expect(patched.version).toBe(2);
    expect(patched.atomId).toBe(created.atomId);

    reg.rollback(created.name, 1);
    expect(reg.getByName(created.name)!.atomId).toBe(created.atomId);
  });

  it('gives a branch its OWN identity rather than the source\'s', () => {
    // Trust, skills and ledger attribution will all key on this id. A branch
    // inheriting it would silently transfer the parent's earned state to a
    // derived atom.
    const reg = new AtomRegistry(openDb(':memory:'));
    const source = reg.create(1, seed);
    const branched = reg.branch(source.name, {}, 'test');
    expect(branched.atomId).not.toBe(source.atomId);
    expect(isAtomId(branched.atomId)).toBe(true);
  });

  it('never reissues the identity of a removed type', () => {
    // The name-based version of this was a confirmed defect: a post-remove
    // branch reissued a dead taxonomy name and inherited its skill directory
    // (§4.3). Ordinals are now allocated over live ∪ history, and the id adds
    // the guarantee at the identity layer rather than the allocator's.
    const reg = new AtomRegistry(openDb(':memory:'));
    const first = reg.create(1, seed);
    const secondBefore = reg.create(1, seed);
    reg.remove(first.name);
    const rebranched = reg.branch(secondBefore.name, {}, 'test');
    expect(rebranched.atomId).not.toBe(first.atomId);
    expect(rebranched.atomId).not.toBe(secondBefore.atomId);
  });

  it('back-fills a pre-migration store on open, with a distinct id per row', () => {
    // Exercises the production path: openDb is what migrates, so the test
    // reopens a real file rather than calling the backfill directly.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-atom-id-'));
    const path = join(dir, 'store.db');
    try {
      const first = openDb(path);
      const reg = new AtomRegistry(first);
      reg.create(1, seed);
      reg.create(1, seed);
      reg.create(2, seed);
      // Simulate a store written before the column existed.
      first.exec('UPDATE atom_types SET atom_id = NULL');
      expect(
        (first.prepare('SELECT COUNT(*) AS n FROM atom_types WHERE atom_id IS NULL').get() as {
          n: number;
        }).n
      ).toBe(3);
      first.close();

      const reopened = openDb(path);
      const ids = (
        reopened.prepare('SELECT atom_id FROM atom_types').all() as { atom_id: string | null }[]
      ).map((r) => r.atom_id);
      expect(ids).toHaveLength(3);
      expect(ids.every((id) => id !== null && isAtomId(id))).toBe(true);
      expect(new Set(ids).size).toBe(3);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates only path-safe ids (T5: no component ever traverses)', () => {
    // The id will become a filesystem namespace, so its shape is the whole
    // safety argument — it must not be able to express a separator or a dot
    // run, unlike the LLM-authored names it replaces there.
    for (let i = 0; i < 200; i++) {
      const id = newAtomId();
      expect(isAtomId(id)).toBe(true);
      expect(id).not.toMatch(/[/\\]/);
      expect(id).not.toMatch(/\.\./);
    }
    for (const hostile of ['..', '.', '../x', 'a/b', '', 'Water']) {
      expect(isAtomId(hostile)).toBe(false);
    }
  });
});
