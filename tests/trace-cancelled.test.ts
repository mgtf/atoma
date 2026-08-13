import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { TraceRecorder, type VizRunIndexEntry } from '../src/viz/trace.js';
import type { Task } from '../src/core/types.js';

/**
 * Regression for the SIGINT/Ctrl-C path in build-app.ts. Before this,
 * a user-cancelled run stayed marked `inFlight: true` forever in the
 * index because `flushPartial()` never set `endedAt`. The `cancelled`
 * flag distinguishes deliberate user-cancellation from a real
 * `hasError` (system fault) and turns off the "● LIVE" label in the UI.
 */

const task: Task = { description: 'dummy' };

describe('TraceRecorder.endRun({ cancelled: true })', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('marks the persisted run + index entry as cancelled and clears inFlight', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-cancel-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'cancellable');

    // Mid-flight cancellation: no result, just a user signal.
    const persisted = recorder.endRun({
      error: 'run cancelled by user (signal received)',
      cancelled: true,
    });

    expect(persisted).not.toBeNull();
    expect(persisted!.cancelled).toBe(true);
    expect(persisted!.error).toMatch(/cancelled by user/);
    expect(persisted!.endedAt).toBeDefined();
    expect(typeof persisted!.durationMs).toBe('number');

    // Index entry: cancelled flag set, inFlight cleared (because endedAt is set).
    const indexFile = join(dir, 'index.json');
    const idx = JSON.parse(readFileSync(indexFile, 'utf8')) as VizRunIndexEntry[];
    expect(idx).toHaveLength(1);
    expect(idx[0]!.cancelled).toBe(true);
    expect(idx[0]!.inFlight).toBeUndefined();
    // hasError stays true because we did supply an error message — the UI
    // labels cancelled-takes-precedence-over-error in runSelectLabel.
    expect(idx[0]!.hasError).toBe(true);
  });

  it('endRun with no opts.cancelled does NOT set the flag', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-cancel-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'normal');
    const persisted = recorder.endRun({
      result: {
        summary: 's',
        output: 'o',
        producedBy: { tier: 3, name: 'Meristem', viaFallback: false },
      },
    });
    expect(persisted!.cancelled).toBeUndefined();
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as VizRunIndexEntry[];
    expect(idx[0]!.cancelled).toBeUndefined();
  });
});
