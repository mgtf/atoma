import { describe, it, expect } from 'vitest';
import { formatDecompositionReport } from '../src/viz/report.js';
import type { VizRun, VizLlmEvent, VizToolEvent } from '../src/viz/trace.js';

function baseRun(events: VizRun['events'] = []): VizRun {
  return {
    id: 'r1',
    label: 'unit test run',
    task: { description: 'test task' },
    startedAt: '2026-04-20T00:00:00.000Z',
    events,
  };
}

function makeLlm(partial: Partial<VizLlmEvent> & Pick<VizLlmEvent, 'role' | 'response'>): VizLlmEvent {
  return {
    id: partial.id ?? 'id',
    ts: partial.ts ?? 1,
    kind: 'llm',
    role: partial.role,
    model: 'claude-3-5-haiku',
    systemPrompt: '',
    userContent: '',
    response: partial.response,
    stopReason: 'end_turn',
    durationMs: 10,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    costUsd: 0,
    ...(partial.actor ? { actor: partial.actor } : {}),
    ...(partial.child ? { child: partial.child } : {}),
    ...(partial.subject ? { subject: partial.subject } : {}),
    ...(partial.branchId ? { branchId: partial.branchId } : {}),
    ...(partial.error ? { error: partial.error } : {}),
  };
}

function makeTool(partial: Partial<VizToolEvent> & Pick<VizToolEvent, 'name' | 'args'>): VizToolEvent {
  return {
    id: partial.id ?? 'tid',
    ts: partial.ts ?? 1,
    kind: 'tool',
    llmEventId: partial.llmEventId ?? 'parent-llm',
    name: partial.name,
    args: partial.args,
    durationMs: partial.durationMs ?? 5,
    ...(partial.actor ? { actor: partial.actor } : {}),
    ...(partial.result !== undefined ? { result: partial.result } : {}),
    ...(partial.error !== undefined ? { error: partial.error } : {}),
    ...(partial.branchId ? { branchId: partial.branchId } : {}),
  };
}

