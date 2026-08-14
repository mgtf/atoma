import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceRecorder, type VizLlmEvent } from '../src/viz/trace.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import type { LlmClient, LlmCompletionResponse } from '../src/core/types.js';

/**
 * RecordingLlmClient accounting parity with MetricsLlmClient
 * (review 2026-08-14 §1.13).
 *
 * The two observability layers used to DISAGREE about the same failed
 * call: MetricsLlmClient read the error's `partialUsage` (e15d810) while
 * this recorder hardcoded zero usage and costUsd 0 — so the burn-in CSV
 * priced the partial tokens and the trace said the identical event cost
 * $0.00. And on success, cost was computed from the tier pin while three
 * transports rewrite the served model — `codex:claude-opus-5` billed at
 * the /opus/i row for gpt-5.6-sol tokens.
 */

function makeTmpRecorder(): { recorder: TraceRecorder; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-recording-usage-'));
  const recorder = new TraceRecorder(dir);
  recorder.beginRun({ description: 't' });
  return { recorder, dir };
}

function llmEventOf(recorder: TraceRecorder): VizLlmEvent {
  const ev = recorder.currentRun!.events.find((e): e is VizLlmEvent => e.kind === 'llm');
  expect(ev).toBeDefined();
  return ev!;
}

describe('RecordingLlmClient — partial usage on error (parity with MetricsLlmClient)', () => {
  it('records the tokens attached to the error and prices them, instead of $0.00', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const dying: LlmClient = {
        async complete(): Promise<LlmCompletionResponse> {
          const err = new Error('deadline abort on round 7') as Error & {
            partialUsage?: Record<string, number>;
          };
          // What a transport's raise path attaches: six rounds already paid.
          err.partialUsage = {
            inputTokens: 1200,
            outputTokens: 3400,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 90_000,
          };
          throw err;
        },
      };
      const rec = new RecordingLlmClient(dying, recorder);
      await expect(
        rec.complete({ model: 'claude-haiku-4-5', systemPrompt: 's', userContent: 'u' })
      ).rejects.toThrow(/deadline abort/);
      const ev = llmEventOf(recorder);
      expect(ev.stopReason).toBe('error');
      expect(ev.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 3400,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 90_000,
      });
      // Haiku row: (1200×$1 + 90k×$0.1 + 500×$1×1.25 + 3400×$5) / 1M
      expect(ev.costUsd).toBeCloseTo(0.027825, 6);
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an error WITHOUT partialUsage still records zeros — no fabricated tokens', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const boom: LlmClient = {
        async complete(): Promise<LlmCompletionResponse> {
          throw new Error('socket hang up');
        },
      };
      const rec = new RecordingLlmClient(boom, recorder);
      await expect(
        rec.complete({ model: 'claude-haiku-4-5', systemPrompt: 's', userContent: 'u' })
      ).rejects.toThrow('socket hang up');
      const ev = llmEventOf(recorder);
      expect(ev.usage.inputTokens).toBe(0);
      expect(ev.costUsd).toBe(0);
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RecordingLlmClient — served-model-aware pricing', () => {
  it('prices on servedModel while keeping the pin as the event model (routing identity)', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const codexLike: LlmClient = {
        async complete(): Promise<LlmCompletionResponse> {
          return {
            text: 'plan',
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 1_000_000 },
            servedModel: 'gpt-5.6-sol',
          };
        },
      };
      const rec = new RecordingLlmClient(codexLike, recorder);
      await rec.complete({ model: 'codex:claude-opus-5', systemPrompt: 's', userContent: 'u' });
      const ev = llmEventOf(recorder);
      // The pin stays the displayed routing identity…
      expect(ev.model).toBe('codex:claude-opus-5');
      // …the served identity rides alongside…
      expect(ev.servedModel).toBe('gpt-5.6-sol');
      // …and pricing follows it: 1M output @ $30 (the /opus/i row says $25).
      expect(ev.costUsd).toBeCloseTo(30, 3);
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits servedModel from the event when the transport served the pin verbatim', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const verbatim: LlmClient = {
        async complete(): Promise<LlmCompletionResponse> {
          return {
            text: 'ok',
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        },
      };
      const rec = new RecordingLlmClient(verbatim, recorder);
      await rec.complete({ model: 'claude-opus-5', systemPrompt: 's', userContent: 'u' });
      const ev = llmEventOf(recorder);
      expect(ev.model).toBe('claude-opus-5');
      expect(ev.servedModel).toBeUndefined();
      expect('servedModel' in ev).toBe(false); // additive: old-trace shape preserved
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
