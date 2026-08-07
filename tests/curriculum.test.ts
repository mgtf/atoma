import { describe, it, expect } from 'vitest';
import {
  buildCurriculumUserContent,
  CURRICULUM_SYSTEM_PROMPT,
  DEFAULT_TARGET_CAP,
  parseBurninCsvFamilies,
  parseCurriculumTasks,
  selectCurriculumTargets,
} from '../src/cli/curriculum.js';
import type { Skill } from '../src/skills/types.js';

/**
 * Curriculum generator (Voyager's curriculum mapped onto atoma's
 * lifecycle counters): selection is pure code over the skill store +
 * burn-in CSV; only the task-statement generation is an LLM call. These
 * tests drive the pure helpers — the LLM slot is exercised through the
 * tolerant parser.
 */

const GEN = { trust: 3, promote: 5, stampIsCurrent: (g: string | undefined) => g === 'GEN-NOW' };

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

describe('selectCurriculumTargets', () => {
  it('categorises: script-maturation, stale-refusal-retry, promotion-push, failed-family', () => {
    const byL1 = new Map([
      [
        'Hydrogen',
        [
          fakeSkill({ id: 'fresh-script', kind: 'script', language: 'node', successes: 1 }),
          fakeSkill({
            id: 'stale-stamp',
            successes: 5,
            promotionRefusedAt: 'ts',
            promotionRefusedGeneration: 'GEN-OLD',
          }),
          fakeSkill({ id: 'nearly-there', successes: 4 }),
        ],
      ],
    ]);
    const targets = selectCurriculumTargets({
      byL1,
      ...GEN,
      failedFamilies: [{ family: 'cli', failed: 2, total: 5 }],
    });
    expect(targets.map((t) => t.category)).toEqual([
      'script-maturation',
      'stale-refusal-retry',
      'promotion-push',
      'failed-family-retry',
    ]);
    expect(targets[0]!.skillId).toBe('fresh-script');
    expect(targets[0]!.hint).toMatch(/2 more clean validated run/);
    expect(targets[2]!.hint).toMatch(/1 clean success\(es\) from the llm→script compile/);
    expect(targets[3]!.family).toBe('cli');
  });

  it('skips blocked skills (failures > 0), refused-current-gen, and never-driven llm skills', () => {
    const byL1 = new Map([
      [
        'Hydrogen',
        [
          fakeSkill({ id: 'blocked', successes: 4, failures: 1 }),
          fakeSkill({
            id: 'refused-now',
            successes: 5,
            promotionRefusedAt: 'ts',
            promotionRefusedGeneration: 'GEN-NOW',
          }),
          fakeSkill({ id: 'unproven', successes: 0 }),
          fakeSkill({ id: 'trusted-script', kind: 'script', language: 'node', successes: 3 }),
        ],
      ],
    ]);
    expect(selectCurriculumTargets({ byL1, ...GEN })).toEqual([]);
  });

  it('orders by category priority then distance, and caps the batch', () => {
    const byL1 = new Map([
      [
        'Hydrogen',
        [
          fakeSkill({ id: 'push-far', successes: 1 }),
          fakeSkill({ id: 'push-near', successes: 4 }),
          fakeSkill({ id: 'script-near', kind: 'script', language: 'node', successes: 2 }),
        ],
      ],
    ]);
    const all = selectCurriculumTargets({ byL1, ...GEN });
    expect(all.map((t) => t.skillId)).toEqual(['script-near', 'push-near', 'push-far']);
    const capped = selectCurriculumTargets({ byL1, ...GEN, cap: 2 });
    expect(capped).toHaveLength(2);
    expect(selectCurriculumTargets({ byL1, ...GEN }).length).toBeLessThanOrEqual(DEFAULT_TARGET_CAP);
  });
});

describe('parseBurninCsvFamilies', () => {
  it('aggregates totals and failures per family, skipping malformed rows', () => {
    const csv = [
      'timestamp,task_id,family,outcome,cost_usd',
      '2026-08-01T00:00:00Z,t1,cli,delivered,0.05',
      '2026-08-01T01:00:00Z,t2,cli,failed,0.12',
      '2026-08-01T02:00:00Z,t3,web,delivered,0.03',
      'garbage-line',
      '',
    ].join('\n');
    expect(parseBurninCsvFamilies(csv)).toEqual([
      { family: 'cli', failed: 1, total: 2 },
      { family: 'web', failed: 0, total: 1 },
    ]);
  });
});

describe('curriculum prompt', () => {
  it('demands novel, small, framework-blind goals as pure JSON', () => {
    expect(CURRICULUM_SYSTEM_PROMPT).toMatch(/NOVEL theme/);
    expect(CURRICULUM_SYSTEM_PROMPT).toMatch(/NEVER name the skill, the framework/);
    expect(CURRICULUM_SYSTEM_PROMPT).toMatch(/"tasks"/);
    const user = buildCurriculumUserContent(
      [
        { category: 'promotion-push', l1: 'Hydrogen', skillId: 's', hint: 'HINT-A' },
        { category: 'failed-family-retry', l1: '', family: 'cli', hint: 'HINT-B' },
      ],
      ['cli', 'web']
    );
    expect(user).toMatch(/Known families: cli, web/);
    expect(user).toMatch(/exactly 2 task\(s\)/);
    expect(user).toMatch(/1\. \[promotion-push\] HINT-A/);
    expect(user).toMatch(/2\. \[failed-family-retry\] HINT-B/);
  });
});

describe('parseCurriculumTasks — tolerant response parse', () => {
  const FAMILIES = ['cli', 'web'];

  it('parses fenced JSON, slugifies ids, defaults unknown families', () => {
    const text = [
      'Here are the tasks:',
      '```json',
      JSON.stringify({
        tasks: [
          { id: 'Build a Thing!', family: 'cli', goal: 'Build a word-frequency CLI.' },
          { family: 'nope', goal: 'A tiny pomodoro web page.' },
        ],
      }),
      '```',
    ].join('\n');
    const tasks = parseCurriculumTasks(text, FAMILIES);
    expect(tasks).toEqual([
      { id: 'build-a-thing', family: 'cli', goal: 'Build a word-frequency CLI.' },
      { id: 'a-tiny-pomodoro-web-page', family: 'cli', goal: 'A tiny pomodoro web page.' },
    ]);
  });

  it('de-duplicates ids and skips entries without a goal', () => {
    const text = JSON.stringify({
      tasks: [
        { id: 'same', family: 'cli', goal: 'g1' },
        { id: 'same', family: 'cli', goal: 'g2' },
        { id: 'no-goal', family: 'cli' },
        'not-an-object',
      ],
    });
    const tasks = parseCurriculumTasks(text, FAMILIES);
    expect(tasks.map((t) => t.id)).toEqual(['same', 'same-2']);
  });

  it('returns [] on unparseable or shapeless responses', () => {
    expect(parseCurriculumTasks('sorry, no can do', FAMILIES)).toEqual([]);
    expect(parseCurriculumTasks('{"nope": 1}', FAMILIES)).toEqual([]);
  });
});
