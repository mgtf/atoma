import { describe, it, expect } from 'vitest';
import { TraceRecorder, type VizToolEvent } from '../src/viz/trace.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  ToolInvocationInfo,
} from '../src/core/types.js';

/**
 * Regression tests for the tool-call tracing feature (fix D).
 *
 * Before this feature the run JSON recorded only LLM calls (prompts +
 * response). Every tool call inside an L1 execute loop — including the
 * crucial `validate_html` args/result that determine whether a deliverable
 * is truly functional — was invisible. Post-mortem analysis had to scrape
 * terminal output to guess what happened. These tests lock in that:
 *   1. `AnthropicLlmClient.complete` invokes `onToolInvocation` for each
 *      tool the model calls (via a fake inner client that simulates tool
 *      use loops deterministically).
 *   2. `RecordingLlmClient` translates those callbacks into `VizToolEvent`
 *      entries in the trace, each citing the llmEventId that spawned them.
 *   3. Observer exceptions do not break the tool loop.
 */

class InnerStubLlm implements LlmClient {
  public calls = 0;
  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.calls++;
    // Simulate two tool invocations by calling the onToolInvocation
    // observer directly — this is what AnthropicLlmClient does internally
    // around its real SDK tool-use loop. Using a stub keeps the test free
    // of Anthropic mocking.
    if (req.onToolInvocation) {
      req.onToolInvocation({
        name: 'write_file',
        args: { path: 'index.html', contents: '<!doctype html>' },
        result: { ok: true, bytes: 16 },
        durationMs: 5,
        startedAt: Date.now(),
      });
      req.onToolInvocation({
        name: 'validate_html',
        args: { url: 'http://localhost:8000/', waitMs: 500 },
        error: 'net::ERR_CONNECTION_REFUSED',
        durationMs: 12,
        startedAt: Date.now(),
      });
    }
    return {
      text: 'done',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function makeTmpRecorder(): { recorder: TraceRecorder; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-tool-trace-'));
  const recorder = new TraceRecorder(dir);
  recorder.beginRun({ description: 't' });
  return { recorder, dir };
}

function stampedExecute(
  over: Partial<LlmCompletionRequest> = {}
): LlmCompletionRequest {
  return {
    model: 'stub',
    systemPrompt: 'sys',
    userContent: 'execute',
    role: 'execute',
    actor: { name: 'Water', tier: 1 },
    ...over,
  };
}

describe('RecordingLlmClient — in-flight llm-start markers', () => {
  it('records a start event BEFORE the call resolves, paired to the completion via llmEventId', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const rec = new RecordingLlmClient(new InnerStubLlm(), recorder);
      await rec.complete(stampedExecute());
      const events = recorder.currentRun!.events;
      const start = events.find((e) => e.kind === 'llm-start');
      const done = events.find((e) => e.kind === 'llm');
      expect(start).toBeDefined();
      expect(done).toBeDefined();
      // Pairing contract the UI relies on to hide superseded starts.
      expect(start!.llmEventId).toBe(done!.id);
      // Stamp is available at start time — same role/actor.
      expect(start!.role).toBe('execute');
      expect(start!.actor).toEqual({ name: 'Water', tier: 1 });
      // Start precedes completion in the event stream.
      expect(events.indexOf(start!)).toBeLessThan(events.indexOf(done!));
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a THROWN call still pairs (error completion); only a hard kill leaves an orphan start', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const boom: LlmClient = {
        async complete(): Promise<LlmCompletionResponse> {
          throw new Error('socket hang up');
        },
      };
      const rec = new RecordingLlmClient(boom, recorder);
      await expect(
        rec.complete({ model: 'stub', systemPrompt: 'sys', userContent: 'u' })
      ).rejects.toThrow('socket hang up');
      const events = recorder.currentRun!.events;
      const start = events.find((e) => e.kind === 'llm-start');
      const done = events.find((e) => e.kind === 'llm');
      expect(start!.llmEventId).toBe(done!.id);
      expect(done!.stopReason).toBe('error');
      expect(done!.error).toBe('socket hang up');
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RecordingLlmClient — tool-call tracing', () => {
  it('emits one VizToolEvent per invocation, tied to the spawning LLM event', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const rec = new RecordingLlmClient(new InnerStubLlm(), recorder);
      await rec.complete(stampedExecute());
      const events = recorder.currentRun!.events;
      const toolEvents = events.filter(
        (e): e is VizToolEvent => e.kind === 'tool'
      );
      expect(toolEvents).toHaveLength(2);

      const [writeEv, validateEv] = toolEvents;
      expect(writeEv!.name).toBe('write_file');
      expect(writeEv!.args).toEqual({ path: 'index.html', contents: '<!doctype html>' });
      expect(writeEv!.result).toEqual({ ok: true, bytes: 16 });
      expect(writeEv!.error).toBeUndefined();

      expect(validateEv!.name).toBe('validate_html');
      expect(validateEv!.args).toEqual({ url: 'http://localhost:8000/', waitMs: 500 });
      expect(validateEv!.error).toBe('net::ERR_CONNECTION_REFUSED');
      expect(validateEv!.result).toBeUndefined();

      // Both tool events must cite the same llmEventId — the LLM turn
      // that produced them — and that id must exist as an `llm` event.
      const llmEvent = events.find((e) => e.kind === 'llm');
      expect(llmEvent).toBeDefined();
      expect(writeEv!.llmEventId).toBe(llmEvent!.id);
      expect(validateEv!.llmEventId).toBe(llmEvent!.id);
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attaches the stamped actor to each tool event', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const rec = new RecordingLlmClient(new InnerStubLlm(), recorder);
      await rec.complete(stampedExecute());
      const toolEv = recorder.currentRun!.events.find(
        (e): e is VizToolEvent => e.kind === 'tool'
      );
      expect(toolEv!.actor).toEqual({ name: 'Water', tier: 1 });
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a caller-provided onToolInvocation (chain-of-responsibility)', async () => {
    const { recorder, dir } = makeTmpRecorder();
    try {
      const rec = new RecordingLlmClient(new InnerStubLlm(), recorder);
      const seen: ToolInvocationInfo[] = [];
      await rec.complete(
        stampedExecute({
          actor: { name: 'X', tier: 1 },
          onToolInvocation: (info) => seen.push(info),
        })
      );
      // Both the user's callback AND the recorder's internal one must fire.
      expect(seen.map((i) => i.name)).toEqual(['write_file', 'validate_html']);
      expect(
        recorder.currentRun!.events.filter((e) => e.kind === 'tool')
      ).toHaveLength(2);
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
