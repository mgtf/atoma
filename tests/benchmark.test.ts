import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CSV_HEADER,
  analyse,
  formatAnalysis,
  mean,
  median,
  toBenchmarkCsvRow,
} from '../src/cli/benchmark.js';
import type { RunStats } from '../src/cli/burnin.js';

const stats = (over: Partial<RunStats> = {}): RunStats => ({
  outcome: 'delivered',
  costUsd: 0.3,
  llmCalls: 14,
  opusCalls: 1,
  sonnetCalls: 0,
  haikuCalls: 13,
  otherCalls: 0,
  deterministicPhases: 0,
  escalations: 0,
  learnedSkills: 0,
  learnedEventSkills: 0,
  promotions: 0,
  refusals: 0,
  compileErrors: 0,
  demotions: 0,
  dispatchFallbacks: 0,
  ...over,
});

describe('mean / median', () => {
  it('return null on an empty series rather than NaN', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });

  it('median averages the two middle values on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe('analyse — the pre-registered metric', () => {
  it('finds the cumulative break-even run', () => {
    // baseline mean 1.00; atoma pays 2.00 tuition then 0.20 per run.
    // cumulative: 2.00, 2.20, 2.40, 2.60, 2.80 …
    // baseline:   1.00, 2.00, 3.00, 4.00 → first crossing at N=3.
    const a = analyse([1, 1, 1], [2, 0.2, 0.2, 0.2]);
    expect(a.baselineMean).toBe(1);
    expect(a.breakEvenRun).toBe(3);
  });

  it('reports null when atoma never catches up — a refutation must be representable', () => {
    const a = analyse([0.2, 0.2], [0.5, 0.5, 0.5]);
    expect(a.breakEvenRun).toBeNull();
    expect(a.cumulativeDeltaUsd).toBeCloseTo(0.2 * 3 - 1.5, 10);
    expect(formatAnalysis(a)).toContain('H1 NOT SUPPORTED');
  });

  it('never reports a break-even at run 1 when the first run is the dearer one', () => {
    // Guards the off-by-one that would let cold-start tuition read as a win.
    const a = analyse([1], [1.5, 0.1]);
    expect(a.breakEvenRun).toBe(2);
  });

  it('reports break-even at run 1 when atoma is cheaper immediately', () => {
    const a = analyse([1], [0.4, 0.4]);
    expect(a.breakEvenRun).toBe(1);
  });

  it('excludes cold-start tuition from the warm mean', () => {
    const a = analyse([1], [2, 0.2, 0.4]);
    expect(a.atomaMean).toBeCloseTo(2.6 / 3, 10);
    expect(a.atomaWarmMean).toBeCloseTo(0.3, 10);
  });

  it('splits the trend at the midpoint, second half taking the odd element', () => {
    const a = analyse([1], [1, 1, 1, 0.2, 0.2]);
    expect(a.trendFirstHalf).toBeCloseTo(1, 10);
    expect(a.trendSecondHalf).toBeCloseTo((1 + 0.2 + 0.2) / 3, 10);
  });

  it('degrades to nulls rather than throwing when an arm produced nothing', () => {
    const a = analyse([], []);
    expect(a.breakEvenRun).toBeNull();
    expect(a.baselineMean).toBeNull();
    expect(a.cumulativeDeltaUsd).toBeNull();
    expect(() => formatAnalysis(a)).not.toThrow();
  });
});

describe('csv shape', () => {
  it('emits exactly as many cells as the header names', () => {
    const row = toBenchmarkCsvRow({
      ts: '2026-08-10T00:00:00.000Z',
      arm: 'atoma',
      taskId: 'csvstat',
      runIndex: 3,
      stats: stats(),
      durationS: 210,
      trace: 'run.json',
    });
    expect(row.split(',')).toHaveLength(BENCHMARK_CSV_HEADER.split(',').length);
  });

  it('leaves a missing cost blank instead of writing "null" into the curve', () => {
    const row = toBenchmarkCsvRow({
      ts: 't',
      arm: 'baseline',
      taskId: 'csvstat',
      runIndex: 1,
      stats: stats({ outcome: 'failed', costUsd: null, llmCalls: null }),
      durationS: null,
      trace: '',
    });
    const cells = row.split(',');
    expect(cells[5]).toBe('');
    expect(cells[6]).toBe('');
    expect(row).not.toContain('null');
  });
});

describe('held-out reporting', () => {
  it('names the memorisation control in the report', () => {
    const out = formatAnalysis(analyse([1], [0.5, 0.4]), { baseline: [1], atoma: [0.4] });
    expect(out).toContain('held-out');
    expect(out).toMatch(/memoris/i);
  });
});
