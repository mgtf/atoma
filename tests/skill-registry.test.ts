import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry, parseFrontmatter, renderFrontmatter } from '../src/skills/registry.js';
import { L1Atom } from '../src/atoms/L1Atom.js';

/**
 * Tests for the SKILLS foundation (commit 1):
 *  - SkillRegistry filesystem layout: load / save / counters.
 *  - Frontmatter parser: required fields, kind validation, error
 *    handling on malformed input.
 *  - L1Atom hydrates its `skills()` accessor via the registry.
 *
 * No behaviour change yet at the supervisor tier — those land in
 * commits 2 (prefilter + body injection) and 3 (auto-creation).
 */

describe('parseFrontmatter / renderFrontmatter', () => {
  it('round-trips a minimal LLM skill', () => {
    const original = renderFrontmatter(
      {
        id: 'write-package-json',
        description: 'creates a package.json for a Node project',
        whenToUse: 'when the subtask asks to seed a Node package.json',
        kind: 'llm',
      },
      'Step 1. Determine name + version.\nStep 2. Write file.'
    );
    const parsed = parseFrontmatter(original);
    expect(parsed.frontmatter.id).toBe('write-package-json');
    expect(parsed.frontmatter.description).toMatch(/package\.json/);
    expect(parsed.frontmatter.whenToUse).toMatch(/seed/);
    expect(parsed.frontmatter.kind).toBe('llm');
    expect(parsed.body).toMatch(/Step 1/);
    expect(parsed.body).toMatch(/Step 2/);
  });

  it('rejects when frontmatter delimiters are missing', () => {
    expect(() => parseFrontmatter('no delimiters here')).toThrow(/frontmatter delimiters/);
  });

  it('rejects when a required field is missing', () => {
    const t = ['---', 'id: x', 'description: d', 'kind: llm', '---', 'body'].join('\n');
    expect(() => parseFrontmatter(t)).toThrow(/when_to_use/);
  });

  it('rejects an unknown kind value', () => {
    const t = [
      '---',
      'id: x',
      'description: d',
      'when_to_use: w',
      'kind: ghost',
      '---',
      'body',
    ].join('\n');
    expect(() => parseFrontmatter(t)).toThrow(/kind.*llm.*script/);
  });

  it('strips surrounding quotes on values', () => {
    const t = [
      '---',
      'id: x',
      'description: "quoted desc"',
      "when_to_use: 'quoted when'",
      'kind: llm',
      '---',
      'body',
    ].join('\n');
    const p = parseFrontmatter(t);
    expect(p.frontmatter.description).toBe('quoted desc');
    expect(p.frontmatter.whenToUse).toBe('quoted when');
  });

  it('defaults kind to llm when omitted (forwards-compatible)', () => {
    const t = [
      '---',
      'id: x',
      'description: d',
      'when_to_use: w',
      '---',
      'body',
    ].join('\n');
    const p = parseFrontmatter(t);
    expect(p.frontmatter.kind).toBe('llm');
  });
});

