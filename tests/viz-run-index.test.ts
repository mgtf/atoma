import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TRACE_BYTES } from '../src/contracts/traceFields.js';
import { RUN_INDEX_GOAL_MAX } from '../src/viz/trace.js';
import {
  readBoundedRunFile,
  sortRunIndex,
  summarizeTraceFile,
  TRACE_HEADER_KEYS,
} from '../src/viz/runIndex.js';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('viz run index', () => {
  it('summarizes a persisted trace and sorts newest first', () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    const file = join(root, 'run.json');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'project-run-1',
        label: 'build-app: bounce a ball',
        startedAt: '2026-08-20T15:52:45.785Z',
        endedAt: '2026-08-20T15:52:46.527Z',
        durationMs: 742,
        error: '401',
        totals: { calls: 2, costUsd: 0 },
      })
    );
    expect(summarizeTraceFile(file)).toMatchObject({
      id: 'project-run-1',
      hasError: true,
      calls: 2,
      costUsd: 0,
    });
    expect(summarizeTraceFile(join(root, 'missing.json'))).toBeNull();

    const sorted = sortRunIndex([
      {
        id: 'older',
        label: 'older run',
        startedAt: '2026-08-19T23:00:36.516Z',
        hasError: false,
      },
      {
        id: 'newer',
        label: 'newer run',
        startedAt: '2026-08-20T15:52:45.785Z',
        hasError: true,
      },
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['newer', 'older']);
  });

  it('skips torn JSON rather than inventing a row', () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    mkdirSync(root, { recursive: true });
    const file = join(root, 'torn.json');
    writeFileSync(file, '{');
    expect(summarizeTraceFile(file)).toBeNull();
  });
});

/**
 * The gated `/api/runs` path used to parse a whole trace with NO bound, on the
 * very files the coordinator refuses to read whole — measured at 1.48 MB and
 * growing ~19KB per tool call, with a 32 MiB ceiling now shared between the
 * three readers. Here the disposition is fail-SOFT: a missing row in a list is
 * not a wrong answer about whether work was delivered.
 */
describe('viz run index is bounded', () => {
  it('skips a trace over the shared ceiling instead of parsing it', () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    const file = join(root, 'huge.json');
    const filler = 'x'.repeat(1024 * 1024);
    writeFileSync(
      file,
      `{"id":"big","label":"big run","startedAt":"2026-08-23T00:00:00.000Z","events":[${new Array(
        33
      )
        .fill(`"${filler}"`)
        .join(',')}]}`
    );
    expect(statSync(file).size).toBeGreaterThan(MAX_TRACE_BYTES);
    expect(summarizeTraceFile(file)).toBeNull();
  });

  it('still summarizes a large-but-acceptable trace', () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    const file = join(root, 'big-enough.json');
    // Past the 512KB bound that erased a delivered run, well under the ceiling.
    const filler = 'y'.repeat(700 * 1024);
    writeFileSync(
      file,
      `{"id":"ok","label":"ok run","startedAt":"2026-08-23T00:00:00.000Z","events":["${filler}"],"totals":{"calls":41,"costUsd":1.1002}}`
    );
    expect(statSync(file).size).toBeGreaterThan(524_288);
    expect(summarizeTraceFile(file)).toMatchObject({ id: 'ok', calls: 41, costUsd: 1.1002 });
  });

  it('refuses a file past the shared ceiling without reading it', () => {
    // The ceiling is one number for the whole corpus (MAX_TRACE_BYTES, 32 MiB,
    // src/contracts/traceFields.ts); what differs is the disposition over it.
    // Sparse: the point is the SIZE the reader stats, not 33 MiB of real bytes.
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    const file = join(root, 'huge.json');
    writeFileSync(file, '{"id":"a","label":"a","startedAt":"2026-08-23T00:00:00.000Z"}');
    truncateSync(file, 33 * 1024 * 1024);
    const read = readBoundedRunFile(file);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toBe('overCeiling');
    // And the list reader's own disposition over that refusal is unchanged:
    // skip the row rather than fail the listing.
    expect(summarizeTraceFile(file)).toBeNull();
  });

  it('separates "past the ceiling" from "unreadable", because callers answer them differently', () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    const absent = readBoundedRunFile(join(root, 'nope.json'));
    expect(absent.ok === false && absent.reason).toBe('unreadable');
    const dir = join(root, 'dir.json');
    mkdirSync(dir);
    expect(readBoundedRunFile(dir)).toEqual({ ok: false, reason: 'unreadable' });
    const real = join(root, 'real.json');
    writeFileSync(real, '{"id":"a"}');
    const link = join(root, 'link.json');
    symlinkSync(real, link);
    // A symlink is refused rather than followed OUT of the corpus.
    expect(readBoundedRunFile(link)).toEqual({ ok: false, reason: 'unreadable' });
    const ok = readBoundedRunFile(real);
    expect(ok.ok && ok.bytes.toString('utf8')).toBe('{"id":"a"}');
  });

  it('refuses a symlink and a directory without reading them', () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-run-index-'));
    const real = join(root, 'real.json');
    writeFileSync(real, '{"id":"a","label":"a","startedAt":"2026-08-23T00:00:00.000Z"}');
    const link = join(root, 'link.json');
    symlinkSync(real, link);
    expect(summarizeTraceFile(link)).toBeNull();
    const dir = join(root, 'dir.json');
    mkdirSync(dir);
    expect(summarizeTraceFile(dir)).toBeNull();
  });
});

