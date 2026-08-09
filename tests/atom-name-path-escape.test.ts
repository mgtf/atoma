import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AtomRegistry, isSafeAtomName } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';

/**
 * An atom NAME is a path component, and it can be LLM-authored.
 *
 * The skill store namespaces by atom name (`skills/<atom>/<skill-id>/`), and
 * an L2/L3 validator verdict carries `branchName` — model output — which
 * `L2Atom`/`L3Atom` hand to `AtomRegistry.branch` as `overrideName`, where it
 * becomes the name verbatim. `sanitise` was supposed to be the guard, and its
 * docstring said so ("can't escape its namespace"), but its charset test
 * `/^[A-Za-z0-9._-]+$/` ACCEPTS `..` — every character is in the set.
 *
 * REPRODUCED before the fix: a verdict emitting `".."` wrote a SKILL.md one
 * directory ABOVE the skills root. Found while formalising the SaaS tenancy
 * model, where a namespace boundary stops being hygiene and becomes the
 * thing separating two customers.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A skills root nested inside its OWN fresh parent.
 *
 * Not cosmetic: the escape these tests describe writes to `<root>/../<id>`,
 * so a root placed directly in the OS tmpdir makes the assertion depend on
 * whatever else has ever run there — and a failing run leaves the escaped
 * artefact behind, so the next run passes for the wrong reason. Measured the
 * hard way: an earlier manual reproduction left /tmp/pwn on disk and turned
 * this very test red. With a private parent, the escape target is unique per
 * test and swept by afterEach.
 */
function freshSkillsRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), 'atoma-escape-'));
  dirs.push(parent);
  const root = join(parent, 'skills');
  mkdirSync(root, { recursive: true });
  return root;
}

function registryWithLeaf(): { reg: AtomRegistry; leaf: string } {
  const reg = new AtomRegistry(openDb(':memory:'));
  reg.create(1, { description: 'leaf', systemPrompt: 'p', tools: [], params: {}, createdBy: 't' });
  return { reg, leaf: reg.listByTier(1)[0]!.name };
}

describe('isSafeAtomName', () => {
  it('accepts ordinary taxonomy names', () => {
    for (const n of ['Hydrogen', 'Water', 'Methane-2', 'file_scribe.v2']) {
      expect(isSafeAtomName(n), n).toBe(true);
    }
  });

  it('rejects traversal that a charset test alone lets through', () => {
    // These are the ones that matter: every character is in [A-Za-z0-9._-].
    for (const n of ['.', '..', '...']) {
      expect(isSafeAtomName(n), `"${n}" must be rejected`).toBe(false);
    }
  });

  it('rejects separators, empties and absurd lengths', () => {
    for (const n of ['a/b', '../etc', 'a\\b', '', ' ', 'x'.repeat(65)]) {
      expect(isSafeAtomName(n), JSON.stringify(n)).toBe(false);
    }
  });
});

describe('branch() refuses an unsafe LLM-authored name', () => {
  it('falls back to the taxonomy instead of naming an atom ".."', () => {
    const { reg, leaf } = registryWithLeaf();
    const branched = reg.branch(leaf, {}, 'L2', '..');
    expect(branched.name).not.toBe('..');
    expect(isSafeAtomName(branched.name)).toBe(true);
  });

  it('still honours a legitimate override', () => {
    const { reg, leaf } = registryWithLeaf();
    const branched = reg.branch(leaf, {}, 'L2', 'CsvSummariser');
    expect(branched.name).toBe('CsvSummariser');
  });

  it('branch stays total — an unsafe name must not throw and kill the run', () => {
    const { reg, leaf } = registryWithLeaf();
    expect(() => reg.branch(leaf, {}, 'L2', '../../etc/passwd')).not.toThrow();
  });
});

describe('the skill store cannot be written outside its root', () => {
  it('rejects a ".." namespace outright', () => {
    const root = freshSkillsRoot();
    const sk = new SkillRegistry(root);
    expect(() =>
      sk.save('..', {
        id: 'pwn',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'x',
      } as never)
    ).toThrow(/unsafe skill path component/);
    expect(existsSync(resolve(root, '..', 'pwn'))).toBe(false);
  });

  it('end to end: an LLM verdict of ".." writes nothing outside the root', () => {
    // The full chain that was reproduced: verdict.branchName -> branch()
    // -> atom name -> skills namespace -> writeFileSync.
    const { reg, leaf } = registryWithLeaf();
    const root = freshSkillsRoot();
    const sk = new SkillRegistry(root);
    const branched = reg.branch(leaf, {}, 'L2', '..');
    sk.save(branched.name, {
      id: 'learned',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'x',
    } as never);
    expect(existsSync(resolve(root, '..', 'learned', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(root, branched.name, 'learned', 'SKILL.md'))).toBe(true);
  });
});
