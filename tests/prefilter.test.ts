import { describe, it, expect } from 'vitest';
import {
  prefilterStrategy,
  PREFILTER_SYSTEM_PROMPT,
} from '../src/atoms/cost.js';
import { PIN_HAIKU } from '../src/core/models.js';
import { makeCtx, jsonText } from './helpers.js';

describe('prefilterStrategy', () => {
  it('returns null when the catalog is empty (no Haiku call)', async () => {
    const ctx = makeCtx();
    const outcome = await prefilterStrategy({ ctx, task: { description: 't' }, catalog: [] });
    expect(outcome).toBeNull();
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('picks reuse when Haiku finds a clear match', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Hydrogen',
        confidence: 'high',
        reasoning: 'matches',
      })
    );
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 'fetch a url' },
      catalog: [
        { name: 'Hydrogen', description: 'fetches arbitrary URLs' },
        { name: 'Helium', description: 'writes files' },
      ],
    });
    expect(outcome).toEqual({
      kind: 'reuse',
      target: 'Hydrogen',
      confidence: 'high',
      reasoning: 'matches',
    });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.model).toBe(PIN_HAIKU);
    expect(ctx.llm.calls[0]!.systemPrompt).toBe(PREFILTER_SYSTEM_PROMPT);
  });

  it('returns escalate when Haiku says so', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'nothing matches' }));
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 'do a weird thing' },
      catalog: [{ name: 'Hydrogen', description: 'fetches URLs' }],
    });
    expect(outcome?.kind).toBe('escalate');
  });

  it('escalates when Haiku returns a target not in the catalog', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Plutonium',
        confidence: 'high',
        reasoning: 'imagined',
      })
    );
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 't' },
      catalog: [{ name: 'Hydrogen', description: 'h' }],
    });
    expect(outcome?.kind).toBe('escalate');
  });

  it('escalates when Haiku picks reuse with low confidence', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Hydrogen',
        confidence: 'low',
        reasoning: 'only available option but HTML-centric, task is Node/REST',
      })
    );
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 'build a Node REST API' },
      catalog: [{ name: 'Hydrogen', description: 'writes HTML, validates via headless browser' }],
    });
    expect(outcome?.kind).toBe('escalate');
    if (outcome?.kind === 'escalate') {
      expect(outcome.reasoning).toMatch(/low-confidence/);
    }
  });

  it('escalates when Haiku picks reuse but omits confidence (conservative default)', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', reasoning: 'plausible' })
    );
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 't' },
      catalog: [{ name: 'Hydrogen', description: 'generic builder' }],
    });
    expect(outcome?.kind).toBe('escalate');
  });

  it('escalates on LLM failure instead of throwing', async () => {
    const ctx = makeCtx();
    // no queued response — MockLlmClient throws
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 't' },
      catalog: [{ name: 'Hydrogen', description: 'h' }],
    });
    expect(outcome?.kind).toBe('escalate');
  });

  it('uses tight params (temp=0, small maxTokens)', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'x' }));
    await prefilterStrategy({
      ctx,
      task: { description: 't' },
      catalog: [{ name: 'Hydrogen', description: 'h' }],
    });
    const params = ctx.llm.calls[0]!.params;
    expect(params?.temperature).toBe(0);
    expect(params?.maxTokens).toBeLessThanOrEqual(256);
  });
});
