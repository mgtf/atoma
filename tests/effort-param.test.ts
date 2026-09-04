import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlmClient } from '../src/core/llm.js';

/**
 * The client sends `output_config: {effort}` only when the caller pins
 * an effort AND the model supports it (Haiku 4.5 rejects the param with
 * a 400). Plan/strategy call sites pin 'medium'; validators/prefilters
 * on Haiku must never carry it.
 */
function fakeSdk() {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  return {
    create,
    client: { messages: { create } } as unknown as Anthropic,
  };
}

describe('output_config.effort gating', () => {
  it('sends effort on an effort-capable model (Sonnet 5)', async () => {
    const { create, client } = fakeSdk();
    await new AnthropicLlmClient(client).complete({
      model: 'claude-sonnet-5',
      systemPrompt: 's',
      userContent: 'u',
      params: { maxTokens: 8000, effort: 'medium' },
    });
    expect(create.mock.calls[0]![0].output_config).toEqual({ effort: 'medium' });
  });

  it('OMITS effort on Haiku (the param errors there)', async () => {
    const { create, client } = fakeSdk();
    await new AnthropicLlmClient(client).complete({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 's',
      userContent: 'u',
      params: { effort: 'medium' },
    });
    expect(create.mock.calls[0]![0].output_config).toBeUndefined();
  });

  it('omits effort entirely when the caller did not ask for one', async () => {
    const { create, client } = fakeSdk();
    await new AnthropicLlmClient(client).complete({
      model: 'claude-sonnet-5',
      systemPrompt: 's',
      userContent: 'u',
      params: { maxTokens: 8000 },
    });
    expect(create.mock.calls[0]![0].output_config).toBeUndefined();
  });
});

describe('cliEffortFor — provider-agnostic tier pins (audit rank-2)', () => {
  it('a bare "sonnet"/"opus" alias KEEPS the effort pin', async () => {
    const { cliEffortFor } = await import('../src/core/llmClaudeCli.js');
    // ATOMA_MODEL_L3=sonnet arrives as req.model='sonnet' — the old gate
    // (modelSupportsEffort, anchored on /^claude-/) silently dropped the
    // pin, the one cost lever this transport has.
    for (const model of ['sonnet', 'opus', 'zai-sonnet-lookalike']) {
      const eff = cliEffortFor({
        model, systemPrompt: 's', userContent: 'u', params: { effort: 'medium' },
      } as never);
      if (model === 'zai-sonnet-lookalike') expect(eff).toBe('medium'); // resolves via /sonnet/i
      else expect(eff).toBe('medium');
    }
  });

  it('haiku-tier calls never carry effort; full claude ids keep the capability check', async () => {
    const { cliEffortFor } = await import('../src/core/llmClaudeCli.js');
    expect(
      cliEffortFor({ model: 'haiku', systemPrompt: 's', userContent: 'u', params: { effort: 'medium' } } as never)
    ).toBeUndefined();
    expect(
      cliEffortFor({ model: 'claude-sonnet-5', systemPrompt: 's', userContent: 'u', params: { effort: 'medium' } } as never)
    ).toBe('medium');
  });
});

describe('claude-cli transport: upstream 5xx text is retried, then thrown (web-tally incident)', () => {
  it('classifies transport-error text correctly', async () => {
    const { isCliTransportErrorText } = await import('../src/core/llmClaudeCli.js');
    expect(isCliTransportErrorText('API Error: 529 Overloaded. This is a server-side issue…')).toBe(true);
    expect(isCliTransportErrorText('API Error: 500 Internal')).toBe(true);
    // 4xx are real request errors the caller must see; JSON plans pass through.
    expect(isCliTransportErrorText('API Error: 400 Bad Request')).toBe(false);
    expect(isCliTransportErrorText('{"reasoning": "API Error: 529 mentioned in prose"}')).toBe(false);
  });
});

describe('claude-cli transport: an account refusal is named, not parsed', () => {
  it('recognises the refusals the tool actually emits, and nothing looser', async () => {
    const { isCliQuotaRefusalText } = await import('../src/core/llmClaudeCli.js');
    // MEASURED on a live project run, 2026-09-02. Before this the refusal
    // reached `parseTwoJson`, so the run died as `no JSON object found` with
    // the real cause — and the reset time — buried in the head of a parse
    // error.
    expect(
      isCliQuotaRefusalText(
        "You've hit your individual spend limit · run /usage-credits to ask your admin " +
          'for a higher limit · your session limit resets 6:50pm (Europe/Bucharest)'
      )
    ).toBe(true);
    expect(isCliQuotaRefusalText('Claude usage limit reached. Your limit will reset at 7pm.')).toBe(
      true
    );

    // A plan that DISCUSSES limits is not a refusal: the phrase has to be in
    // the head of the reply, which is where the CLI puts a refusal because it
    // passes one through as the whole turn.
    expect(
      isCliQuotaRefusalText(
        `{"reasoning": "${'x'.repeat(220)} the spend limit of the API", "plan": []}`
      )
    ).toBe(false);
    expect(isCliQuotaRefusalText('{"plan": ["document the rate limit policy"]}')).toBe(false);
    // And it is not the transient guard's job: an overload is retried, a limit
    // that resets in hours is not.
    expect(isCliQuotaRefusalText('API Error: 529 Overloaded')).toBe(false);
  });
});
