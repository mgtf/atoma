import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import {
  assertCurrentIdentity,
  leftoverNameKeyedNamespaces,
  namespaceOf,
  readSkillOwners,
  resolveNamespaceKey,
} from '../src/skills/namespace.js';
import { RunnerConfigError } from '../src/core/errors.js';
import { skillsList, skillsReview, skillsStats } from '../src/mcp/readers.js';

/**
 * T4 leftover: display-layer surfaces were updated to print molecule names,
 * but several addressers still treated the name as the disk key (review
 * 2026-08-18 §1.1 / §1.4 / §1.9). These tests go through the production
 * readers with a real store + id-keyed skills tree.
 */

const seed = {
  description: 'file scribe',
  systemPrompt: 'You are an L1.',
  tools: [
    { name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: {} } },
  ],
  params: {},
  createdBy: 'test',
};

describe('resolveNamespaceKey', () => {
  const labels = new Map([
    ['atom-water', 'Water'],
    ['atom-methane', 'Methane'],
  ]);

  it('returns an atom id unchanged', () => {
    expect(resolveNamespaceKey('atom-water', labels)).toBe('atom-water');
  });

  it('resolves a display name to the atom id', () => {
    expect(resolveNamespaceKey('Water', labels)).toBe('atom-water');
  });

  it('passes an unknown token through (orphaned directory / minted test key)', () => {
    expect(resolveNamespaceKey('orphan-ns', labels)).toBe('orphan-ns');
  });
});

describe('assertCurrentIdentity — leftover name-keyed trees (review 2026-08-18 §1.8)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a curated molecule directory even with an empty store (post-reset leftover)', () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-leftover-'));
    mkdirSync(join(dir, 'Water'));
    mkdirSync(join(dir, 'orphan-custom'));
    const leftovers = leftoverNameKeyedNamespaces(dir, []);
    expect(leftovers).toEqual([{ name: 'Water' }]);
    expect(() => assertCurrentIdentity(dir, [])).toThrow(RunnerConfigError);
    expect(() => assertCurrentIdentity(dir, [])).toThrow(/skills\/Water\//);
  });

  it('pairs a leftover name with the live atom id and ignores the id-keyed dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-leftover-'));
    mkdirSync(join(dir, 'Water'));
    mkdirSync(join(dir, 'atom-water'));
    const leftovers = leftoverNameKeyedNamespaces(dir, [
      { atomId: 'atom-water', name: 'Water' },
    ]);
    expect(leftovers).toEqual([{ name: 'Water', atomId: 'atom-water' }]);
  });

  it('does not flag an id-keyed tree or an unknown orphan', () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-leftover-'));
    mkdirSync(join(dir, 'atom-water'));
    mkdirSync(join(dir, 'orphan-custom'));
    expect(
      leftoverNameKeyedNamespaces(dir, [{ atomId: 'atom-water', name: 'Water' }])
    ).toEqual([]);
    expect(() =>
      assertCurrentIdentity(dir, [{ atomId: 'atom-water', name: 'Water' }])
    ).not.toThrow();
  });

  it('readSkillOwners is readonly and empty on a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-owners-'));
    expect(readSkillOwners(join(dir, 'nope.db'))).toEqual([]);
  });
});

describe('production path — skills directory is the atom id', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('create → save via namespaceOf → directory is atomId, not the name', () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-ns-'));
    const reg = new AtomRegistry(openDb(':memory:'));
    const water = reg.create(1, seed);
    const skills = new SkillRegistry(dir);
    skills.save(namespaceOf(water), {
      id: 'write-notes',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'use write_file',
    });
    expect(existsSync(join(dir, water.atomId, 'write-notes'))).toBe(true);
    expect(existsSync(join(dir, water.name, 'write-notes'))).toBe(false);
  });
});

describe('MCP skill surfaces after the name→id flip', () => {
  let dir: string;
  let waterId: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-id-surf-'));
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR']) {
      saved[k] = process.env[k];
    }
    const dbPath = join(dir, 'atoma.db');
    const skillsDir = join(dir, 'skills');
    process.env['ATOMA_DB_PATH'] = dbPath;
    process.env['ATOMA_SKILLS_DIR'] = skillsDir;
    const db = openDb(dbPath);
    const registry = new AtomRegistry(db);
    const water = registry.create(1, seed);
    waterId = water.atomId;
    db.close();
    const skills = new SkillRegistry(skillsDir);
    skills.save(namespaceOf(water), {
      id: 'write-notes',
      description: 'write a notes file',
      whenToUse: 'when notes must be written',
      kind: 'llm',
      body: 'Call write_file for the notes. Then call validate_html to check the page.',
    });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('skillsList filter accepts the molecule name, not only the atom id', () => {
    const byName = skillsList({ l1: 'Water' }) as {
      namespaces: Array<{ l1: string; l1Key: string; skills: Array<{ id: string }> }>;
    };
    expect(byName.namespaces).toHaveLength(1);
    expect(byName.namespaces[0]!.l1).toBe('Water');
    expect(byName.namespaces[0]!.l1Key).toBe(waterId);
    expect(byName.namespaces[0]!.skills.map((s) => s.id)).toEqual(['write-notes']);
    expect('identityWarning' in byName).toBe(false);

    const byId = skillsList({ l1: waterId }) as { namespaces: Array<{ l1Key: string }> };
    expect(byId.namespaces[0]!.l1Key).toBe(waterId);
  });

  it('skillsReview keys owner tools by atom id (review 2026-08-18 §1.1)', () => {
    // write_file is declared on Water; validate_html is not. Keying the
    // tool map by name made every lookup miss, so write_file was ALSO
    // reported undeclared — a false-positive block on a legitimate body.
    const review = skillsReview() as {
      assessments: Array<{
        l1: string;
        l1Key: string;
        id: string;
        blockers: Array<{ code: string; detail: string }>;
      }>;
    };
    expect(review.assessments).toHaveLength(1);
    const row = review.assessments[0]!;
    expect(row.l1).toBe('Water');
    expect(row.l1Key).toBe(waterId);
    const undeclared = row.blockers.filter((b) => b.code === 'scope:undeclared-tool');
    expect(undeclared.some((b) => b.detail.includes('validate_html'))).toBe(true);
    expect(undeclared.some((b) => b.detail.includes('write_file'))).toBe(false);
  });

  it('skillsReview / skillsStats filter by molecule name', () => {
    const review = skillsReview({ l1: 'Water' }) as { assessments: Array<{ id: string }> };
    expect(review.assessments.map((a) => a.id)).toEqual(['write-notes']);
    const stats = skillsStats({ l1: 'Water' }) as {
      rows: Array<{ l1: string; l1Key: string; id: string }>;
    };
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]!.l1).toBe('Water');
    expect(stats.rows[0]!.l1Key).toBe(waterId);
    expect(stats.rows[0]!.id).toBe('write-notes');
  });

  it('skillsList warns in-band when a leftover name-keyed directory is present', () => {
    mkdirSync(join(dir, 'skills', 'Water'));
    const listed = skillsList() as { identityWarning?: string };
    expect(listed.identityWarning).toMatch(/skills\/Water\//);
    expect(listed.identityWarning).toMatch(waterId);
  });
});
