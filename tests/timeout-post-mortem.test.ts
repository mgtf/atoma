import { describe, it, expect } from 'vitest';
import { formatTimeoutPostMortem } from '../src/viz/report.js';
import type { VizRun } from '../src/viz/trace.js';

/**
 * Regression tests for fix #4 — the build-app post-mortem block that
 * runs on the error/timeout path. Its job is to turn an opaque
 * "AbortError" at 10min into a terminal-friendly diagnostic that
 * names (a) which atom was running last, (b) which tool dominated
 * the budget, (c) the last two validator rejections.
 *
 * The function walks `VizRun.events` only, so everything is
 * reproducible from a persisted `runs/*.json`.
 */

function baseRun(events: VizRun['events']): VizRun {
  return {
    id: 'test-run',
    label: 'test',
    task: { description: 't' },
    startedAt: '2026-01-01T00:00:00.000Z',
    events,
  };
}

describe('formatTimeoutPostMortem', () => {
  it('reports the last active agent and the LLM/tool call totals', () => {
    const run = baseRun([
      {
        id: 'l1',
        ts: 1,
        kind: 'llm',
        role: 'plan',
        model: 'haiku',
        actor: { name: 'Meristem', tier: 3 },
        systemPrompt: 's',
        userContent: 'u',
        response: '{"approved":true}',
        stopReason: 'end_turn',
        durationMs: 10,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        costUsd: 0.001,
      },
      {
        id: 't1',
        ts: 2,
        kind: 'tool',
        llmEventId: 'l1',
        actor: { name: 'Water', tier: 1 },
        name: 'write_file',
        args: { path: 'x' },
        durationMs: 5,
      },
    ]);
    const out = formatTimeoutPostMortem(run, { budgetMs: 600_000, isTimeout: true });
    expect(out).toMatch(/== post-mortem ==/);
    expect(out).toMatch(/2 total — 1 LLM call\(s\), 1 tool call\(s\)/);
    expect(out).toMatch(/last active agent: Water/);
    // Suggestion tailored for a timeout path
    expect(out).toMatch(/raise ATOMA_BUILD_TIMEOUT_MS above 600s/);
  });

  it('flags tool dominance when one tool ate >= 50% of a non-trivial tool budget', () => {
    const events: VizRun['events'] = [];
    // 8 validate_html calls, 2 write_file, 2 read_file — 8/12 = 67% dominance
    for (let i = 0; i < 8; i++) {
      events.push({
        id: `v${i}`, ts: i, kind: 'tool', llmEventId: 'l', name: 'validate_html',
        args: { url: 'http://x' }, durationMs: 100,
      });
    }
    for (let i = 0; i < 2; i++) {
      events.push({ id: `w${i}`, ts: 20 + i, kind: 'tool', llmEventId: 'l', name: 'write_file', args: {}, durationMs: 5 });
    }
    for (let i = 0; i < 2; i++) {
      events.push({ id: `r${i}`, ts: 30 + i, kind: 'tool', llmEventId: 'l', name: 'read_file', args: {}, durationMs: 2 });
    }
    const out = formatTimeoutPostMortem(baseRun(events), { budgetMs: 600_000, isTimeout: true });
    expect(out).toMatch(/validate_html ×8/);
    expect(out).toMatch(/validate_html dominated/);
    expect(out).toMatch(/67% of tool budget/);
  });

  it('surfaces the last two NEGATIVE validator rejections with phase + atom + reasoning', () => {
    const events: VizRun['events'] = [
      {
        id: 'v1', ts: 1, kind: 'llm', role: 'validate-result', model: 'haiku',
        actor: { name: 'Neuron', tier: 2 },
        systemPrompt: 's', userContent: 'u',
        response: '{"approved":false,"reasoning":"first rejection: 404 on GET /"}',
        stopReason: 'end_turn', durationMs: 5,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        costUsd: 0.001,
      },
      {
        id: 'v2', ts: 2, kind: 'llm', role: 'validate-result', model: 'haiku',
        actor: { name: 'Neuron', tier: 2 },
        systemPrompt: 's', userContent: 'u',
        response: '{"approved":false,"reasoning":"second rejection: smoke oscillating"}',
        stopReason: 'end_turn', durationMs: 5,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        costUsd: 0.001,
      },
    ];
    const out = formatTimeoutPostMortem(baseRun(events), { budgetMs: 600_000, isTimeout: true });
    expect(out).toMatch(/last validator rejections \(newest first\)/);
    expect(out).toMatch(/\[RESULT by Neuron\] second rejection: smoke oscillating/);
    expect(out).toMatch(/\[RESULT by Neuron\] first rejection: 404 on GET \//);
  });

  it('emits a non-timeout suggestion line when isTimeout is false', () => {
    const run = baseRun([]);
    const out = formatTimeoutPostMortem(run, { budgetMs: 600_000, isTimeout: false });
    expect(out).not.toMatch(/raise ATOMA_BUILD_TIMEOUT_MS/);
    expect(out).toMatch(/inspect the last LLM call/);
  });

  it('does not crash on an empty run and still produces a coherent report', () => {
    const out = formatTimeoutPostMortem(baseRun([]), { budgetMs: 600_000, isTimeout: true });
    expect(out).toMatch(/post-mortem/);
    expect(out).toMatch(/0 total — 0 LLM call\(s\), 0 tool call\(s\)/);
  });
});
