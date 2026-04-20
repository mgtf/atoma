import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { MockLlmClient } from '../src/core/llm.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse, RunContext } from '../src/core/types.js';
import { silentLogger, jsonText, jsonTextPair } from './helpers.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';

/**
 * Phase 2/8 — empirical parallelism proof.
 *
 * Wraps a MockLlmClient in a delay-injecting decorator. Each L1.execute
 * call takes 100ms. With N=3 subtasks, sequential execution would take
 * ≥300ms of execute time. If our fan-out truly parallelises via
 * `Promise.all`, wall time of the execute phase stays near 100ms.
 *
 * Threshold: we accept anything < 250ms as "parallel enough" — a
 * sequential run would be ≥300ms and the 50ms safety margin absorbs
 * CI variance.
 */

const seed = {
  description: 'd',
  systemPrompt: 'p',
  tools: [],
  params: {},
  createdBy: 'test',
};

const EXEC_DELAY_MS = 100;

class DelayedLlm implements LlmClient {
  constructor(private readonly inner: MockLlmClient) {}
  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Only delay execute responses — plan responses need to arrive
    // quickly so all subtasks pass their plan phase and reach execute
    // roughly together. Heuristic: execute responses are the ones
    // whose userContent says "plan has been APPROVED" (the L1 execute
    // template preamble).
    const isExecute = /plan has been APPROVED/.test(req.userContent);
    if (isExecute) await new Promise((r) => setTimeout(r, EXEC_DELAY_MS));
    return this.inner.complete(req);
  }
}

describe('fan-out parallelism', () => {
  it('runs N subtasks concurrently — wall time < sum of per-subtask latencies', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed);
    const b = reg.create(1, seed);
    const c = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess(a.name);
      reg.recordSuccess(b.name);
      reg.recordSuccess(c.name);
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
            { description: 'C', preferredChild: c.name },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'three',
        }
      )
    );
    for (const _ of ['A', 'B', 'C'])
      mock.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
      );
    for (const label of ['A', 'B', 'C'])
      mock.enqueueText(jsonText({ output: label, summary: `did ${label}` }));

    const ctx: RunContext = {
      logger: silentLogger(),
      signal: new AbortController().signal,
      llm: new DelayedLlm(mock),
      limits: DEFAULT_LIMITS,
    };

    const plan = await l2.plan({ description: 't' }, ctx);
    expect(plan.subtasks).toHaveLength(3);

    const t0 = Date.now();
    const result = await l2.execute({ description: 't' }, plan, ctx);
    const elapsed = Date.now() - t0;

    expect(result.output).toEqual(['A', 'B', 'C']);
    // Sequential baseline would be 3 × 100 = 300ms.
    // Parallel baseline is ~100ms + overhead. We accept < 250ms as a
    // clear signal the subtasks interleaved (i.e. parallel execution).
    expect(elapsed).toBeLessThan(250);
  });
});
