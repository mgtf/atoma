import { describe, it, expect } from 'vitest';
import { parseRunLog, toCsvRow, summarize, CSV_HEADER } from '../src/cli/burnin.js';

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
    expect(s.deterministicPhases).toBe(2);
    expect(s.learnedSkills).toBe(0);
  });

  it('classifies a timeout as failed and still reads its cost', () => {
    const s = parseRunLog(FAILED_LOG);
    expect(s.outcome).toBe('failed');
    expect(s.costUsd).toBeCloseTo(0.8523, 4);
    expect(s.sonnetCalls).toBe(2);
  });

  it('a killed/empty log degrades to error with null economics, not a crash', () => {
    const s = parseRunLog('npm ERR! something exploded');
    expect(s.outcome).toBe('error');
    expect(s.costUsd).toBeNull();
    expect(s.llmCalls).toBeNull();
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
    });
    expect(row.split(',')).toHaveLength(CSV_HEADER.split(',').length);
    expect(row).toContain('delivered');
    expect(row).toContain('0.2256');
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
