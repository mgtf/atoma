import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry } from '../src/skills/registry.js';
import {
  UNDER_MATCHED_RATIO,
  UNDER_MATCHED_SIBLING_FLOOR,
  computeStatsRows,
  isUnderMatched,
  jaccard,
  matchSurfaceTokens,
  similarityPairs,
  skillStatus,
} from '../src/skills/stats.js';
import type { Skill } from '../src/skills/types.js';

/**
 * `skills stats` + catalog-hygiene verbs (drop/merge) + the match-history
 * counter they read. The utility signal is CODESKILL/AWM-inspired:
 * matches vs driven runs exposes free-riders and never-picked skills;
 * matching-surface overlap exposes merge candidates.
 */

const OPTS = { trust: 3, promote: 5, stampIsCurrent: (g: string | undefined) => g === 'GEN-NOW' };

function fakeSkill(over: Partial<Skill>): Skill {
  return {
    id: 'x',
    description: 'd',
    whenToUse: 'w',
    kind: 'llm',
    body: 'b',
    successes: 0,
    failures: 0,
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...over,
  };
}

describe('SkillRegistry.markMatched — match history', () => {
  let dir: string;
  let reg: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-matches-'));
    reg = new SkillRegistry(dir);
    reg.save('Hydrogen', { id: 'r', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('increments matches and stamps lastMatchedAt', () => {
    reg.markMatched('Hydrogen', 'r');
    reg.markMatched('Hydrogen', 'r');
    const s = reg.loadFor('Hydrogen')[0]!;
    expect(s.matches).toBe(2);
    expect(s.lastMatchedAt).toBeTruthy();
  });

  it('no-ops on a missing skill', () => {
    reg.markMatched('Hydrogen', 'ghost');
    expect(reg.loadFor('Hydrogen')[0]!.matches).toBeUndefined();
  });

  it('survives counter bumps and body saves; zeroed by resetCounters', () => {
    reg.markMatched('Hydrogen', 'r');
    reg.recordSuccess('Hydrogen', 'r');
    expect(reg.loadFor('Hydrogen')[0]!.matches).toBe(1);
    reg.save('Hydrogen', { id: 'r', description: 'd2', whenToUse: 'w2', kind: 'llm', body: 'b2' });
    expect(reg.loadFor('Hydrogen')[0]!.matches).toBe(1);
    reg.resetCounters('Hydrogen', 'r');
    expect(reg.loadFor('Hydrogen')[0]!.matches).toBeUndefined();
  });
});

describe('SkillRegistry.drop', () => {
  it('deletes the skill folder and reports success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-drop-'));
    const reg = new SkillRegistry(dir);
    reg.save('Hydrogen', { id: 'debris', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    expect(reg.drop('Hydrogen', 'debris')).toBe(true);
    expect(reg.loadFor('Hydrogen')).toEqual([]);
    expect(existsSync(join(dir, 'Hydrogen', 'debris'))).toBe(false);
    expect(reg.drop('Hydrogen', 'debris')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SkillRegistry.merge — routing-surface absorption', () => {
  let dir: string;
  let reg: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-merge-'));
    reg = new SkillRegistry(dir);
    reg.save('Hydrogen', {
      id: 'keeper',
      description: 'build a node CLI with README',
      whenToUse: 'when the task is a node CLI tool',
      kind: 'llm',
      body: 'KEEPER BODY',
    });
    reg.save('Hydrogen', {
      id: 'dupe',
      description: 'scaffold a node command-line tool',
      whenToUse: 'when the user wants a command-line utility',
      kind: 'llm',
      body: 'DUPE BODY',
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeper absorbs when_to_use, keeps body and counters; absorbed skill deleted', () => {
    reg.recordSuccess('Hydrogen', 'keeper');
    reg.recordSuccess('Hydrogen', 'keeper');
    reg.recordSuccess('Hydrogen', 'dupe');

    const merged = reg.merge('Hydrogen', 'keeper', 'dupe')!;
    expect(merged.body).toBe('KEEPER BODY');
    expect(merged.whenToUse).toBe(
      'when the task is a node CLI tool; also: when the user wants a command-line utility'
    );
    // Keeper's counters preserved (its body did not change), absorbed
    // counters die with the absorbed body — never summed.
    expect(merged.successes).toBe(2);
    expect(reg.loadFor('Hydrogen').map((s) => s.id)).toEqual(['keeper']);
  });

  it('preserves the keeper promotion-refusal stamp (body unchanged — no save() route)', () => {
    reg.markPromotionRefused('Hydrogen', 'keeper', 'irreducible', 'gen-x');
    reg.merge('Hydrogen', 'keeper', 'dupe');
    const s = reg.loadFor('Hydrogen')[0]!;
    expect(s.promotionRefusedAt).toBeTruthy();
    expect(s.promotionRefusedGeneration).toBe('gen-x');
  });

  it('returns null on identical ids or a missing side', () => {
    expect(reg.merge('Hydrogen', 'keeper', 'keeper')).toBeNull();
    expect(reg.merge('Hydrogen', 'keeper', 'ghost')).toBeNull();
    expect(reg.merge('Hydrogen', 'ghost', 'dupe')).toBeNull();
  });
});

describe('skillStatus — lifecycle labels', () => {
  it('flags utility-zero and free-riding skills', () => {
    expect(skillStatus(fakeSkill({}), OPTS)).toContain('never-matched');
    expect(skillStatus(fakeSkill({ matches: 4 }), OPTS)).toContain('matched-never-drove');
  });

  it('llm lifecycle: promotion distance, eligibility, refusal freshness', () => {
    expect(skillStatus(fakeSkill({ successes: 3, matches: 3 }), OPTS)).toContain('promotion-in-2');
    expect(skillStatus(fakeSkill({ successes: 5, matches: 5 }), OPTS)).toContain('promotion-eligible');
    expect(
      skillStatus(
        fakeSkill({ successes: 5, matches: 5, promotionRefusedAt: 'ts', promotionRefusedGeneration: 'GEN-NOW' }),
        OPTS
      )
    ).toContain('refused(current-gen)');
    expect(
      skillStatus(
        fakeSkill({ successes: 5, matches: 5, promotionRefusedAt: 'ts', promotionRefusedGeneration: 'GEN-OLD' }),
        OPTS
      )
    ).toContain('refusal-stale(will-retry)');
    expect(skillStatus(fakeSkill({ failures: 1, matches: 1 }), OPTS)).toContain('blocked(reset)');
  });

  it('script lifecycle: trust distance, dispatch, direct failures', () => {
    expect(
      skillStatus(fakeSkill({ kind: 'script', language: 'node', successes: 1, matches: 1 }), OPTS)
    ).toContain('trust-in-2');
    expect(
      skillStatus(fakeSkill({ kind: 'script', language: 'node', successes: 3, matches: 3 }), OPTS)
    ).toContain('zero-llm-dispatch');
    expect(
      skillStatus(
        fakeSkill({ kind: 'script', language: 'node', successes: 3, matches: 3, directFailures: 1 }),
        OPTS
      )
    ).toContain('direct✗1');
  });
});

describe('computeStatsRows — free-ride gap', () => {
  it('computes matches minus driven runs, floored at zero', () => {
    const byL1 = new Map([
      [
        'Hydrogen',
        [
          fakeSkill({ id: 'rider', matches: 5, successes: 1, failures: 0 }),
          fakeSkill({ id: 'legacy', successes: 2 }), // pre-matches era: no matches recorded
        ],
      ],
    ]);
    const rows = computeStatsRows(byL1, OPTS);
    expect(rows.find((r) => r.id === 'rider')!.freeRides).toBe(4);
    expect(rows.find((r) => r.id === 'legacy')!.freeRides).toBe(0);
  });
});

describe('similarityPairs — merge candidates', () => {
  it('jaccard over the matching surface', () => {
    const a = matchSurfaceTokens({ description: 'build node cli tool', whenToUse: 'cli tasks' });
    const b = matchSurfaceTokens({ description: 'build node cli utility', whenToUse: 'cli tasks' });
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, b)).toBeGreaterThan(0.5);
    expect(jaccard(a, new Set())).toBe(0);
  });

  it('reports same-L1 pairs above the threshold only, highest first', () => {
    const nearDupA = fakeSkill({
      id: 'a',
      description: 'scaffold a node command line tool with tests',
      whenToUse: 'when building a node cli tool',
    });
    const nearDupB = fakeSkill({
      id: 'b',
      description: 'scaffold a node command line utility with tests',
      whenToUse: 'when building a node cli utility',
    });
    const unrelated = fakeSkill({
      id: 'c',
      description: 'validate an html page with a headless browser smoke expression',
      whenToUse: 'when the deliverable renders in a browser',
    });
    const byL1 = new Map([['Hydrogen', [nearDupA, nearDupB, unrelated]]]);
    const pairs = similarityPairs(byL1, 0.5);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a, pairs[0]!.b].sort()).toEqual(['a', 'b']);
    // Same skills on DIFFERENT L1s never pair — namespaces don't compete.
    const split = new Map([
      ['Hydrogen', [nearDupA]],
      ['Lithium', [nearDupB]],
    ]);
    expect(similarityPairs(split, 0.5)).toHaveLength(0);
  });
});

