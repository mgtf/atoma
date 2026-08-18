import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SkillRegistry,
  parseFrontmatter,
  renderFrontmatter,
  REFUSAL_REASON_MAX_CHARS,
} from '../src/skills/registry.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { closeLedgerHandles, readLedger } from '../src/core/ledger.js';

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
    const t = ['---', 'name: x', 'description: d', 'kind: llm', '---', 'body'].join('\n');
    expect(() => parseFrontmatter(t)).toThrow(/when_to_use/);
  });

  it('rejects an unknown kind value', () => {
    const t = [
      '---',
      'name: x',
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
      'name: x',
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
      'name: x',
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
    expect(reg.loadFor('Water')).toEqual([]);
  });

  it('save then loadFor round-trips a skill (counters start at zero)', () => {
    const saved = reg.save('Water', {
      id: 'web-build-loop',
      description: 'write index.html, serve, validate, iterate',
      whenToUse: 'when the subtask is a single-file web artefact build',
      kind: 'llm',
      body: '1. write_file index.html\n2. start_static_server\n3. validate_html',
    });
    expect(saved.successes).toBe(0);
    expect(saved.failures).toBe(0);

    const loaded = reg.loadFor('Water');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('web-build-loop');
    expect(loaded[0]!.body).toMatch(/start_static_server/);
  });

  it('lists multiple skills sorted by id (stable prefilter prompts)', () => {
    reg.save('Ammonia', {
      id: 'write-readme',
      description: 'create README.md',
      whenToUse: 'when the subtask is a markdown doc',
      kind: 'llm',
      body: 'Write a 4-section README.',
    });
    reg.save('Ammonia', {
      id: 'write-package-json',
      description: 'create package.json',
      whenToUse: 'when the subtask is a Node package descriptor',
      kind: 'llm',
      body: 'Write the JSON.',
    });
    const skills = reg.loadFor('Ammonia').map((s) => s.id);
    expect(skills).toEqual(['write-package-json', 'write-readme']);
  });

  it('recordSuccess / recordFailure bump counters via the meta sidecar', () => {
    reg.save('Ammonia', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    reg.recordSuccess('Ammonia', 'x');
    reg.recordSuccess('Ammonia', 'x');
    reg.recordFailure('Ammonia', 'x');
    const [skill] = reg.loadFor('Ammonia');
    expect(skill!.successes).toBe(2);
    expect(skill!.failures).toBe(1);
  });

  it('preserves counters across a save() rewrite (patches do not punish trust)', () => {
    reg.save('Ammonia', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'first version',
    });
    reg.recordSuccess('Ammonia', 'x');
    reg.recordSuccess('Ammonia', 'x');
    // Re-save with new body — counters should survive.
    reg.save('Ammonia', {
      id: 'x',
      description: 'd refreshed',
      whenToUse: 'w refreshed',
      kind: 'llm',
      body: 'second version with more detail',
    });
    const [skill] = reg.loadFor('Ammonia');
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
    const skillDir = join(dir, 'Water', 'hand-written');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: hand-written',
        'description: a hand-written skill that bypassed save()',
        'when_to_use: whenever the test needs it',
        'kind: llm',
        '---',
        'do the thing',
      ].join('\n'),
      'utf8'
    );
    expect(exists(join(skillDir, '_meta.json'))).toBe(false);
    reg.recordSuccess('Water', 'hand-written');
    expect(exists(join(skillDir, '_meta.json'))).toBe(true);
    const [skill] = reg.loadFor('Water');
    expect(skill!.successes).toBe(1);
    expect(skill!.failures).toBe(0);
  });

  it('still no-ops when the SKILL.md itself is missing (no rogue counter creation)', async () => {
    // The bump must not create _meta.json for a skill that doesn't
    // exist on disk — the supervise loop should not be able to
    // accidentally manifest a counter for a skill ID it pulled out
    // of thin air (e.g. cached from a deleted skill).
    const { existsSync: exists } = await import('node:fs');
    reg.recordSuccess('Water', 'never-existed');
    expect(exists(join(dir, 'Water', 'never-existed'))).toBe(false);
  });

  it('SKILL.md on disk is hand-readable (frontmatter + body)', () => {
    reg.save('Water', {
      id: 'foo',
      description: 'desc',
      whenToUse: 'when foo',
      kind: 'llm',
      body: 'do the foo',
    });
    const text = readFileSync(join(dir, 'Water', 'foo', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---/);
    // Spec-canonical key since the Agent Skills alignment: the writer emits
    // `name:` (parseFrontmatter still reads legacy `id:` stores).
    expect(text).toMatch(/name: foo/);
    expect(text).toMatch(/kind: llm/);
    expect(text).toMatch(/do the foo/);
  });

  it('skips folders missing SKILL.md without crashing', () => {
    mkdirSync(join(dir, 'Water', 'orphan'), { recursive: true });
    reg.save('Water', {
      id: 'real',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    const skills = reg.loadFor('Water');
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
    const broken = join(dir, 'Water', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'SKILL.md'), 'no frontmatter at all', 'utf8');
    reg.save('Water', {
      id: 'good',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    // Silence the console.warn for the duration of the call.
     
    const orig = console.warn;
    console.warn = (): void => {};
    try {
      const skills = reg.loadFor('Water');
      expect(skills.map((s) => s.id)).toEqual(['good']);
    } finally {
      console.warn = orig;
    }
  });

  describe('promoteToScript / demoteToLlm — llm↔script lifecycle', () => {
    it('promoteToScript stashes the original body in _fallback.md and rewrites SKILL.md', () => {
      reg.save('Methane', {
        id: 'scaffold-node-ssr',
        description: 'scaffold a Node SSR server with SQLite',
        whenToUse: 'task is a Node SSR app with persistence',
        kind: 'llm',
        body: '1. write_file package.json\n2. write_file server.js\n3. npm install\n4. start_node_server',
      });
      // Earn some trust before promotion.
      reg.recordSuccess('Methane', 'scaffold-node-ssr');
      reg.recordSuccess('Methane', 'scaffold-node-ssr');

      const promoted = reg.promoteToScript({
        l1Name: 'Methane',
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
        readFileSync(join(dir, 'Methane', 'scaffold-node-ssr', '_meta.json'), 'utf8')
      );
      expect(metaAfter.successes).toBe(0);

      // Disk state: SKILL.md frontmatter says script + node, sidecar holds llm body.
      const skillFile = join(dir, 'Methane', 'scaffold-node-ssr', 'SKILL.md');
      const skillText = readFileSync(skillFile, 'utf8');
      expect(skillText).toMatch(/kind: script/);
      expect(skillText).toMatch(/language: node/);
      const fallbackFile = join(dir, 'Methane', 'scaffold-node-ssr', '_fallback.md');
      expect(existsSync(fallbackFile)).toBe(true);
      expect(readFileSync(fallbackFile, 'utf8')).toMatch(/start_node_server/);

      // loadFor exposes fallbackBody on the loaded skill.
      const loaded = reg.loadFor('Methane')[0]!;
      expect(loaded.kind).toBe('script');
      expect(loaded.fallbackBody).toMatch(/start_node_server/);
    });

    it('promoteToScript refuses to overwrite an already-script skill (would erase fallback)', () => {
      reg.save('Methane', {
        id: 'x',
        description: 'd',
        whenToUse: 'w',
        kind: 'script',
        language: 'node',
        body: 'console.log("first")',
      });
      expect(() =>
        reg.promoteToScript({
          l1Name: 'Methane',
          skillId: 'x',
          language: 'node',
          scriptBody: 'console.log("second")',
        })
      ).toThrow(/already kind:"script"/);
    });

    it('demoteToLlm restores the fallback body verbatim and keeps post-promotion counters', () => {
      reg.save('Methane', {
        id: 'roundtrip',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'ORIGINAL llm recipe — step 1, step 2',
      });
      reg.recordSuccess('Methane', 'roundtrip');
      reg.promoteToScript({
        l1Name: 'Methane',
        skillId: 'roundtrip',
        language: 'node',
        scriptBody: 'console.log("script")',
      });
      // Demote (script just failed in the wild).
      reg.recordFailure('Methane', 'roundtrip');
      const demoted = reg.demoteToLlm('Methane', 'roundtrip')!;
      expect(demoted.kind).toBe('llm');
      expect(demoted.body).toMatch(/ORIGINAL llm recipe/);
      // The pre-promotion success was cleared BY the promotion (see
      // promoteToScript); demotion itself preserves whatever the script form
      // accumulated — here just the failure that triggered it.
      expect(demoted.successes).toBe(0);
      expect(demoted.failures).toBe(1);

      // _fallback.md is INTENTIONALLY left in place so a future
      // re-promotion (after manual counter reset) can compare.
      const fallbackFile = join(dir, 'Methane', 'roundtrip', '_fallback.md');
      expect(existsSync(fallbackFile)).toBe(true);
    });

    it('demoteToLlm returns null when the skill is not currently kind:script', () => {
      reg.save('Methane', {
        id: 'plain',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'still llm',
      });
      expect(reg.demoteToLlm('Methane', 'plain')).toBeNull();
    });

    it('markPromotionRefused stamps _meta.json so the supervisor can short-circuit future Sonnet compile calls', () => {
      reg.save('Methane', {
        id: 'too-llm-shaped',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'recipe with irreducible LLM steps',
      });
      const meta = reg.markPromotionRefused(
        'Methane',
        'too-llm-shaped',
        'schema design is an irreducible LLM reasoning step'
      )!;
      expect(meta.promotionRefusedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // loadFor surfaces the stamp AND the reason on the Skill: the WHY is
      // the actionable part for the operator ("why do I have no script
      // skills?" used to require grepping ./runs).
      const loaded = reg.loadFor('Methane')[0]!;
      expect(loaded.promotionRefusedAt).toBe(meta.promotionRefusedAt);
      expect(loaded.promotionRefusedReason).toBe(
        'schema design is an irreducible LLM reasoning step'
      );
    });

    it('markPromotionRefused bounds the persisted reason and tolerates its absence', () => {
      reg.save('Methane', {
        id: 'bounded',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'b',
      });
      const long = reg.markPromotionRefused('Methane', 'bounded', 'x'.repeat(2000))!;
      expect(long.promotionRefusedReason).toHaveLength(REFUSAL_REASON_MAX_CHARS);
      // A reason-less stamp (legacy callers, empty Sonnet reason) stays valid
      // and does not write an empty-string field.
      reg.save('Methane', { id: 'bounded', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b2' });
      const bare = reg.markPromotionRefused('Methane', 'bounded')!;
      expect(bare.promotionRefusedAt).toBeTruthy();
      expect(bare.promotionRefusedReason).toBeUndefined();
    });

    it('counter bumps PRESERVE promotionRefusedAt (only save() clears it)', () => {
      reg.save('Methane', {
        id: 'sticky',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'b',
      });
      const stamped = reg.markPromotionRefused('Methane', 'sticky', 'because reasons')!;
      reg.recordSuccess('Methane', 'sticky');
      reg.recordSuccess('Methane', 'sticky');
      const after = reg.loadFor('Methane')[0]!;
      expect(after.successes).toBe(2);
      expect(after.promotionRefusedAt).toBe(stamped.promotionRefusedAt);
      expect(after.promotionRefusedReason).toBe('because reasons');
    });

    it('save() CLEARS promotionRefusedAt — a rewritten body deserves a fresh compile attempt', () => {
      reg.save('Methane', {
        id: 'rewritten',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'old recipe',
      });
      reg.markPromotionRefused('Methane', 'rewritten', 'old body was judgment-shaped');
      expect(reg.loadFor('Methane')[0]!.promotionRefusedAt).toBeTruthy();
      // Simulate improveSkillBody / re-distillation rewriting the body.
      reg.save('Methane', {
        id: 'rewritten',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        body: 'NEW recipe — much more procedural now',
      });
      expect(reg.loadFor('Methane')[0]!.promotionRefusedAt).toBeUndefined();
      // The reason is a judgment about the OLD body — it clears with the stamp.
      expect(reg.loadFor('Methane')[0]!.promotionRefusedReason).toBeUndefined();
    });

    it('markPromotionRefused returns null for a missing skill (no auto-create)', () => {
      expect(reg.markPromotionRefused('Methane', 'does-not-exist')).toBeNull();
    });

    it('demoteToLlm returns null when no fallback sidecar is present', () => {
      // Hand-author a kind:script skill (skipping the promoteToScript path)
      // to simulate a skill created script-first via the auto-creation
      // pipeline once that lands. There's no _fallback.md to restore.
      reg.save('Methane', {
        id: 'born-script',
        description: 'd',
        whenToUse: 'w',
        kind: 'script',
        language: 'node',
        body: 'console.log("hi")',
      });
      expect(reg.demoteToLlm('Methane', 'born-script')).toBeNull();
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
      atomId: '00000000-0000-4000-8000-000000000001',
      tier: 1,
      ordinal: 1,
      name: 'Water',
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
    reg.save('Water', {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    const atom = L1Atom.fromType(
      {
        atomId: '00000000-0000-4000-8000-000000000001',
        tier: 1,
        ordinal: 1,
        name: 'Water',
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
    reg.save('Water', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    expect(reg.loadFor('Methane')).toEqual([]);
    // Water still has its skill on disk.
    expect(existsSync(join(dir, 'Water', 'x', 'SKILL.md'))).toBe(true);
  });
});

/**
 * A counter we cannot read is not a counter at zero.
 *
 * Every `_meta.json` write used to be a whole-object non-atomic
 * `writeFileSync`, so a crash mid-write left a torn file. `readMeta` then
 * answered 0/0, SILENTLY, and the next mutation persisted those fake zeroes —
 * months of earned trust replaced by a plausible number with no error and no
 * trace. All metadata writers now share one strict, atomic mutation path.
 */
describe('a torn _meta.json never becomes a confident zero', () => {
  let dir: string;
  let savedLedger: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-tornmeta-'));
    // Own ledger: the suite-wide default is shared, so a delta count taken
    // against it could be moved by another test file's writes.
    savedLedger = process.env['ATOMA_LEDGER_DB'];
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'store.db');
    closeLedgerHandles();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeLedgerHandles();
    if (savedLedger === undefined) delete process.env['ATOMA_LEDGER_DB'];
    else process.env['ATOMA_LEDGER_DB'] = savedLedger;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedAt(successes: number): { reg: SkillRegistry; metaPath: string } {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    for (let i = 0; i < successes; i++) reg.recordSuccess('Water', 'earned');
    return { reg, metaPath: join(dir, 'Water', 'earned', '_meta.json') };
  }

  function snapshotSkillTree(root: string): string[] {
    const snapshot: string[] = [];
    const walk = (current: string, prefix = ''): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          snapshot.push(`${relative}/`);
          walk(join(current, entry.name), relative);
        } else {
          snapshot.push(`${relative}\0${readFileSync(join(current, entry.name), 'utf8')}`);
        }
      }
    };
    walk(root);
    return snapshot;
  }

  it('refuses the bump instead of overwriting the earned counters with 1', () => {
    const { reg, metaPath } = seedAt(9);
    expect(reg.loadFor('Water')[0]!.successes).toBe(9);
    // Torn write: valid prefix, no closing brace — what a crash leaves.
    writeFileSync(metaPath, '{"successes": 9, "failures": 0, "updat', 'utf8');
    reg.recordSuccess('Water', 'earned');
    // The file is UNCHANGED, so the 9 are still recoverable by hand.
    expect(readFileSync(metaPath, 'utf8')).toBe('{"successes": 9, "failures": 0, "updat');
  });

  it('and records no ledger event for a bump that never landed', () => {
    const { reg, metaPath } = seedAt(3);
    writeFileSync(metaPath, 'not json at all', 'utf8');
    const before = readLedger().length;
    reg.recordSuccess('Water', 'earned');
    reg.recordFailure('Water', 'earned');
    expect(readLedger().length).toBe(before);
  });

  it('treats valid JSON with an invalid counter schema as corruption', () => {
    const { reg, metaPath } = seedAt(9);
    const malformed = JSON.stringify({
      successes: '9',
      failures: 0,
      updatedAt: '2026-08-14T00:00:00.000Z',
    });
    writeFileSync(metaPath, malformed, 'utf8');
    const before = readLedger().length;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reg.markMatched('Water', 'earned');

    expect(readFileSync(metaPath, 'utf8')).toBe(malformed);
    expect(readLedger().length).toBe(before);
  });

  it('replaces a valid sidecar atomically and leaves no temporary file behind', () => {
    const { reg, metaPath } = seedAt(2);
    const fd = openSync(metaPath, 'r');
    try {
      reg.markMatched('Water', 'earned');

      // An fd opened before rename still addresses the old inode. A direct
      // truncate/write would make this descriptor observe the new `matches`
      // field and therefore fail the incident regression.
      const replacedBytes = JSON.parse(readFileSync(fd, 'utf8')) as { matches?: number };
      const liveBytes = JSON.parse(readFileSync(metaPath, 'utf8')) as { matches?: number };
      expect(replacedBytes.matches).toBeUndefined();
      expect(liveBytes.matches).toBe(1);
      expect(
        readdirSync(join(dir, 'Water', 'earned')).filter(
          (name) => name.startsWith('_meta.json.') && name.endsWith('.tmp')
        )
      ).toEqual([]);
    } finally {
      closeSync(fd);
    }
  });

  type CorruptMutationCase = {
    name: string;
    prepare?: (reg: SkillRegistry) => void;
    run: (reg: SkillRegistry) => unknown;
    throws?: RegExp;
  };

  const corruptMutationCases: CorruptMutationCase[] = [
    {
      name: 'success and failure bumps',
      run: (reg) => {
        reg.recordSuccess('Water', 'earned');
        reg.recordFailure('Water', 'earned');
      },
    },
    { name: 'match tracking', run: (reg) => reg.markMatched('Water', 'earned') },
    { name: 'direct-failure tracking', run: (reg) => reg.markDirectFailure('Water', 'earned') },
    {
      name: 'promotion-refusal stamping',
      run: (reg) => reg.markPromotionRefused('Water', 'earned', 'not script-shaped', 'g2'),
    },
    {
      name: 'promotion-refusal clearing',
      prepare: (reg) => {
        reg.markPromotionRefused('Water', 'earned', 'not script-shaped', 'g1');
      },
      run: (reg) => reg.clearPromotionRefusal('Water', 'earned'),
    },
    {
      name: 'direct-failure clearing',
      prepare: (reg) => {
        reg.markDirectFailure('Water', 'earned');
      },
      run: (reg) => reg.clearDirectFailures('Water', 'earned'),
    },
    { name: 'operator counter reset', run: (reg) => reg.resetCounters('Water', 'earned') },
    {
      name: 'body save',
      run: (reg) =>
        reg.save('Water', {
          id: 'earned',
          description: 'changed',
          whenToUse: 'changed',
          kind: 'llm',
          body: 'changed',
        }),
      throws: /unreadable/,
    },
    {
      name: 'merge',
      prepare: (reg) => {
        reg.save('Water', {
          id: 'absorbed',
          description: 'absorbed',
          whenToUse: 'another case',
          kind: 'llm',
          body: 'absorbed body',
        });
      },
      run: (reg) => reg.merge('Water', 'earned', 'absorbed'),
    },
    {
      name: 'promotion',
      run: (reg) =>
        reg.promoteToScript({
          l1Name: 'Water',
          skillId: 'earned',
          language: 'node',
          scriptBody: 'console.log("compiled")',
        }),
      throws: /unreadable/,
    },
    {
      name: 'demotion',
      prepare: (reg) => {
        reg.promoteToScript({
          l1Name: 'Water',
          skillId: 'earned',
          language: 'node',
          scriptBody: 'console.log("compiled")',
        });
      },
      run: (reg) => reg.demoteToLlm('Water', 'earned'),
    },
  ];

  it.each(corruptMutationCases)(
    '$name leaves torn metadata, skill artefacts, and the ledger untouched',
    ({ prepare, run, throws }) => {
      const { reg, metaPath } = seedAt(9);
      prepare?.(reg);
      writeFileSync(metaPath, '{"successes": 9, "failures": 0, "updat', 'utf8');
      const beforeTree = snapshotSkillTree(join(dir, 'Water'));
      const beforeLedger = readLedger().length;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      if (throws) expect(() => run(reg)).toThrow(throws);
      else run(reg);

      expect(snapshotSkillTree(join(dir, 'Water'))).toEqual(beforeTree);
      expect(readLedger().length).toBe(beforeLedger);
    }
  );

  it('an ABSENT sidecar still initialises at zero — hand-written skills keep working', () => {
    const reg = new SkillRegistry(dir);
    mkdirSync(join(dir, 'Water', 'byhand'), { recursive: true });
    writeFileSync(
      join(dir, 'Water', 'byhand', 'SKILL.md'),
      '---\nname: byhand\ndescription: d\nwhen_to_use: w\nkind: llm\n---\nbody\n',
      'utf8'
    );
    reg.recordSuccess('Water', 'byhand');
    expect(reg.loadFor('Water').find((s) => s.id === 'byhand')!.successes).toBe(1);
  });
});
