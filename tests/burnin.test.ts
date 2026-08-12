import { describe, it, expect } from 'vitest';
import {
  parseRunLog,
  toCsvRow,
  summarize,
  looksLikeConfigFailure,
  looksLikeProviderLimitFailure,
  burninProviderInfo,
  CSV_HEADER,
} from '../src/cli/burnin.js';

// Trimmed from a real delivered run (colstat, run 9): the exact formatSummary
// shape the harness parses in production.
const DELIVERED_LOG = [
  '[Ammonia] skill matched: readme-from-verified-runs (kind=script; …)',
  '[Ammonia] skill readme-from-verified-runs ran via deterministic dispatch (0 LLM calls)',
  '[Ammonia] skill matched: reverify-cli-readme-invocations (kind=script; …)',
  '[Ammonia] skill reverify-cli-readme-invocations ran via deterministic dispatch (0 LLM calls)',
  'LLM usage:',
  'model                      calls  in     out    cache_read  cost_usd',
  '-------------------------  -----  -----  -----  ----------  --------',
  'claude-haiku-4-5-20251001  9      16109  16507  354102      0.1537  ',
  'claude-opus-5              1      2      1696   0           0.0719  ',
  '-------------------------  -----  -----  -----  ----------  --------',
  'TOTAL                      10     16111  18203  354102      0.2256  ',
  '',
  '✓ build finished. Any server the run started is still reachable inside the sandbox.',
].join('\n');

const FAILED_LOG = [
  '⏱ TIMEOUT after 900s — budget exhausted',
  '--- run failed ---',
  'model                      calls  in     out    cache_read  cost_usd',
  'claude-haiku-4-5-20251001  17     12721  62790  2792745     0.7868  ',
  'claude-sonnet-5            2      2      658    0           0.0177  ',
  'TOTAL                      20     12725  64189  2792745     0.8523  ',
].join('\n');

describe('burnin parseRunLog', () => {
  it('extracts economics + markers from a delivered run', () => {
    const s = parseRunLog(DELIVERED_LOG);
    expect(s.outcome).toBe('delivered');
    expect(s.costUsd).toBeCloseTo(0.2256, 4);
    expect(s.llmCalls).toBe(10);
    expect(s.opusCalls).toBe(1);
    expect(s.haikuCalls).toBe(9);
    expect(s.sonnetCalls).toBe(0);
    expect(s.otherCalls).toBe(0);
    expect(s.deterministicPhases).toBe(2);
    expect(s.learnedSkills).toBe(0);
    expect(s.promotions).toBe(0);
    expect(s.demotions).toBe(0);
  });

  it('classifies a timeout as failed and still reads its cost', () => {
    const s = parseRunLog(FAILED_LOG);
    expect(s.outcome).toBe('failed');
    expect(s.costUsd).toBeCloseTo(0.8523, 4);
    expect(s.sonnetCalls).toBe(2);
  });

  it('keeps cross-provider calls visible instead of losing them from O/S/H', () => {
    const s = parseRunLog(
      [
        'codex:gpt-5.6-sol          1      10  20  0  0.05',
        'codex:gpt-5.4-mini         1      10  20  0  0.04',
        'claude-haiku-4-5-20251001  3      10  20  0  0.01',
        'TOTAL                      5      30  60  0  0.10',
        '--- run failed ---',
      ].join('\n')
    );
    expect(s.llmCalls).toBe(5);
    expect(s.haikuCalls).toBe(3);
    expect(s.otherCalls).toBe(2);
  });

  it('counts lifecycle events: promotion, refusal, demotion, dispatch fallback', () => {
    // The curve must explain WHY a run cost what it cost: a compile, a
    // refusal, a demotion and a fallback all move the number.
    const s = parseRunLog(
      [
        'ℹ skill "x" promoted to kind:script (node, 8324 chars)',
        'ℹ skill "y" not promotable: irreducible reasoning',
        '⚠ script skill "z" demoted to llm after 2 consecutive deterministic failures',
        '[A] direct dispatch of z failed (exit=1) — falling back to the LLM loop',
        'ℹ [A] learned event skill "recover-x" for Lithium',
        'TOTAL  9  1  2  3  0.5000  ',
        '✓ build finished',
      ].join('\n')
    );
    expect(s.promotions).toBe(1);
    expect(s.refusals).toBe(1);
    expect(s.demotions).toBe(1);
    expect(s.dispatchFallbacks).toBe(1);
    expect(s.learnedEventSkills).toBe(1);
  });

  it('a killed/empty log degrades to error with null economics, not a crash', () => {
    const s = parseRunLog('npm ERR! something exploded');
    expect(s.outcome).toBe('error');
    expect(s.costUsd).toBeNull();
    expect(s.llmCalls).toBeNull();
  });
});