describe('under-matched — a compilable recipe the prefilter rarely picks', () => {
  const PROMOTE = 3;
  const busy = fakeSkill({ id: 'build-sibling', matches: 15, successes: 15 });
  const check = (s: Skill, sibs: Skill[]) => isUnderMatched(s, sibs, PROMOTE);

  it('flags the real measured case: 2 matches beside a sibling at 15', () => {
    // The exact numbers from the 2026-08-10 benchmark casualties.
    const victim = fakeSkill({ id: 'verify-from-disk-state', matches: 2, successes: 2 });
    expect(check(victim, [victim, busy])).toBe(true);
  });

  it('does NOT flag a quiet namespace — nothing has run yet is not a rate problem', () => {
    const a = fakeSkill({ id: 'a', matches: 0 });
    const b = fakeSkill({ id: 'b', matches: 4 });
    expect(check(a, [a, b])).toBe(false);
  });

  it('does NOT flag a recipe that already cleared the promote threshold', () => {
    // Past it the match rate no longer gates anything — it can compile.
    const mature = fakeSkill({ id: 'm', matches: 2, successes: PROMOTE });
    expect(check(mature, [mature, busy])).toBe(false);
  });

  it('does NOT flag a merely-less-popular recipe (5 vs 15 is a third, not a seventh)', () => {
    const healthy = fakeSkill({ id: 'h', matches: 5, successes: 2 });
    expect(check(healthy, [healthy, busy])).toBe(false);
  });

  it('does NOT flag an event skill: it is matched mechanically, not by the prefilter', () => {
    const ev = fakeSkill({ id: 'recover-x', matches: 0, trigger: 'a failure signature' });
    expect(check(ev, [ev, busy])).toBe(false);
  });

  it('does not let a busy EVENT sibling manufacture a phantom rate problem', () => {
    const victim = fakeSkill({ id: 'v', matches: 0 });
    const evBusy = fakeSkill({ id: 'e', matches: 50, trigger: 'sig' });
    expect(check(victim, [victim, evBusy])).toBe(false);
  });

  it('never compares a skill against itself', () => {
    const solo = fakeSkill({ id: 'solo', matches: UNDER_MATCHED_SIBLING_FLOOR, successes: 0 });
    expect(check(solo, [solo])).toBe(false);
  });

  it('the ratio constant is what decides the boundary', () => {
    const atBoundary = fakeSkill({ id: 'b1', matches: 15 / UNDER_MATCHED_RATIO, successes: 0 });
    const justOver = fakeSkill({ id: 'b2', matches: 15 / UNDER_MATCHED_RATIO + 1, successes: 0 });
    expect(check(atBoundary, [atBoundary, busy])).toBe(true);
    expect(check(justOver, [justOver, busy])).toBe(false);
  });

  it('surfaces the flag in the rendered status row, and only on the victim', () => {
    const victim = fakeSkill({ id: 'v', matches: 2, successes: 2 });
    const rows = computeStatsRows(new Map([['Lithium', [victim, busy]]]), OPTS);
    expect(rows.find((r) => r.id === 'v')!.status).toContain('under-matched');
    expect(rows.find((r) => r.id === 'build-sibling')!.status).not.toContain('under-matched');
  });
});