describe('SkillRegistry', () => {
  let dir: string;
  let reg: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skills-'));
    reg = new SkillRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for an L1 with no skills folder yet', () => {
    expect(reg.loadFor('Hydrogen')).toEqual([]);
  });

  it('save then loadFor round-trips a skill (counters start at zero)', () => {
    const saved = reg.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'write index.html, serve, validate, iterate',
      whenToUse: 'when the subtask is a single-file web artefact build',
      kind: 'llm',
      body: '1. write_file index.html\n2. start_static_server\n3. validate_html',
    });
    expect(saved.successes).toBe(0);
    expect(saved.failures).toBe(0);

    const loaded = reg.loadFor('Hydrogen');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('web-build-loop');
    expect(loaded[0]!.body).toMatch(/start_static_server/);
  });

  it('lists multiple skills sorted by id (stable prefilter prompts)', () => {
    reg.save('Lithium', {
      id: 'write-readme',
      description: 'create README.md',
      whenToUse: 'when the subtask is a markdown doc',
      kind: 'llm',
      body: 'Write a 4-section README.',
    });
    reg.save('Lithium', {
      id: 'write-package-json',
      description: 'create package.json',
      whenToUse: 'when the subtask is a Node package descriptor',
      kind: 'llm',
      body: 'Write the JSON.',
    });
    const skills = reg.loadFor('Lithium').map((s) => s.id);
    expect(skills).toEqual(['write-package-json', 'write-readme']);
  });

  it('recordSuccess / recordFailure bump counters via the meta sidecar', () => {
    reg.save('Lithium', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    reg.recordSuccess('Lithium', 'x');
    reg.recordSuccess('Lithium', 'x');
    reg.recordFailure('Lithium', 'x');
    const [skill] = reg.loadFor('Lithium');
    expect(skill!.successes).toBe(2);
    expect(skill!.failures).toBe(1);
  });

  it('preserves counters across a save() rewrite (patches do not punish trust)', () => {
    reg.save('Lithium', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'first version',
    });
    reg.recordSuccess('Lithium', 'x');
    reg.recordSuccess('Lithium', 'x');
    // Re-save with new body — counters should survive.
    reg.save('Lithium', {
      id: 'x',
      description: 'd refreshed',
      whenToUse: 'w refreshed',
      kind: 'llm',
      body: 'second version with more detail',
    });
    const [skill] = reg.loadFor('Lithium');
    expect(skill!.successes).toBe(2);
    expect(skill!.failures).toBe(0);
    expect(skill!.body).toMatch(/second version/);
    expect(skill!.description).toBe('d refreshed');
  });

  it('SKILL.md on disk is hand-readable (frontmatter + body)', () => {
    reg.save('Hydrogen', {
      id: 'foo',
      description: 'desc',
      whenToUse: 'when foo',
      kind: 'llm',
      body: 'do the foo',
    });
    const text = readFileSync(join(dir, 'Hydrogen', 'foo', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---/);
    expect(text).toMatch(/id: foo/);
    expect(text).toMatch(/kind: llm/);
    expect(text).toMatch(/do the foo/);
  });

  it('skips folders missing SKILL.md without crashing', () => {
    mkdirSync(join(dir, 'Hydrogen', 'orphan'), { recursive: true });
    reg.save('Hydrogen', {
      id: 'real',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    const skills = reg.loadFor('Hydrogen');
    expect(skills.map((s) => s.id)).toEqual(['real']);
  });

  it('rejects unsafe namespace / id components (path-traversal guard)', () => {
    expect(() =>
      reg.save('../escape', {
        id: 'x',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'b',
      })
    ).toThrow(/unsafe skill path component/);
  });

  it('a malformed SKILL.md is skipped with a warn (not a hard throw)', () => {
    const broken = join(dir, 'Hydrogen', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'SKILL.md'), 'no frontmatter at all', 'utf8');
    reg.save('Hydrogen', {
      id: 'good',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    // Silence the console.warn for the duration of the call.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const orig = console.warn;
    console.warn = (): void => {};
    try {
      const skills = reg.loadFor('Hydrogen');
      expect(skills.map((s) => s.id)).toEqual(['good']);
    } finally {
      console.warn = orig;
    }
  });
});

describe('L1Atom.skills() integration', () => {
  let dir: string;
  let reg: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skills-l1-'));
    reg = new SkillRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when no SkillRegistry is passed to fromType (legacy callers unchanged)', () => {
    const atom = L1Atom.fromType({
      tier: 1,
      ordinal: 1,
      name: 'Hydrogen',
      description: 'd',
      systemPrompt: 'sys',
      tools: [],
      params: {},
      version: 1,
      successes: 0,
      failures: 0,
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(atom.skills()).toEqual([]);
  });

  it('hydrates skills() from the registry when one is provided', () => {
    reg.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    const atom = L1Atom.fromType(
      {
        tier: 1,
        ordinal: 1,
        name: 'Hydrogen',
        description: 'd',
        systemPrompt: 'sys',
        tools: [],
        params: {},
        version: 1,
        successes: 0,
        failures: 0,
        createdBy: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      undefined,
      reg
    );
    expect(atom.skills().map((s) => s.id)).toEqual(['web-build-loop']);
  });

  it('a path-traversal in the L1 name is rejected by the registry, not silently expanded', () => {
    expect(() => reg.loadFor('../escape')).toThrow(/unsafe skill path component/);
  });

  it('an unrelated namespace returns empty even when others have skills', () => {
    reg.save('Hydrogen', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    expect(reg.loadFor('Helium')).toEqual([]);
    // Hydrogen still has its skill on disk.
    expect(existsSync(join(dir, 'Hydrogen', 'x', 'SKILL.md'))).toBe(true);
  });
});