describe('burnin looksLikeConfigFailure — abort-the-batch guard', () => {
  it('flags an instant zero-spend failure (dead key signature, observed live)', () => {
    const s = parseRunLog('--- run failed ---\nTOTAL  2  4  0  0  0.0000  ');
    expect(looksLikeConfigFailure(s, 1)).toBe(true);
  });

  it('does NOT flag a real failure that spent real money over real time', () => {
    const s = parseRunLog(FAILED_LOG);
    expect(looksLikeConfigFailure(s, 902)).toBe(false);
  });

  it('does NOT flag a fast cheap DELIVERED run (mature families are supposed to be fast)', () => {
    const s = parseRunLog(DELIVERED_LOG);
    expect(looksLikeConfigFailure(s, 12)).toBe(false);
  });

  it('detects a definitive weekly limit even after calls already spent tokens', () => {
    const log =
      'TOTAL 11 15183 3933 102347 0.1513\n' +
      "no JSON found in response: You've hit your weekly limit · resets Aug 13 at 10pm";
    expect(looksLikeProviderLimitFailure(log)).toBe(true);
  });

  it('detects quota/credit exhaustion but not a transient rate-limit message', () => {
    expect(looksLikeProviderLimitFailure('quota has been exceeded for this account')).toBe(true);
    expect(looksLikeProviderLimitFailure('credit balance is too low')).toBe(true);
    expect(looksLikeProviderLimitFailure('this model requires a subscription, upgrade for access')).toBe(
      true
    );
    expect(looksLikeProviderLimitFailure('HTTP 429 rate limit; retry after 5 seconds')).toBe(false);
    expect(
      looksLikeProviderLimitFailure(
        'artefact output: Upgrade for access\n✓ build finished. Any server is reachable'
      )
    ).toBe(false);
  });
});

describe('burnin provider attribution', () => {
  it('canonicalizes aliases and includes routed providers', () => {
    expect(burninProviderInfo({ ATOMA_LLM: 'ANTHROPIC' })).toEqual({
      base: 'anthropic',
      routes: [],
      label: 'anthropic',
      estimatedCost: false,
    });
    expect(
      burninProviderInfo({
        ATOMA_LLM: 'claude',
        ATOMA_MODEL_L2: 'codex:gpt-5.4-mini',
        ATOMA_MODEL_L3: 'codex:gpt-5.6-sol',
      })
    ).toEqual({
      base: 'claude-cli',
      routes: ['codex'],
      label: 'claude-cli+codex',
      estimatedCost: true,
    });
  });
});

describe('burnin CSV + summary', () => {
  it('emits one CSV cell per header column', () => {
    const row = toCsvRow({
      ts: '2026-08-02T10:00:00.000Z',
      taskId: 'cli-x',
      family: 'cli',
      stats: parseRunLog(DELIVERED_LOG),
      durationS: 201,
      trace: 'r.json',
      provider: 'claude-cli',
    });
    expect(row.split(',')).toHaveLength(CSV_HEADER.split(',').length);
    expect(row).toContain('delivered');
    expect(row).toContain('0.2256');
    expect(row).toContain(',r.json,claude-cli,0');
  });

  it('summarize aggregates per family with delivery rate and mean cost', () => {
    const out = summarize([
      { family: 'cli', outcome: 'delivered', costUsd: 0.2 },
      { family: 'cli', outcome: 'delivered', costUsd: 0.3 },
      { family: 'web', outcome: 'failed', costUsd: 0.8 },
      { family: 'web', outcome: 'delivered', costUsd: null },
    ]);
    expect(out).toMatch(/cli\s+2\s+2\s+0\.2500/);
    expect(out).toMatch(/web\s+2\s+1\s+0\.8000/);
  });
});
