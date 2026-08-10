import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { TraceRecorder, type VizSkillEvent } from '../src/viz/trace.js';
import type { SkillEventInfo, Task } from '../src/core/types.js';
import { forkBranch } from '../src/core/branchCtx.js';
import type { RunContext } from '../src/core/types.js';

/**
 * Regression tests for skill-pipeline tracing. The `recordSkillEvent`
 * helper turns a `SkillEventInfo` payload into a `VizSkillEvent` and
 * stamps id/ts; `forkBranch` must thread `branchId` onto skill events
 * the same way it already does for trust/llm events so the viz can
 * group them into per-subtask lanes.
 */

const task: Task = { description: 'dummy' };

describe('TraceRecorder.recordSkillEvent', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('records a VizSkillEvent with id/ts/kind populated', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-skill-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'test');

    const info: SkillEventInfo = {
      op: 'match',
      l1Name: 'Lithium',
      skillId: 'scaffold-package-json',
      actorName: 'Methane',
      actorTier: 2,
      reasoning: 'skill matched the subtask shape',
    };
    recorder.recordSkillEvent(info);

    const run = recorder.currentRun!;
    expect(run.events).toHaveLength(1);
    const ev = run.events[0] as VizSkillEvent;
    expect(ev.kind).toBe('skill');
    expect(ev.op).toBe('match');
    expect(ev.l1Name).toBe('Lithium');
    expect(ev.skillId).toBe('scaffold-package-json');
    expect(ev.actor).toEqual({ name: 'Methane', tier: 2 });
    expect(ev.reasoning).toMatch(/matched the subtask/);
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.ts).toBe('number');
  });

  it('skill events do NOT count toward LLM billing totals', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-skill-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'test');
    for (const op of ['match', 'inject', 'success'] as const) {
      recorder.recordSkillEvent({
        op,
        l1Name: 'Lithium',
        skillId: 'foo',
        actorName: 'Methane',
        actorTier: 2,
      });
    }
    const run = recorder.endRun({});
    expect(run!.totals!.calls).toBe(0);
    expect(run!.totals!.costUsd).toBe(0);
    expect(run!.events.every((e) => e.kind === 'skill')).toBe(true);
  });

  it('omits reasoning + branchId fields when not provided', () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-skill-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun(task, 'test');
    recorder.recordSkillEvent({
      op: 'success',
      l1Name: 'Lithium',
      skillId: 'foo',
      actorName: 'Methane',
      actorTier: 2,
    });
    const ev = recorder.currentRun!.events[0] as VizSkillEvent;
    expect('reasoning' in ev).toBe(false);
    expect('branchId' in ev).toBe(false);
  });
});

describe('forkBranch propagates recordSkill', () => {
  it('stamps branchId on every skill event emitted from a forked ctx', () => {
    const seen: SkillEventInfo[] = [];
    const baseCtx: RunContext = {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      signal: new AbortController().signal,
      llm: {
        complete: async () => ({ text: '', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } }),
      },
      limits: { maxPlanIterations: 1, maxExecIterations: 1 },
      recordSkill: (info) => seen.push(info),
    };
    const branchCtx = forkBranch(baseCtx, 'branch-uuid-abc');
    branchCtx.recordSkill?.({
      op: 'match',
      l1Name: 'Lithium',
      skillId: 'foo',
      actorName: 'Methane',
      actorTier: 2,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.branchId).toBe('branch-uuid-abc');
    // Trunk-level emission stays branch-less.
    baseCtx.recordSkill?.({
      op: 'success',
      l1Name: 'Lithium',
      skillId: 'foo',
      actorName: 'Methane',
      actorTier: 2,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.branchId).toBeUndefined();
  });

  it('does not wrap recordSkill when the parent ctx has none', () => {
    const baseCtx: RunContext = {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      signal: new AbortController().signal,
      llm: {
        complete: async () => ({ text: '', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } }),
      },
      limits: { maxPlanIterations: 1, maxExecIterations: 1 },
    };
    const branchCtx = forkBranch(baseCtx, 'branch-x');
    expect(branchCtx.recordSkill).toBeUndefined();
  });
});
