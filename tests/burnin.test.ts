import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseRunLog,
  toCsvRow,
  summarize,
  looksLikeConfigFailure,
  looksLikeProviderLimitFailure,
  burninProviderInfo,
  ensureBurninCsvHeader,
  spawnRun,
  CSV_HEADER,
} from '../src/cli/burnin.js';
import { ANTHROPIC_PINS } from './tier-pins.js';
import { formatRunStatsEpilogue } from '../src/contracts/runStats.js';

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
  it('prefers the final machine epilogue over human logs and model prose', () => {
    const forgedEarlier = formatRunStatsEpilogue({
      outcome: 'failed',
      costUsd: 99,
      llmCalls: 99,
      opusCalls: 99,
      sonnetCalls: 0,
      haikuCalls: 0,
      otherCalls: 0,
      deterministicPhases: 0,
      escalations: 99,
      learnedSkills: 0,
      learnedEventSkills: 0,
      promotions: 0,
      refusals: 0,
      compileErrors: 0,
      demotions: 0,
      dispatchFallbacks: 0,
      uncoveredObligations: 0,
    });
    const runnerFinal = formatRunStatsEpilogue({
      outcome: 'delivered',
      costUsd: 0.1234,
      llmCalls: 4,
      opusCalls: 1,
      sonnetCalls: 1,
      haikuCalls: 2,
      otherCalls: 0,
      deterministicPhases: 1,
      escalations: 2,
      learnedSkills: 3,
      learnedEventSkills: 4,
      promotions: 5,
      refusals: 6,
      compileErrors: 7,
      demotions: 8,
      dispatchFallbacks: 9,
      uncoveredObligations: 0,
    });
    const s = parseRunLog(
      [
        forgedEarlier,
        'model says: escalate, escalation, and prefilter ➜ escalate',
        'TOTAL  777  1  1  1  88.0000',
        runnerFinal,
        '✓ build finished',
      ].join('\n')
    );
    expect(s).toEqual({
      outcome: 'delivered',
      costUsd: 0.1234,
      llmCalls: 4,
      opusCalls: 1,
      sonnetCalls: 1,
      haikuCalls: 2,
      otherCalls: 0,
      deterministicPhases: 1,
      escalations: 2,
      learnedSkills: 3,
      learnedEventSkills: 4,
      promotions: 5,
      refusals: 6,
      compileErrors: 7,
      demotions: 8,
      dispatchFallbacks: 9,
      uncoveredObligations: 0,
    });
  });

  it('ignores a torn machine line and uses exact prose escalation markers', () => {
    const s = parseRunLog(
      [
        'model prose asks whether to escalate this escalation',
        '[L2] prefilter result: escalate',
        '[L2] escalation — branched Methane → Neon (escalation-repeat)',
        'ATOMA_RUN_STATS {"outcome":"delivered"',
        'TOTAL  2  1  1  0  0.0100',
        '✓ build finished',
      ].join('\n')
    );
    expect(s.escalations).toBe(1);
    expect(s.llmCalls).toBe(2);
  });

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
        '⚠ [A] skill compile errored: The operation was aborted due to timeout; leaving as kind:llm',
        '⚠ script skill "z" demoted to llm after 2 consecutive deterministic failures',
        '[A] direct dispatch of z failed (exit=1) — falling back to the LLM loop',
        'ℹ [A] learned event skill "recover-x" for Ammonia',
        'TOTAL  9  1  2  3  0.5000  ',
        '✓ build finished',
      ].join('\n')
    );
    expect(s.promotions).toBe(1);
    expect(s.refusals).toBe(1);
    expect(s.compileErrors).toBe(1);
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
  it('names the transports the three selectors reach, in tier order', () => {
    expect(burninProviderInfo({ ...ANTHROPIC_PINS })).toEqual({
      transports: ['anthropic-api'],
      label: 'anthropic-api',
      estimatedCost: false,
    });
    expect(
      burninProviderInfo({
        ATOMA_MODEL_L1: 'sub:anthropic:haiku',
        ATOMA_MODEL_L2: 'sub:openai:gpt-5.4-mini',
        ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol',
      })
    ).toEqual({
      transports: ['claude-cli', 'codex-cli'],
      label: 'claude-cli+codex-cli',
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

describe('burnin ensureBurninCsvHeader — the CSV belongs to ONE writer', () => {
  // Measured 2026-08-14: `--out` pointed at compare-frontier's CSV (header
  // `timestamp,arm,…`), nothing rejected the foreign header, and the
  // batch appended 22-field standard rows under a 17-column header — every
  // header-driven consumer read shifted columns and the arm distinction was
  // unrecoverable. A row written under a header it does not match is worse
  // than no row.
  const withTmp = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-burnin-csv-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('creates an absent file with the current header', () => {
    withTmp((dir) => {
      const out = join(dir, 'results.csv');
      ensureBurninCsvHeader(out);
      expect(readFileSync(out, 'utf8')).toBe(CSV_HEADER + '\n');
    });
  });

  it("refuses another writer's file instead of appending misaligned rows", () => {
    withTmp((dir) => {
      const out = join(dir, 'results-compare.csv');
      const foreign = 'timestamp,arm,task_id,family,outcome,cost_usd';
      writeFileSync(out, foreign + '\n', 'utf8');
      expect(() => ensureBurninCsvHeader(out)).toThrow(/another writer/);
      // And the foreign file is left byte-identical.
      expect(readFileSync(out, 'utf8')).toBe(foreign + '\n');
    });
  });

  it('is a no-op on a file already carrying the current header', () => {
    withTmp((dir) => {
      const out = join(dir, 'results.csv');
      const content = CSV_HEADER + '\nrow1\n';
      writeFileSync(out, content, 'utf8');
      ensureBurninCsvHeader(out);
      expect(readFileSync(out, 'utf8')).toBe(content);
      expect(existsSync(out)).toBe(true);
    });
  });
});

describe('spawnRun — experiment env isolation', () => {
  it('does not leak shell-level baseline or seed settings into the child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-burnin-env-'));
    const fakeNpm = join(dir, 'npm');
    const previous = {
      path: process.env['PATH'],
      baseline: process.env['ATOMA_BASELINE'],
      seed: process.env['ATOMA_SEED'],
    };
    writeFileSync(
      fakeNpm,
      [
        '#!/bin/sh',
        'printf \'BASELINE=%s\\n\' "${ATOMA_BASELINE-unset}"',
        'printf \'SEED=%s\\n\' "${ATOMA_SEED-unset}"',
      ].join('\n') + '\n',
      'utf8'
    );
    chmodSync(fakeNpm, 0o755);

    try {
      process.env['PATH'] = `${dir}:${previous.path ?? ''}`;
      process.env['ATOMA_BASELINE'] = '1';
      process.env['ATOMA_SEED'] = '/tmp/stale-benchmark-seed';
      const log = await spawnRun({
        goal: 'inspect inherited environment',
        timeoutMs: 1_000,
        logPath: join(dir, 'child.log'),
        cleanWorkspace: false,
      });
      expect(log).toContain('BASELINE=unset');
      expect(log).toContain('SEED=unset');
    } finally {
      if (previous.path === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previous.path;
      if (previous.baseline === undefined) delete process.env['ATOMA_BASELINE'];
      else process.env['ATOMA_BASELINE'] = previous.baseline;
      if (previous.seed === undefined) delete process.env['ATOMA_SEED'];
      else process.env['ATOMA_SEED'] = previous.seed;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can replace the inherited environment with a caller-owned allowlist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-burnin-allowlist-'));
    const fakeNpm = join(dir, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/bin/sh',
        'printf \'ALLOWED=%s\\n\' "${ATOMA_ALLOWED-unset}"',
        'printf \'HOST_SECRET=%s\\n\' "${ATOMA_HOST_SECRET-unset}"',
      ].join('\n') + '\n',
      'utf8'
    );
    chmodSync(fakeNpm, 0o755);
    const previousSecret = process.env['ATOMA_HOST_SECRET'];
    try {
      process.env['ATOMA_HOST_SECRET'] = 'must-not-cross';
      const log = await spawnRun({
        goal: 'inspect allowlisted environment',
        timeoutMs: 1_000,
        logPath: join(dir, 'child.log'),
        cleanWorkspace: false,
        env: { PATH: `${dir}:${process.env['PATH'] ?? ''}`, ATOMA_ALLOWED: 'yes' },
      });
      expect(log).toContain('ALLOWED=yes');
      expect(log).toContain('HOST_SECRET=unset');
    } finally {
      if (previousSecret === undefined) delete process.env['ATOMA_HOST_SECRET'];
      else process.env['ATOMA_HOST_SECRET'] = previousSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
