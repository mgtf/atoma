import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { TraceRecorder, type VizTrustEvent } from '../src/viz/trace.js';
import type { Task, TrustFastPathInfo } from '../src/core/types.js';

/**
 * Regression tests for trust-fast-path tracing. Before this hook, an
 * entirely trusted pipeline (e.g. L3→L2→L1 all above the success
 * threshold) produced runs with near-zero L2 LLM calls — leaving the UI
 * lane for that atom empty even though real supervision decisions were
 * being made. The `recordTrust` helper emits a synthetic `VizTrustEvent`
 * so the timeline still accounts for those decisions.
 */

const task: Task = { description: 'dummy' };

describe('TraceRecorder.recordTrust', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('records a VizTrustEvent into the active run', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-trust-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'test');

    const info: TrustFastPathInfo = {
      supervisorName: 'Meristem',
      supervisorTier: 3,
      childName: 'Myocyte',
      childTier: 2,
      subject: 'PLAN',
      successes: 4,
      failures: 0,
      reasoning: 'trust fast-path: Myocyte has 4 successes / 0 failures',
    };
    recorder.recordTrust(info);

    const run = recorder.currentRun!;
    expect(run.events).toHaveLength(1);
    const ev = run.events[0] as VizTrustEvent;
    expect(ev.kind).toBe('trust');
    expect(ev.subject).toBe('PLAN');
    expect(ev.actor).toEqual({ name: 'Meristem', tier: 3 });
    expect(ev.child).toEqual({ name: 'Myocyte', tier: 2 });
    expect(ev.successes).toBe(4);
    expect(ev.failures).toBe(0);
    expect(ev.reasoning).toMatch(/trust fast-path/);
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.ts).toBe('number');
  });

  it('trust events are excluded from the billing totals', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-trust-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'test');

    // Several trust events — these must NOT count toward LLM totals.
    for (let i = 0; i < 5; i++) {
      recorder.recordTrust({
        supervisorName: 'Meristem',
        supervisorTier: 3,
        childName: 'Myocyte',
        childTier: 2,
        subject: i % 2 === 0 ? 'PLAN' : 'RESULT',
        successes: 4,
        failures: 0,
        reasoning: 'trust fast-path',
      });
    }
    const run = recorder.endRun({});
    expect(run!.totals!.calls).toBe(0);
    expect(run!.totals!.costUsd).toBe(0);
    expect(run!.events).toHaveLength(5);
    expect(run!.events.every((e) => e.kind === 'trust')).toBe(true);
  });
});
