import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { localToolBackend, withProjectRetrievalBackend } from '../src/run/toolBackend.js';
import { PROJECT_RETRIEVAL_TOOL_NAME as SEARCH } from '../src/contracts/projectRetrieval.js';
import type { RunContext } from '../src/core/types.js';
import { makeCtx, silentLogger } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import { retrievalTestBinding } from './helpers/projectRetrieval.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sdkWithSearch() {
  let id = 0;
  const delivered: unknown[] = [];
  const sdk = { messages: { create: async (params: { messages: { role: string; content: unknown }[] }) => {
    const last = params.messages.at(-1)!;
    const results = Array.isArray(last.content) ? last.content.filter((block: unknown) =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') : [];
    if (results.length) {
      delivered.push(...results);
      return { content: [{ type: 'text', text: '{"output":"19000","summary":"source consulted"}' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return { content: [{ type: 'tool_use', id: `search-${++id}`, name: SEARCH, input: { query: 'annual price' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
  return { delivered, client: new AnthropicLlmClient(sdk as unknown as ConstructorParameters<typeof AnthropicLlmClient>[0]) };
}

describe('host retrieval through L1, the transport scope gate and branch recording', () => {
  it.each([true, false])('honors the actual L1 declaration (search allowed=%s)', async allowed => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-l1-'));
    roots.push(root);
    const binding = retrievalTestBinding();
    const run = { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 };
    const backend = await withProjectRetrievalBackend(
      localToolBackend({ workspaceRoot: join(root, 'workspace'), logger: silentLogger() }), binding, run
    );
    const recorder = new TraceRecorder(join(root, 'traces'));
    recorder.beginRun({ description: 'source evidence test' });
    const sdk = sdkWithSearch();
    const ctx: RunContext = { ...makeCtx(), ...run, tools: backend.executor,
      llm: new RecordingLlmClient(sdk.client, recorder) };
    const atom = new L1Atom({ name: 'Ammonia', ordinal: 3, model: 'test', systemPrompt: 'Read the sources.',
      tools: backend.toolDecls.filter(tool => allowed || tool.name !== SEARCH), params: { temperature: 0 } });
    try {
      const results = await Promise.all(['branch-a', 'branch-b'].map(branch => atom.execute(
        { description: 'Find the annual price.' }, makePlan(), forkBranch(ctx, branch)
      )));
      const events = recorder.currentRun!.events.filter(event => event.kind === 'tool');
      expect(events).toHaveLength(2);
      expect(events.map(event => event.branchId).sort()).toEqual(['branch-a', 'branch-b']);
      expect(events.every(event => event.name === SEARCH && event.actor?.tier === 1)).toBe(true);
      expect(binding.service.search).toHaveBeenCalledTimes(allowed ? 2 : 0);
      for (const result of results) expect(result.toolCallResults).toEqual([{ name: SEARCH, ok: allowed }]);
      if (allowed) {
        const blocks = sdk.delivered as { content: string }[];
        expect(blocks.every(block => JSON.parse(block.content).passages[0].excerpt.includes('19000'))).toBe(true);
        expect(events.every(event => event.error === undefined)).toBe(true);
      } else {
        expect(events.every(event => typeof event.error === 'string')).toBe(true);
      }
      // Search observations do not widen the existing closed proof vocabulary.
      expect(ctx.attestations?.size).toBe(0);
    } finally { recorder.endRun(); await backend.cleanup(); }
    expect(binding.service.dispose).toHaveBeenCalledTimes(1);
  });
});
