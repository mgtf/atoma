import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TRACE_BYTES } from '../src/contracts/traceFields.js';
import { sortRunIndex, summarizeTraceFile, TRACE_HEADER_KEYS } from '../src/viz/runIndex.js';

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

/**
 * The row's key names are PINNED against `VizRun` in the source with
 * `satisfies`, so a rename there fails to compile rather than silently reading
 * `undefined`. This pins the SET, so removing one from the reader is a visible
 * decision rather than a quiet loss of a column.
 */
describe('the row reads a stated set of trace members', () => {
  it('names exactly the nine it builds from', () => {
    expect([...TRACE_HEADER_KEYS].sort()).toEqual([
      'cancelled',
      'degraded',
      'durationMs',
      'endedAt',
      'error',
      'id',
      'label',
      'startedAt',
      'totals',
    ]);
  });
});
