import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  IMPORTED_META_FILENAME,
  LEGACY_META_FILENAME,
  SkillRegistry,
  parseFrontmatter,
  renderFrontmatter,
  writeMetaAtomic,
  REFUSAL_REASON_MAX_CHARS,
} from '../src/skills/registry.js';
import { readMetaRow } from '../src/skills/metaStore.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { closeLedgerHandles, openLedgerHandle, projectCounters, readLedger } from '../src/core/ledger.js';

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

  it('seeds a trust row on first bump for a hand-written skill (no save() pre-call)', async () => {
    // Reproduces the live regression: a SKILL.md created via a
    // shell heredoc (no SkillRegistry.save call) had no counter record,
    // so the first recordSuccess no-op'd and the counter never
    // accumulated. The first bump seeds the record lazily — a row in the
    // store since W4, never a sidecar file.
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
    expect(exists(join(skillDir, LEGACY_META_FILENAME))).toBe(false);
    reg.recordSuccess('Water', 'hand-written');
    expect(exists(join(skillDir, LEGACY_META_FILENAME))).toBe(false);
    expect(readMetaRow(openLedgerHandle(process.env['ATOMA_LEDGER_DB']!), 'Water', 'hand-written')).toMatchObject({ successes: 1, failures: 0 });
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
    // `name:` (parseFrontmatter accepts `id:` as an alias on read).
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
      // And the reset is in the STORE, not just in the returned object.
      expect(reg.loadFor('Methane').find((s) => s.id === 'scaffold-node-ssr')!.successes).toBe(0);

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
      // A reason-less stamp (no reason supplied, empty Sonnet reason) stays valid
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

  it('returns [] when no SkillRegistry is passed to fromType', () => {
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
      consecutiveSuccesses: 0,
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(atom.skills()).toEqual([]);
  });

  it('hydrates skills() from the registry when one is provided', () => {
    const type = {
      atomId: '00000000-0000-4000-8000-000000000001',
      tier: 1 as const,
      ordinal: 1,
      name: 'Water',
      description: 'd',
      systemPrompt: 'sys',
      tools: [],
      params: {},
      version: 1,
      successes: 0,
      failures: 0,
      consecutiveSuccesses: 0,
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    reg.save(type.atomId, {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    const atom = L1Atom.fromType(type, undefined, reg);
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
 * A counter we cannot read is not a counter at zero — and since W4 a counter
 * lives in a store row that cannot be torn.
 *
 * The sidecar era: every `_meta.json` write was a whole-object non-atomic
 * `writeFileSync`, a crash mid-write left a torn file, `readMeta` answered
 * 0/0 SILENTLY, and the next mutation persisted those fake zeroes — months of
 * earned trust replaced by a plausible number with no error and no trace.
 * Two things survive the move to rows: a torn LEGACY sidecar is never
 * imported (every mutation refuses, writes nothing, journals nothing), and
 * once a row exists the sidecar is evidence, not a source. What is new is
 * what a row makes possible: the counter and its event are one transaction,
 * and a folder that outlives its row can never carry trust it did not earn.
 */
describe('trust in the store: legacy sidecars, one transaction, body-bound rows', () => {
  let dir: string;
  let savedLedger: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-tornmeta-'));
    // Own store: the delta counts below must not be moved by another test.
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

  const store = (): Database.Database => openLedgerHandle(process.env['ATOMA_LEDGER_DB']!);

  /** A hand-written body with a LEGACY sidecar and no row: a tree from before the move. */
  function legacySkill(successes: number, sidecar?: string): { reg: SkillRegistry; metaPath: string } {
    const skillDir = join(dir, 'Water', 'earned');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: earned\ndescription: d\nwhen_to_use: w\nkind: llm\n---\nbody\n',
      'utf8'
    );
    const metaPath = join(skillDir, LEGACY_META_FILENAME);
    if (sidecar !== undefined) writeFileSync(metaPath, sidecar, 'utf8');
    else writeMetaAtomic(metaPath, { successes, failures: 0, updatedAt: '2026-09-10T00:00:00.000Z' });
    return { reg: new SkillRegistry(dir), metaPath };
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

  it('imports a readable legacy sidecar ONCE, on the first mutation, and retires it as evidence', () => {
    const { reg, metaPath } = legacySkill(5);
    const original = readFileSync(metaPath, 'utf8');
    // Before any write, a reader sees the sidecar's counters.
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 5, failures: 0 });
    reg.recordSuccess('Water', 'earned');
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 6, failures: 0 });
    expect(readMetaRow(store(), 'Water', 'earned')).toMatchObject({ successes: 6 });
    // The file is renamed, not rewritten: same bytes, never a source again.
    expect(existsSync(metaPath)).toBe(false);
    expect(readFileSync(join(dir, 'Water', 'earned', IMPORTED_META_FILENAME), 'utf8')).toBe(original);
    // A second mutation adds to the row; nothing re-imports.
    reg.recordFailure('Water', 'earned');
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 6, failures: 1 });
  });

  it('refuses every mutation on a torn legacy sidecar: no row, no event, bytes untouched', () => {
    const torn = '{"successes": 9, "failures": 0, "updat';
    const { reg, metaPath } = legacySkill(0, torn);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = readLedger().length;
    reg.recordSuccess('Water', 'earned');
    reg.recordFailure('Water', 'earned');
    expect(readFileSync(metaPath, 'utf8')).toBe(torn);
    expect(readMetaRow(store(), 'Water', 'earned')).toBeNull();
    expect(readLedger().length).toBe(before);
    // The tolerant reader still shows the body, at zero, and says so once.
    expect(reg.loadFor('Water')[0]).toMatchObject({ id: 'earned', successes: 0, failures: 0 });
  });

  it('treats valid JSON with an invalid counter schema as corruption', () => {
    const malformed = JSON.stringify({ successes: '9', failures: 0, updatedAt: '2026-08-14T00:00:00.000Z' });
    const { reg, metaPath } = legacySkill(0, malformed);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = readLedger().length;
    reg.markMatched('Water', 'earned');
    expect(readFileSync(metaPath, 'utf8')).toBe(malformed);
    expect(readMetaRow(store(), 'Water', 'earned')).toBeNull();
    expect(readLedger().length).toBe(before);
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
    { name: 'promotion-refusal clearing', run: (reg) => reg.clearPromotionRefusal('Water', 'earned') },
    { name: 'direct-failure clearing', run: (reg) => reg.clearDirectFailures('Water', 'earned') },
    { name: 'operator counter reset', run: (reg) => reg.resetCounters('Water', 'earned') },
    {
      name: 'counter compensation',
      run: (reg) => reg.compensateCounters('Water', 'earned', { successes: -1, reason: 'test' }),
    },
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
      prepare: () => {
        // A script body with a fallback, as promotion would have left them.
        writeFileSync(
          join(dir, 'Water', 'earned', 'SKILL.md'),
          '---\nname: earned\ndescription: d\nwhen_to_use: w\nkind: script\nlanguage: node\n---\nconsole.log(1)\n',
          'utf8'
        );
        writeFileSync(join(dir, 'Water', 'earned', '_fallback.md'), 'the llm body\n', 'utf8');
      },
      run: (reg) => reg.demoteToLlm('Water', 'earned'),
    },
  ];

  it.each(corruptMutationCases)(
    '$name on a torn legacy sidecar leaves the tree, the store and the ledger untouched',
    ({ prepare, run, throws }) => {
      const { reg } = legacySkill(0, '{"successes": 9, "failures": 0, "updat');
      prepare?.(reg);
      const beforeTree = snapshotSkillTree(join(dir, 'Water'));
      const beforeLedger = readLedger().length;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      if (throws) expect(() => run(reg)).toThrow(throws);
      else run(reg);

      expect(snapshotSkillTree(join(dir, 'Water'))).toEqual(beforeTree);
      expect(readLedger().length).toBe(beforeLedger);
      expect(readMetaRow(store(), 'Water', 'earned')).toBeNull();
    }
  );

  it('a row, once present, is the truth: a sidecar written beside it later is never read', () => {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    for (let i = 0; i < 9; i++) reg.recordSuccess('Water', 'earned');
    const metaPath = join(dir, 'Water', 'earned', LEGACY_META_FILENAME);
    writeFileSync(metaPath, '{"successes": 1, "failures": 0, "updat', 'utf8');
    reg.recordSuccess('Water', 'earned');
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 10, failures: 0 });
    expect(readFileSync(metaPath, 'utf8')).toBe('{"successes": 1, "failures": 0, "updat');
  });

  it('the counter and its event are one transaction; a positive bump is fail-open, a compensation fail-closed', () => {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    for (let i = 0; i < 3; i++) reg.recordSuccess('Water', 'earned');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = store();
    db.exec(`CREATE TRIGGER refuse_events BEFORE INSERT ON lifecycle_events
             BEGIN SELECT RAISE(ABORT, 'ledger refused'); END`);
    try {
      // A lost POSITIVE increment leaves the store ABOVE the ledger, the
      // direction `check` tolerates: the counter commits, the event is lost
      // and reported once, the run is never taken down (AtomRegistry's rule).
      reg.recordSuccess('Water', 'earned');
      expect(reg.loadFor('Water')[0]!.successes).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);
      // A NEGATIVE delta inverts the safe-loss direction, so it fails closed:
      // the same transaction rolls the counter back with the refused event.
      expect(() =>
        reg.compensateCounters('Water', 'earned', { successes: -2, reason: 'misattributed' })
      ).toThrow(/ledger refused/);
      expect(reg.loadFor('Water')[0]!.successes).toBe(4);
    } finally {
      db.exec('DROP TRIGGER refuse_events');
    }
    expect(readLedger().filter((e) => e.kind === 'skill-success')).toHaveLength(3);
    expect(readLedger().some((e) => e.kind === 'skill-counter-compensation')).toBe(false);
  });

  it('refuses to run inside a caller transaction, where .immediate() would silently become a savepoint', () => {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    const db = store();
    expect(() => db.transaction(() => reg.recordSuccess('Water', 'earned'))()).toThrow(/immediate transaction/);
    expect(reg.loadFor('Water')[0]!.successes).toBe(0);
  });

  it('a body that outlives its row never inherits trust: a creating save zeroes the row and the projection', () => {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    for (let i = 0; i < 5; i++) reg.recordSuccess('Water', 'earned');
    // The crash window of `drop`: the folder is gone, the row is not — the
    // orphan a racing run's credit can leave too.
    rmSync(join(dir, 'Water', 'earned'), { recursive: true, force: true });
    expect(readMetaRow(store(), 'Water', 'earned')).toMatchObject({ successes: 5 });
    // A run re-learns a recipe under the same id: a body that did not exist
    // earned nothing.
    const created = reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'new body' });
    expect(created).toMatchObject({ successes: 0, failures: 0 });
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 0, failures: 0 });
    // …and the ledger agrees, so `check` does not read a false IMPOSSIBLE.
    expect(projectCounters(readLedger()).get('Water/earned')).toEqual({ successes: 0, failures: 0 });
    // A REWRITE of an existing body keeps what it earned.
    reg.recordSuccess('Water', 'earned');
    reg.save('Water', { id: 'earned', description: 'd2', whenToUse: 'w', kind: 'llm', body: 'revised' });
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 1, failures: 0 });
  });

  it('drop and merge delete the row with the folder, and the projection follows', () => {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    reg.save('Water', { id: 'other', description: 'd', whenToUse: 'x', kind: 'llm', body: 'c' });
    reg.recordSuccess('Water', 'earned');
    reg.recordSuccess('Water', 'other');
    reg.recordSuccess('Water', 'other');
    expect(reg.drop('Water', 'other')).toBe(true);
    expect(readMetaRow(store(), 'Water', 'other')).toBeNull();
    expect(projectCounters(readLedger()).get('Water/other')).toEqual({ successes: 0, failures: 0 });
    reg.save('Water', { id: 'twin', description: 'd', whenToUse: 'y', kind: 'llm', body: 'e' });
    reg.recordFailure('Water', 'twin');
    expect(reg.merge('Water', 'earned', 'twin')).toMatchObject({ id: 'earned', successes: 1, failures: 0 });
    expect(readMetaRow(store(), 'Water', 'twin')).toBeNull();
    expect(projectCounters(readLedger()).get('Water/twin')).toEqual({ successes: 0, failures: 0 });
    expect(projectCounters(readLedger()).get('Water/earned')).toEqual({ successes: 1, failures: 0 });
  });

  it('a read-only handle on a store from before the table reads the legacy sidecars and never writes', () => {
    const { metaPath } = legacySkill(7);
    const snapshot = join(dir, 'snapshot.db');
    new Database(snapshot).close(); // a store with no skill_meta table
    const ro = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      const reader = new SkillRegistry(dir, { db: ro });
      expect(reader.loadFor('Water')[0]).toMatchObject({ successes: 7, failures: 0 });
      expect(ro.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'skill_meta'`).get()).toBeUndefined();
      expect(existsSync(metaPath)).toBe(true);
    } finally {
      ro.close();
    }
  });

  it('re-resolves its default store on every call, so a repointed environment is honoured mid-life', () => {
    const reg = new SkillRegistry(dir);
    reg.save('Water', { id: 'earned', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    reg.recordSuccess('Water', 'earned');
    closeLedgerHandles();
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'elsewhere.db');
    // A fresh store: no row, no sidecar — the body reads at zero and the
    // next bump seeds there, on the same instance.
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 0 });
    reg.recordSuccess('Water', 'earned');
    expect(reg.loadFor('Water')[0]).toMatchObject({ successes: 1 });
  });

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
