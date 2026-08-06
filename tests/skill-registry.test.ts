import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SkillRegistry,
  parseFrontmatter,
  renderFrontmatter,
  REFUSAL_REASON_MAX_CHARS,
} from '../src/skills/registry.js';
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

  it('initializes _meta.json on first bump for a hand-written skill (no save() pre-call)', async () => {
    // Reproduces the live regression: a SKILL.md created via a
    // shell heredoc (no SkillRegistry.save call) had no _meta.json,
    // so the first recordSuccess no-op'd and the counter never
    // accumulated. The fix initialises the meta file lazily on
    // first bump.
    const { writeFileSync, mkdirSync, existsSync: exists } = await import('node:fs');
    const skillDir = join(dir, 'Hydrogen', 'hand-written');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'id: hand-written',
        'description: a hand-written skill that bypassed save()',
        'when_to_use: whenever the test needs it',
        'kind: llm',
        '---',
        'do the thing',
      ].join('\n'),
      'utf8'
    );
    expect(exists(join(skillDir, '_meta.json'))).toBe(false);
    reg.recordSuccess('Hydrogen', 'hand-written');
    expect(exists(join(skillDir, '_meta.json'))).toBe(true);
    const [skill] = reg.loadFor('Hydrogen');
    expect(skill!.successes).toBe(1);
    expect(skill!.failures).toBe(0);
  });

  it('still no-ops when the SKILL.md itself is missing (no rogue counter creation)', async () => {
    // The bump must not create _meta.json for a skill that doesn't
    // exist on disk — the supervise loop should not be able to
    // accidentally manifest a counter for a skill ID it pulled out
    // of thin air (e.g. cached from a deleted skill).
    const { existsSync: exists } = await import('node:fs');
    reg.recordSuccess('Hydrogen', 'never-existed');
    expect(exists(join(dir, 'Hydrogen', 'never-existed'))).toBe(false);
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
    // Spec-canonical key since the Agent Skills alignment: the writer emits
    // `name:` (parseFrontmatter still reads legacy `id:` stores).
    expect(text).toMatch(/name: foo/);
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

  describe('promoteToScript / demoteToLlm — llm↔script lifecycle', () => {
    it('promoteToScript stashes the original body in _fallback.md and rewrites SKILL.md', () => {
      reg.save('Helium', {
        id: 'scaffold-node-ssr',
        description: 'scaffold a Node SSR server with SQLite',
        whenToUse: 'task is a Node SSR app with persistence',
        kind: 'llm',
        body: '1. write_file package.json\n2. write_file server.js\n3. npm install\n4. start_node_server',
      });
      // Earn some trust before promotion.
      reg.recordSuccess('Helium', 'scaffold-node-ssr');
      reg.recordSuccess('Helium', 'scaffold-node-ssr');

      const promoted = reg.promoteToScript({
        l1Name: 'Helium',
        skillId: 'scaffold-node-ssr',
        language: 'node',
        scriptBody: 'console.log(JSON.stringify({output: "ok", summary: "done"}))',
      });
      expect(promoted.kind).toBe('script');
      expect(promoted.language).toBe('node');
      expect(promoted.body).toMatch(/console\.log/);
      // Counters are RESET across promotion. The successes were earned by the
      // MARKDOWN recipe under a validated LLM loop; the compiled script has
      // never run. Inheriting them armed the no-validator deterministic
      // dispatch on the script's very first match (shouldTrustSkill needs
      // 3/0) — see promoteToScript's rationale. The script form must earn its
      // trust through the validated loop first.
      expect(promoted.successes).toBe(0);
      expect(promoted.failures).toBe(0);
      // And the reset is on DISK, not just in the returned object.
      const metaAfter = JSON.parse(
        readFileSync(join(dir, 'Helium', 'scaffold-node-ssr', '_meta.json'), 'utf8')
      );
      expect(metaAfter.successes).toBe(0);

      // Disk state: SKILL.md frontmatter says script + node, sidecar holds llm body.
      const skillFile = join(dir, 'Helium', 'scaffold-node-ssr', 'SKILL.md');
      const skillText = readFileSync(skillFile, 'utf8');
      expect(skillText).toMatch(/kind: script/);
      expect(skillText).toMatch(/language: node/);
      const fallbackFile = join(dir, 'Helium', 'scaffold-node-ssr', '_fallback.md');
      expect(existsSync(fallbackFile)).toBe(true);
      expect(readFileSync(fallbackFile, 'utf8')).toMatch(/start_node_server/);

      // loadFor exposes fallbackBody on the loaded skill.
      const loaded = reg.loadFor('Helium')[0]!;
      expect(loaded.kind).toBe('script');
      expect(loaded.fallbackBody).toMatch(/start_node_server/);
    });

    it('promoteToScript refuses to overwrite an already-script skill (would erase fallback)', () => {
      reg.save('Helium', {
        id: 'x',
        description: 'd',
        whenToUse: 'w',
        kind: 'script',
        language: 'node',
        body: 'console.log("first")',
      });
      expect(() =>
        reg.promoteToScript({
          l1Name: 'Helium',
          skillId: 'x',
          language: 'node',
          scriptBody: 'console.log("second")',
        })
      ).toThrow(/already kind:"script"/);
    });

    it('demoteToLlm restores the fallback body verbatim and keeps post-promotion counters', () => {
      reg.save('Helium', {
        id: 'roundtrip',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'ORIGINAL llm recipe — step 1, step 2',
      });
      reg.recordSuccess('Helium', 'roundtrip');
      reg.promoteToScript({
        l1Name: 'Helium',
        skillId: 'roundtrip',
        language: 'node',
        scriptBody: 'console.log("script")',
      });
      // Demote (script just failed in the wild).
      reg.recordFailure('Helium', 'roundtrip');
      const demoted = reg.demoteToLlm('Helium', 'roundtrip')!;
      expect(demoted.kind).toBe('llm');
      expect(demoted.body).toMatch(/ORIGINAL llm recipe/);
      // The pre-promotion success was cleared BY the promotion (see
      // promoteToScript); demotion itself preserves whatever the script form
      // accumulated — here just the failure that triggered it.
      expect(demoted.successes).toBe(0);
      expect(demoted.failures).toBe(1);

      // _fallback.md is INTENTIONALLY left in place so a future
      // re-promotion (after manual counter reset) can compare.
      const fallbackFile = join(dir, 'Helium', 'roundtrip', '_fallback.md');
      expect(existsSync(fallbackFile)).toBe(true);
    });

    it('demoteToLlm returns null when the skill is not currently kind:script', () => {
      reg.save('Helium', {
        id: 'plain',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'still llm',
      });
      expect(reg.demoteToLlm('Helium', 'plain')).toBeNull();
    });

    it('markPromotionRefused stamps _meta.json so the supervisor can short-circuit future Sonnet compile calls', () => {
      reg.save('Helium', {
        id: 'too-llm-shaped',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'recipe with irreducible LLM steps',
      });
      const meta = reg.markPromotionRefused(
        'Helium',
        'too-llm-shaped',
        'schema design is an irreducible LLM reasoning step'
      )!;
      expect(meta.promotionRefusedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // loadFor surfaces the stamp AND the reason on the Skill: the WHY is
      // the actionable part for the operator ("why do I have no script
      // skills?" used to require grepping ./runs).
      const loaded = reg.loadFor('Helium')[0]!;
      expect(loaded.promotionRefusedAt).toBe(meta.promotionRefusedAt);
      expect(loaded.promotionRefusedReason).toBe(
        'schema design is an irreducible LLM reasoning step'
      );
    });

    it('markPromotionRefused bounds the persisted reason and tolerates its absence', () => {
      reg.save('Helium', {
        id: 'bounded',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'b',
      });
      const long = reg.markPromotionRefused('Helium', 'bounded', 'x'.repeat(2000))!;
      expect(long.promotionRefusedReason).toHaveLength(REFUSAL_REASON_MAX_CHARS);
      // A reason-less stamp (legacy callers, empty Sonnet reason) stays valid
      // and does not write an empty-string field.
      reg.save('Helium', { id: 'bounded', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b2' });
      const bare = reg.markPromotionRefused('Helium', 'bounded')!;
      expect(bare.promotionRefusedAt).toBeTruthy();
      expect(bare.promotionRefusedReason).toBeUndefined();
    });

    it('counter bumps PRESERVE promotionRefusedAt (only save() clears it)', () => {
      reg.save('Helium', {
        id: 'sticky',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'b',
      });
      const stamped = reg.markPromotionRefused('Helium', 'sticky', 'because reasons')!;
      reg.recordSuccess('Helium', 'sticky');
      reg.recordSuccess('Helium', 'sticky');
      const after = reg.loadFor('Helium')[0]!;
      expect(after.successes).toBe(2);
      expect(after.promotionRefusedAt).toBe(stamped.promotionRefusedAt);
      expect(after.promotionRefusedReason).toBe('because reasons');
    });

    it('save() CLEARS promotionRefusedAt — a rewritten body deserves a fresh compile attempt', () => {
      reg.save('Helium', {
        id: 'rewritten',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'old recipe',
      });
      reg.markPromotionRefused('Helium', 'rewritten', 'old body was judgment-shaped');
      expect(reg.loadFor('Helium')[0]!.promotionRefusedAt).toBeTruthy();
      // Simulate improveSkillBody / re-distillation rewriting the body.
      reg.save('Helium', {
        id: 'rewritten',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'NEW recipe — much more procedural now',
      });
      expect(reg.loadFor('Helium')[0]!.promotionRefusedAt).toBeUndefined();
      // The reason is a judgment about the OLD body — it clears with the stamp.
      expect(reg.loadFor('Helium')[0]!.promotionRefusedReason).toBeUndefined();
    });

    it('markPromotionRefused returns null for a missing skill (no auto-create)', () => {
      expect(reg.markPromotionRefused('Helium', 'does-not-exist')).toBeNull();
    });

    it('demoteToLlm returns null when no fallback sidecar is present', () => {
      // Hand-author a kind:script skill (skipping the promoteToScript path)
      // to simulate a skill created script-first via the auto-creation
      // pipeline once that lands. There's no _fallback.md to restore.
      reg.save('Helium', {
        id: 'born-script',
        description: 'd',
        whenToUse: 'w',
        kind: 'script',
        language: 'node',
        body: 'console.log("hi")',
      });
      expect(reg.demoteToLlm('Helium', 'born-script')).toBeNull();
    });
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
