import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join} from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { TraceRecorder, type VizRunIndexEntry } from '../src/viz/trace.js';
import type { Task } from '../src/core/types.js';

/**
 * Regression tests for the `degraded` flag on persisted runs and the
 * run index. Fallback-produced runs must be distinguishable from true
 * protocol successes in `runs/index.json` so the UI and any stats
 * consumers don't over-count successes.
 */

const task: Task = { description: 'build something' };

function makeTmpRecorder(): { recorder: TraceRecorder; dir: string } {
  const dir = mkdtempSync(join(osTmpdir(), 'atoma-trace-'));
  return { recorder: new TraceRecorder(dir), dir };
}

function readIndex(dir: string): VizRunIndexEntry[] {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as VizRunIndexEntry[];
}

describe('TraceRecorder — degraded flag', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    dir = '';
  });

  it('sets degraded=true when the result came through viaFallback', () => {
    const t = makeTmpRecorder();
    dir = t.dir;
    t.recorder.beginRun(task, 'fallback run');
    const persisted = t.recorder.endRun({
      result: {
        summary: 'fallback summary',
        output: 'o',
        producedBy: { tier: 3, name: 'Neuron', viaFallback: true },
      },
    });
    expect(persisted?.degraded).toBe(true);
    const index = readIndex(dir);
    expect(index[0]!.degraded).toBe(true);
    expect(index[0]!.hasError).toBe(false);
  });

  it('omits degraded when the result was produced without fallback', () => {
    const t = makeTmpRecorder();
    dir = t.dir;
    t.recorder.beginRun(task, 'clean run');
    const persisted = t.recorder.endRun({
      result: {
        summary: 's',
        output: 'o',
        producedBy: { tier: 1, name: 'Hydrogen', viaFallback: false },
      },
    });
    expect(persisted?.degraded).toBeUndefined();
    const index = readIndex(dir);
    expect(index[0]!.degraded).toBeUndefined();
  });

  it('omits degraded when the run errored out (error takes precedence)', () => {
    const t = makeTmpRecorder();
    dir = t.dir;
    t.recorder.beginRun(task, 'errored run');
    const persisted = t.recorder.endRun({ error: 'boom' });
    expect(persisted?.degraded).toBeUndefined();
    const index = readIndex(dir);
    expect(index[0]!.hasError).toBe(true);
    expect(index[0]!.degraded).toBeUndefined();
  });

  it('keeps hasError false for degraded runs — they "finished", just not cleanly', () => {
    const t = makeTmpRecorder();
    dir = t.dir;
    t.recorder.beginRun(task, 'fallback run');
    t.recorder.endRun({
      result: {
        summary: 's',
        output: 'o',
        producedBy: { tier: 3, name: 'Neuron', viaFallback: true },
      },
    });
    const entry = readIndex(dir)[0]!;
    expect(entry.hasError).toBe(false);
    expect(entry.degraded).toBe(true);
  });
});
