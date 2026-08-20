import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { TraceRecorder, runLabelFromGoal } from '../src/viz/trace.js';

/**
 * A run's label is a display NAME derived from its goal, and the goal itself
 * always survives whole on `task.description`. Both writers used a bare slice,
 * so a real trace carried `"build-app: … tiles that swap colour w"` — cut
 * mid-word with nothing saying so, and every surface repeated it as if that
 * were the goal (2026-08-15).
 */
describe('run labels admit when they are cut', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('marks a truncated goal and leaves a short one byte-identical', () => {
    const short = 'ship the widget';
    expect(runLabelFromGoal(short, 80)).toBe(short);
    // Exactly at the limit is not truncation.
    const exact = 'x'.repeat(80);
    expect(runLabelFromGoal(exact, 80)).toBe(exact);

    const long = `${'x'.repeat(80)}y`;
    const cut = runLabelFromGoal(long, 80);
    expect(cut).toBe(`${'x'.repeat(80)}…`);
    expect(cut.endsWith('…')).toBe(true);
  });

  it("keeps the whole goal on the task even when the recorder's label is cut", () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-label-'));
    const recorder = new TraceRecorder(dir);
    const description = `Build a dashboard that ${'reads every metric '.repeat(12)}`;
    const run = recorder.beginRun({ description });

    expect(description.length).toBeGreaterThan(140);
    expect(run.label.endsWith('…')).toBe(true);
    expect(run.label).toBe(`${description.slice(0, 140)}…`);
    // The goal is never the casualty of the label.
    expect(run.task.description).toBe(description);
  });

  it('uses a safe control-plane id verbatim and rejects path-shaped ids', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-run-id-'));
    const recorder = new TraceRecorder(dir);
    expect(
      recorder.beginRun(
        { description: 'tenant project run' },
        undefined,
        { runId: 'project-run:7f5c9d6e' }
      ).id
    ).toBe('project-run:7f5c9d6e');
    recorder.endRun();
    expect(() =>
      recorder.beginRun(
        { description: 'bad tenant project run' },
        undefined,
        { runId: '../escape' }
      )
    ).toThrow(/safe filename/);
  });
});