describe('the row carries the goal its label was cut from', () => {
  it('projects it from the trace, for runs recorded before the index had it', () => {
    // The label is the COMPACT form — capped at 80 characters when the run was
    // recorded — and the run picker's row is as wide as its panel. Reading the
    // goal from the TRACE rather than from the entry is what lets a run
    // recorded long ago fill that row today.
    const goal = 'Improve the existing MDN scripted beginner site with one focused change: replace the greeting with an accessible banner that states the page purpose.';
    const dir = mkdtempSync(join(tmpdir(), 'atoma-run-index-goal-'));
    try {
      const file = join(dir, 'run-goal.json');
      writeFileSync(file, JSON.stringify({
        id: 'run-goal',
        label: `build-app: ${goal.slice(0, 80)}…`,
        task: { description: goal },
        startedAt: '2026-09-22T10:00:00.000Z',
        endedAt: '2026-09-22T10:01:00.000Z',
        events: [],
      }));
      const entry = summarizeTraceFile(file);
      expect(entry?.goal).toBe(goal);
      // Longer than the label it rides beside, which is the entire point.
      expect(entry!.goal!.length).toBeGreaterThan(entry!.label.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the fresh tokens a run spent, and not its cache reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-run-index-tokens-'));
    try {
      const file = join(dir, 'tokens.json');
      writeFileSync(file, JSON.stringify({
        id: 'tokens', label: 'x', startedAt: '2026-09-22T10:00:00.000Z', events: [],
        totals: { inputTokens: 10_181, outputTokens: 80_380, cacheReadInputTokens: 8_400_000 },
      }));
      // Cache reads are routinely two orders of magnitude larger and would be
      // the only thing a one-number budget ever showed.
      expect(summarizeTraceFile(file)?.tokens).toBe(90_561);

      const none = join(dir, 'none.json');
      writeFileSync(none, JSON.stringify({
        id: 'none', label: 'x', startedAt: '2026-09-22T10:00:00.000Z', events: [],
      }));
      expect(summarizeTraceFile(none)?.tokens).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds what it carries, and says nothing when there is no goal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-run-index-goal-'));
    try {
      const long = join(dir, 'long.json');
      writeFileSync(long, JSON.stringify({
        id: 'long', label: 'x', startedAt: '2026-09-22T10:00:00.000Z',
        task: { description: 'g'.repeat(RUN_INDEX_GOAL_MAX + 50) }, events: [],
      }));
      // An index of thousands of runs is read whole; the goal is bounded.
      expect(summarizeTraceFile(long)?.goal).toHaveLength(RUN_INDEX_GOAL_MAX + 1);

      const bare = join(dir, 'bare.json');
      writeFileSync(bare, JSON.stringify({
        id: 'bare', label: 'x', startedAt: '2026-09-22T10:00:00.000Z', events: [],
      }));
      expect(summarizeTraceFile(bare)?.goal).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The row's key names are PINNED against `VizRun` in the source with
 * `satisfies`, so a rename there fails to compile rather than silently reading
 * `undefined`. This pins the SET, so removing one from the reader is a visible
 * decision rather than a quiet loss of a column.
 */
describe('the row reads a stated set of trace members', () => {
  it('names the header and events it builds from', () => {
    expect([...TRACE_HEADER_KEYS].sort()).toEqual([
      'cancelled',
      'degraded',
      'durationMs',
      'endedAt',
      'error',
      'events',
      'id',
      'label',
      'startedAt',
      'task',
      'totals',
    ]);
  });
});
