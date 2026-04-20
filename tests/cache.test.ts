import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient } from '../src/core/llm.js';

describe('AnthropicLlmClient prompt caching', () => {
  it('marks system prompt with cache_control=ephemeral by default', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const fakeClient = { messages: { create } } as any;
    const llm = new AnthropicLlmClient(fakeClient);
    await llm.complete({
      model: 'x',
      systemPrompt: 'sys',
      userContent: 'u',
    });
    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0]![0];
    expect(args.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks last tool with cache_control=ephemeral', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const llm = new AnthropicLlmClient({ messages: { create } } as any);
    await llm.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        { name: 'a', description: 'a', inputSchema: {} },
        { name: 'b', description: 'b', inputSchema: {} },
      ],
    });
    const args = create.mock.calls[0]![0];
    expect(args.tools[0].cache_control).toBeUndefined();
    expect(args.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('can disable caching via flags', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const llm = new AnthropicLlmClient({ messages: { create } } as any);
    await llm.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      cacheSystem: false,
      tools: [{ name: 'a', description: 'a', inputSchema: {} }],
      cacheTools: false,
    });
    const args = create.mock.calls[0]![0];
    expect(args.system[0].cache_control).toBeUndefined();
    expect(args.tools[0].cache_control).toBeUndefined();
  });

  it('places a rolling cache_control breakpoint on the LAST tool_result in each tool-use iteration', async () => {
    // Regression test for the Haiku 4.5 cache miss (4096-token minimum).
    // Without a cache breakpoint on the growing conversation, the only
    // cached segment is the system prompt — which for L1 narrow agents
    // sits below the 4096-token threshold and therefore silently caches
    // nothing. A rolling breakpoint on tool_result keeps extending the
    // cached prefix as the tool-use loop iterates.
    const create = vi
      .fn()
      // Round 1 — model asks for two tools
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'calling tools' },
          { type: 'tool_use', id: 'tu_1', name: 'a', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'b', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      // Round 2 — model terminates
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 10 },
      });

    const executor = {
      execute: async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({
        ok: true,
      }),
    };

    const llm = new AnthropicLlmClient({ messages: { create } } as any);
    await llm.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        { name: 'a', description: 'a', inputSchema: {} },
        { name: 'b', description: 'b', inputSchema: {} },
      ],
      executor,
    });

    // Two round-trips to the API.
    expect(create).toHaveBeenCalledTimes(2);

    // Round 2's request should include the assistant tool_use turn and
    // the user tool_result turn we just built — the LAST tool_result
    // block must carry cache_control. The first tool_result must NOT.
    const round2 = create.mock.calls[1]![0];
    const lastUserMsg = round2.messages[round2.messages.length - 1];
    expect(lastUserMsg.role).toBe('user');
    const results = lastUserMsg.content as Array<
      { type: string; tool_use_id: string; cache_control?: unknown }
    >;
    expect(results).toHaveLength(2);
    expect(results[0]!.type).toBe('tool_result');
    expect(results[0]!.cache_control).toBeUndefined();
    expect(results[1]!.type).toBe('tool_result');
    expect(results[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('MOVES the rolling breakpoint forward — old tool_result cache_control is cleared (Anthropic caps at 4 per request)', async () => {
    // Regression for a 400 "A maximum of 4 blocks with cache_control may
    // be provided. Found 5." error observed in production. Fix: strip
    // prior cache_control markers from user-turn content before placing
    // a new one each iteration. The breakpoint MOVES with the
    // conversation rather than accumulating.
    const create = vi
      .fn()
      // Round 1 → tool_use
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'a', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 10 },
      })
      // Round 2 → tool_use
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'a', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 10 },
      })
      // Round 3 → tool_use
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_3', name: 'a', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 10 },
      })
      // Round 4 → final text
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      });

    const executor = {
      execute: async () => ({ ok: true }),
    };
    const llm = new AnthropicLlmClient({ messages: { create } } as any);
    await llm.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      tools: [{ name: 'a', description: 'a', inputSchema: {} }],
      executor,
    });

    expect(create).toHaveBeenCalledTimes(4);

    // Count total cache_control blocks in the final round's request.
    // Budget: 1 on system + 1 on last tool + 1 rolling on current user turn
    //       = 3. Never 4+, regardless of iteration count.
    const final = create.mock.calls[3]![0];
    let total = 0;
    for (const sb of final.system as Array<{ cache_control?: unknown }>) {
      if (sb.cache_control) total++;
    }
    for (const t of (final.tools ?? []) as Array<{ cache_control?: unknown }>) {
      if (t.cache_control) total++;
    }
    for (const m of final.messages as Array<{
      role: string;
      content: unknown;
    }>) {
      if (m.role !== 'user') continue;
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as Array<{ cache_control?: unknown }>) {
        if (block.cache_control) total++;
      }
    }
    expect(total).toBeLessThanOrEqual(4);
    expect(total).toBe(3);

    // And the ONE rolling breakpoint on user turns must be on the LAST
    // user message's last block (current round's tool_result), not on
    // any earlier user turn.
    const userTurns = (final.messages as Array<{
      role: string;
      content: unknown;
    }>).filter((m) => m.role === 'user');
    expect(userTurns.length).toBe(4); // initial task + 3 tool_result batches
    for (const u of userTurns.slice(0, -1)) {
      if (!Array.isArray(u.content)) continue;
      for (const block of u.content as Array<{ cache_control?: unknown }>) {
        expect(block.cache_control).toBeUndefined();
      }
    }
    const lastUser = userTurns[userTurns.length - 1]!;
    const lastBlock = (lastUser.content as Array<{
      cache_control?: unknown;
    }>).slice(-1)[0]!;
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('VALIDATION_SYSTEM_PROMPT — Haiku cache threshold', () => {
  it('is long enough to exceed the Claude Haiku 4.5 minimum cacheable prompt length (4096 tokens)', async () => {
    // Per Anthropic docs, Haiku 4.5 silently skips prompt caching below
    // 4096 tokens — cache_creation_input_tokens and cache_read_input_tokens
    // both return 0 regardless of cache_control markers. Earlier runs
    // showed every Haiku validator call with cache_read=0 because the
    // prompt was ~3000 tokens. The WORKED EXAMPLES section deliberately
    // extends the prompt past the threshold; this test guards against
    // accidental regression (e.g. someone trimming the examples and
    // inadvertently dropping caching for all Haiku validators).
    //
    // We use a conservative ~3.5 chars-per-token ratio. English prose
    // typically tokenises closer to 3.7-4 chars/token, so a character
    // count above 4096 * 3.5 = 14336 is a safe floor — this test will
    // start failing well before caching actually breaks in production.
    const { VALIDATION_SYSTEM_PROMPT } = await import('../src/atoms/L2Atom.js');
    const MIN_CHARS_FOR_HAIKU_CACHE = 14336;
    expect(VALIDATION_SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(
      MIN_CHARS_FOR_HAIKU_CACHE
    );
  });

  it('retains the WORKED EXAMPLES section (the padding that crosses the threshold)', async () => {
    const { VALIDATION_SYSTEM_PROMPT } = await import('../src/atoms/L2Atom.js');
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/== WORKED EXAMPLES ==/);
    // Each worked example follows the same "Example N —" shape; check a
    // few are present so trimming the section down trips the guard.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Example 1 — DELEGATION plan, approved/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Example 4 — DIRECT plan, rejected for materially wrong artefact/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Example 5 — RESULT, ground-truth evidence contradicts child/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Example 8 — BRANCH across domain/);
  });
});
