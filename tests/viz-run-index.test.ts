import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sortRunIndex, summarizeTraceFile } from '../src/viz/runIndex.js';

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
