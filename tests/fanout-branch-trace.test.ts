import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { MockLlmClient } from '../src/core/llm.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import {
  TraceRecorder,
  type VizBranchEvent,
  type VizLlmEvent,
} from '../src/viz/trace.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { RunContext } from '../src/core/types.js';
import { silentLogger, jsonText, jsonTextPair } from './helpers.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';

/**
 * Phase 7 — fan-out events carry branchId.
 *
 * Runs an N=2 fan-out and asserts:
 *   - LLM events inside each subtask's supervise loop carry a
 *     `branchId` identifying their parallel lane.
 *   - The two subtasks have DIFFERENT branchIds (parallel lanes don't
 *     collapse into one).
 *   - The L2's own plan call (before fan-out) has no branchId (trunk
 *     level, no branch).
 */

const seed = {
  description: 'd',
  systemPrompt: 'p',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('fan-out — trace events carry branchId per subtask', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('tags each subtask chain with a unique branchId', async () => {
    dir = mkdtempSync(join(osTmpdir(), 'atoma-branch-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun({ description: 't' }, 'fan-out-test');

    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed);
    const b = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess(a.name);
      reg.recordSuccess(b.name);
    }
    const l2 = L2Atom.fromType(reg.create(2, seed), reg);

    const mock = new MockLlmClient();
    mock.enqueueText(jsonText({ kind: 'escalate', reasoning: 'skip' }));
    mock.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: a.name, reasoning: 'pf' },
        {
          reasoning: 'decompose',
          subtasks: [
            { description: 'A', preferredChild: a.name },
            { description: 'B', preferredChild: b.name },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'e',
        }
      )
    );
    for (const _ of ['A', 'B'])
      mock.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
      );
    for (const label of ['A', 'B'])
      mock.enqueueText(jsonText({ output: label, summary: 's' }));

    const recording = new RecordingLlmClient(mock, recorder);
    const ctx: RunContext = {
      logger: silentLogger(),
      signal: new AbortController().signal,
      llm: recording,
      limits: DEFAULT_LIMITS,
      recordBranch: (info) => recorder.recordBranch(info),
    };

    const plan = await l2.plan({ description: 't' }, ctx);
    await l2.execute({ description: 't' }, plan, ctx);

    const run = recorder.currentRun!;
    const llmEvents = run.events.filter(
      (e): e is VizLlmEvent => e.kind === 'llm'
    );

    // The prefilter + strategy+plan calls happen at TRUNK level → no branchId.
    const trunkEvents = llmEvents.filter((e) => e.branchId === undefined);
    expect(trunkEvents.length).toBeGreaterThanOrEqual(2);

    // The 2×2 = 4 subtask events (L1.plan + L1.execute per subtask) carry branchIds.
    const branchEvents = llmEvents.filter((e) => typeof e.branchId === 'string');
    expect(branchEvents.length).toBeGreaterThanOrEqual(4);

    // Two distinct branchIds, one per subtask lane.
    const distinctBranches = new Set(branchEvents.map((e) => e.branchId!));
    expect(distinctBranches.size).toBe(2);

    // Each L1 atom's events are contained in exactly one branch lane.
    const aBranches = new Set(
      branchEvents.filter((e) => e.actor?.name === a.name).map((e) => e.branchId!)
    );
    const bBranches = new Set(
      branchEvents.filter((e) => e.actor?.name === b.name).map((e) => e.branchId!)
    );
    expect(aBranches.size).toBe(1);
    expect(bBranches.size).toBe(1);
    // And they're on different lanes.
    const [aBranch] = aBranches;
    const [bBranch] = bBranches;
    expect(aBranch).not.toBe(bBranch);

    const lifecycle = run.events.filter(
      (event): event is VizBranchEvent => event.kind === 'branch'
    );
    expect(lifecycle).toHaveLength(4);
    expect(lifecycle.filter((event) => event.op === 'start')).toEqual([
      expect.objectContaining({
        index: 0,
        total: 2,
        aggregationMode: 'concat',
        label: 'A',
        actor: { name: l2.name, tier: 2 },
      }),
      expect.objectContaining({
        index: 1,
        total: 2,
        aggregationMode: 'concat',
        label: 'B',
        actor: { name: l2.name, tier: 2 },
      }),
    ]);
    expect(lifecycle.every((event) => event.parentBranchId === undefined)).toBe(true);
  });
});
