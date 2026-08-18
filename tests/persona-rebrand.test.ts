import { describe, it, expect } from 'vitest';
import {
  AtomRegistry,
  rebrandPersona,
} from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

/**
 * Regression tests for the persona rebrand feature.
 *
 * Background: Sonnet, when authoring a seed system prompt for a brand new
 * L1 worker, hardcoded "You are Carbon, an L1 element…" as the opening
 * line. That string then rode the `branch` path into every descendant,
 * so the registry ended up with Aluminum, Silicon, Phosphorus, Fluorine
 * all introducing themselves as Carbon. The rebrand logic fires at
 * create/branch time to align the "You are …" line with the atom's
 * taxonomy name (Aluminum → "You are Aluminum, …"), and the CLI
 * `registry rebrand` exposes the same rewrite for existing atoms.
 */

const seed = {
  description: 'd',
  systemPrompt: '',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('rebrandPersona (pure helper)', () => {
  it('rewrites a leading capitalized persona reference', () => {
    expect(rebrandPersona('You are Carbon, an L1 molecule.', 'Phosphorus')).toBe(
      'You are Phosphorus, an L1 molecule.'
    );
  });

  it('rewrites a multi-word CamelCase persona too', () => {
    expect(
      rebrandPersona('You are WebGLMinesweeper, a tier-1 executor.', 'Neon')
    ).toBe('You are Neon, a tier-1 executor.');
  });

  it('leaves English articles alone ("You are a focused worker")', () => {
    // Lowercase "a" is not a proper noun — must not be rewritten.
    expect(
      rebrandPersona('You are a focused L1 molecule worker.', 'Helium')
    ).toBe('You are a focused L1 molecule worker.');
  });

  it('is a no-op when the persona already matches the name', () => {
    expect(rebrandPersona('You are Neon, blah.', 'Neon')).toBe(
      'You are Neon, blah.'
    );
  });

  it('is a no-op when the prompt does not start with "You are …"', () => {
    expect(rebrandPersona('A focused L1 molecule worker.', 'X')).toBe(
      'A focused L1 molecule worker.'
    );
    expect(rebrandPersona('', 'X')).toBe('');
  });

  it('only touches the FIRST persona line — later "You are" occurrences stay put', () => {
    // Later mentions may refer to the USER ("You are talking to a human"),
    // not the atom. We only align the identity assertion at the top.
    const text = 'You are Carbon, an L1 molecule.\n\nWhen You are done, stop.';
    expect(rebrandPersona(text, 'Neon')).toBe(
      'You are Neon, an L1 molecule.\n\nWhen You are done, stop.'
    );
  });

  it('preserves the rest of the prompt verbatim', () => {
    const long =
      'You are Carbon, an L1 molecule. Your job is to build X.\n' +
      '1. Step one.\n' +
      '2. Step two with "quoted" and {brace} chars.\n' +
      '3. Return JSON {"output":..., "summary":"..."}';
    const out = rebrandPersona(long, 'Aluminum');
    expect(out.startsWith('You are Aluminum, an L1 molecule.')).toBe(true);
    // Everything after the identity line is untouched.
    expect(out.slice('You are Aluminum'.length)).toBe(
      long.slice('You are Carbon'.length)
    );
  });
});

describe('AtomRegistry.create — auto-rebrand on new seeds', () => {
  it('rewrites the seed persona to match the auto-assigned taxonomy name', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const t = reg.create(1, {
      ...seed,
      systemPrompt: 'You are Carbon, an L1 molecule. Build stuff.',
    });
    expect(t.name).toBe('Water'); // first L1 molecule in taxonomy
    expect(t.systemPrompt.startsWith('You are Water, an L1 molecule.')).toBe(
      true
    );
    // Re-read to confirm the DB actually has the rewritten value, not just
    // the returned object.
    expect(reg.getByName('Water')!.systemPrompt.startsWith('You are Water,')).toBe(
      true
    );
  });

  it('leaves generic-template seeds untouched', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const t = reg.create(1, {
      ...seed,
      systemPrompt: 'You are a focused L1 molecule worker. Do tasks.',
    });
    expect(t.systemPrompt).toBe('You are a focused L1 molecule worker. Do tasks.');
  });
});

describe('AtomRegistry.branch — auto-rebrand on branch descendants', () => {
  it('rewrites the inherited persona to match the branched atom name', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, {
      ...seed,
      systemPrompt: 'You are Water, an L1 molecule. Build X.',
    });
    // First child created via branch with NO overrideName → gets "Methane".
    const child = reg.branch('Water', {}, 'tester');
    expect(child.name).toBe('Methane');
    expect(child.systemPrompt.startsWith('You are Methane,')).toBe(true);
    // Rest of the prompt preserved (minus the name change).
    expect(child.systemPrompt).toContain('an L1 molecule. Build X.');
  });

  it('rewrites even when an overrideName is supplied', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, {
      ...seed,
      systemPrompt: 'You are Carbon, doing things.',
    });
    const child = reg.branch('Water', {}, 'tester', 'WebGLBuilder');
    expect(child.name).toBe('WebGLBuilder');
    expect(child.systemPrompt.startsWith('You are WebGLBuilder,')).toBe(true);
  });
});

describe('AtomRegistry.rebrand — realign a drifted persona line', () => {
  it('rewrites the systemPrompt in place via a patch and bumps the version', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    // Simulate a persona line that no longer matches its name — insert
    // raw so `create()` doesn't auto-fix it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb: any = (reg as any).db;
    const now = new Date().toISOString();
    rawDb.prepare(
      `INSERT INTO atom_types
       (tier, ordinal, name, description, system_prompt, tools_json, params_json, created_by, created_at, version, atom_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, lower(hex(randomblob(16))))`
    ).run(
      1,
      1,
      'Water',
      'd',
      'You are Carbon, an L1 molecule. Build X.',
      '[]',
      '{}',
      'drifted',
      now
    );

    const { type, changed } = reg.rebrand('Water');
    expect(changed).toBe(true);
    expect(type.version).toBe(2);
    expect(type.systemPrompt.startsWith('You are Water,')).toBe(true);
  });

  it('is a no-op when the persona already matches the name', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, {
      ...seed,
      systemPrompt: 'You are Water, an L1 molecule.',
    });
    const { changed, type } = reg.rebrand('Water');
    expect(changed).toBe(false);
    expect(type.version).toBe(1); // no version bump
  });

  it('throws on unknown atom names', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    expect(() => reg.rebrand('Phlogiston')).toThrow(/Phlogiston/);
  });
});