describe('formatDecompositionReport', () => {
  it('renders L3 / L2 prefilter picks and L1 tool usage on the trusted fast-path', () => {
    const run = baseRun([
      makeLlm({
        role: 'prefilter',
        actor: { name: 'Meristem', tier: 3 },
        response: JSON.stringify({
          kind: 'reuse',
          target: 'Neuron',
          confidence: 'high',
          reasoning: 'Neuron exactly matches the task scope.',
        }),
      }),
      makeLlm({
        role: 'prefilter',
        actor: { name: 'Neuron', tier: 2 },
        response: JSON.stringify({
          kind: 'reuse',
          target: 'Potassium',
          confidence: 'high',
          reasoning: 'Potassium owns the chess puzzle leaf work.',
        }),
      }),
      makeTool({ name: 'write_file', args: { path: 'index.html', content: '…' }, actor: { name: 'Potassium', tier: 1 } }),
      makeTool({ name: 'start_static_server', args: {}, actor: { name: 'Potassium', tier: 1 }, error: 'timeout' }),
      makeTool({ name: 'start_static_server', args: { port: 0 }, actor: { name: 'Potassium', tier: 1 } }),
      makeTool({ name: 'validate_html', args: { url: 'http://localhost:8080/' }, actor: { name: 'Potassium', tier: 1 } }),
    ]);

    const out = formatDecompositionReport(run);
    expect(out).toContain('--- decomposition ---');
    expect(out).toContain('L3 tissue Meristem — prefilter ➜ reuse Neuron');
    expect(out).toContain('Neuron exactly matches');
    expect(out).toContain('L2 cell Neuron — prefilter ➜ reuse Potassium');
    expect(out).toContain('L1 molecule Potassium — 4 element call(s), 1 errored');
    expect(out).toMatch(/start_static_server × 2 \(1 errored\)/);
    expect(out).toContain('write_file × 1');
    expect(out).toContain('validate_html × 1');
  });

  it('parses L3 / L2 [strategy, plan] JSON responses and lists subtasks with their preferredChild', () => {
    const l3Response = JSON.stringify([
      { strategy: 'create', reasoning: 'no good match in catalog' },
      {
        reasoning: 'split by orthogonal artefacts',
        subtasks: [
          { description: 'Build the HTML dashboard', preferredChild: 'Neuron' },
          { description: 'Write the screenshot test', preferredChild: 'Argon' },
        ],
        aggregation: { mode: 'concat' },
        expectedOutput: 'dashboard URL + screenshot path',
      },
    ]);
    const l2Response = JSON.stringify([
      { strategy: 'reuse', target: 'Potassium', reasoning: 'Potassium writes single-file HTML' },
      {
        reasoning: 'atomic leaf task',
        subtasks: [{ description: 'Write index.html and validate it', preferredChild: 'Potassium' }],
        aggregation: { mode: 'concat' },
        expectedOutput: 'index.html on disk',
      },
    ]);
    const run = baseRun([
      makeLlm({ role: 'plan', actor: { name: 'Meristem', tier: 3 }, response: l3Response }),
      makeLlm({ role: 'plan', actor: { name: 'Neuron', tier: 2 }, branchId: 'branch-a', response: l2Response }),
    ]);

    const out = formatDecompositionReport(run);
    expect(out).toContain('L3 tissue Meristem — planned 2 subtask(s) (strategy: create)');
    expect(out).toContain('#1 Build the HTML dashboard  ➜ Neuron');
    expect(out).toContain('#2 Write the screenshot test  ➜ Argon');
    expect(out).toContain('L2 cell Neuron — planned 1 subtask(s) (strategy: reuse → Potassium)');
    expect(out).toContain('#1 Write index.html and validate it  ➜ Potassium');
  });

  it('tags multiple L2 branches with their branchId so fan-out lanes stay distinguishable', () => {
    const mkL2Plan = (subtaskDesc: string) =>
      JSON.stringify([
        { strategy: 'create', reasoning: 'fresh L2 for this branch' },
        {
          reasoning: 'one leaf',
          subtasks: [{ description: subtaskDesc, preferredChild: 'Sodium' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'done',
        },
      ]);
    const run = baseRun([
      makeLlm({
        role: 'plan',
        actor: { name: 'Neuron', tier: 2 },
        branchId: 'branch-a',
        response: mkL2Plan('subtask A'),
      }),
      makeLlm({
        role: 'plan',
        actor: { name: 'Neuron', tier: 2 },
        branchId: 'branch-b',
        response: mkL2Plan('subtask B'),
      }),
    ]);
    const out = formatDecompositionReport(run);
    expect(out).toContain('L2 cell Neuron [branch branch-a]');
    expect(out).toContain('L2 cell Neuron [branch branch-b]');
    expect(out).toContain('#1 subtask A');
    expect(out).toContain('#1 subtask B');
  });

  it('handles an unparseable plan response by surfacing the error instead of crashing', () => {
    const run = baseRun([
      makeLlm({
        role: 'plan',
        actor: { name: 'Meristem', tier: 3 },
        response: '',
        error: 'overloaded',
      }),
    ]);
    const out = formatDecompositionReport(run);
    expect(out).toContain('L3 tissue Meristem — plan (unparseable)');
    expect(out).toContain('overloaded');
    // Tool + L2 blocks still render (empty) — no exception.
    expect(out).toContain('L2 cell: (no planning activity recorded)');
    expect(out).toContain('L1 molecule element usage: (no element invocations recorded)');
  });

  it('caps the per-L1 tool sample and reports the omitted count', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      makeTool({
        id: `t${i}`,
        ts: i,
        name: 'validate_html',
        args: { url: 'http://localhost:8080/' },
        actor: { name: 'Potassium', tier: 1 },
      })
    );
    const out = formatDecompositionReport(baseRun(events), { toolExcerptLimit: 3 });
    expect(out).toContain('L1 molecule Potassium — 12 element call(s)');
    expect(out).toContain('first 3 call(s):');
    expect(out).toContain('9 more omitted');
  });

  it('ignores tool events attributed to tier 2/3 actors (L2 fallback writes)', () => {
    const run = baseRun([
      makeTool({ name: 'write_file', args: { path: 'index.html' }, actor: { name: 'Neuron', tier: 2 } }),
      makeTool({ name: 'write_file', args: { path: 'index.html' }, actor: { name: 'Potassium', tier: 1 } }),
    ]);
    const out = formatDecompositionReport(run);
    expect(out).toContain('L1 molecule Potassium — 1 element call(s)');
    expect(out).not.toMatch(/L1 molecule Neuron/);
  });
});
