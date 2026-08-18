import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { isAtomId, newAtomId } from '../src/core/atomId.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';

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

  it('carries the registry identity onto the atom, unchanged, at every tier', () => {
    // The property that matters for the layers still to be migrated: an atom
    // rehydrated from a persisted type is filed under the SAME identity its
    // skills and counters are. The constructor argument is optional, so this
    // is what stands in for the compiler enforcing it.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, seed);
    const l2Type = reg.create(2, seed);
    const l3Type = reg.create(3, seed);

    expect(L1Atom.fromType(l1Type).atomId).toBe(l1Type.atomId);
    expect(L2Atom.fromType(l2Type, reg).atomId).toBe(l2Type.atomId);
    expect(L3Atom.buildWithModel(l3Type, reg).atomId).toBe(l3Type.atomId);
  });

  it('gives an ad-hoc atom its own identity rather than an empty one', () => {
    // No registry row means no persistent identity to preserve, so a fresh
    // id is correct — but it must still BE an id, because the namespace and
    // ledger work will use it as a key without asking where it came from.
    const atom = new L1Atom({
      name: 'Water',
      ordinal: 1,
      systemPrompt: 'sys',
      tools: [],
      params: {},
    });
    expect(isAtomId(atom.atomId)).toBe(true);
  });

  it('resolves a type back from its id, so a key can become a label again', () => {
    // Without this there is no way back from an identity to a display name,
    // and every operator surface that renders a namespace would print a UUID
    // after the flip.
    const reg = new AtomRegistry(openDb(':memory:'));
    const created = reg.create(1, seed);
    const found = reg.getByAtomId(created.atomId);
    expect(found).not.toBeNull();
    expect(found!.name).toBe(created.name);
    expect(found!.atomId).toBe(created.atomId);
  });

  it('returns null for an unknown or empty id instead of throwing', () => {
    // Operator surfaces call this to turn a key into a label; a removed atom
    // or a mid-migration row must degrade to "show the raw key", never to a
    // crashed CLI table or viz panel.
    const reg = new AtomRegistry(openDb(':memory:'));
    const created = reg.create(1, seed);
    reg.remove(created.name);
    expect(reg.getByAtomId(created.atomId)).toBeNull();
    expect(reg.getByAtomId('')).toBeNull();
    expect(reg.getByAtomId(newAtomId())).toBeNull();
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
