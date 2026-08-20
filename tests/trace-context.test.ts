import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { citeContext, foldContextBlocks } from '../src/contracts/llmTrace.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import { TraceRecorder } from '../src/viz/trace.js';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from '../src/core/types.js';

class EchoLlm implements LlmClient {
  last: LlmCompletionRequest | null = null;
  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.last = req;
    return {
      text: '{"output":1,"summary":"ok"}',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function molecule(): L1Atom {
  return new L1Atom({
    name: 'Water',
    ordinal: 1,
    systemPrompt: 'You are Water.',
    tools: [
      {
        name: 'write_file',
        description: 'write',
        inputSchema: { type: 'object' },
      },
    ],
    params: {},
  });
}

describe('context fold', () => {
  it('tags each inject by source instead of an anonymous index', () => {
    const folded = foldContextBlocks('base', [
      { id: 'c1', source: 'skill', skillId: 'web-build', text: 'STEP 1' },
      { id: 'c2', source: 'coaching', text: 'fix the harness' },
    ]);
    expect(folded).toContain('<!-- context source=skill skill=web-build -->');
    expect(folded).toContain('STEP 1');
    expect(folded).toContain('<!-- context source=coaching -->');
    expect(folded).not.toMatch(/<!-- context 1 -->/);
  });

  it('keeps a citation smaller than the body the model saw', () => {
    const cited = citeContext({
      id: 'c1',
      source: 'fallback-trace',
      text: 'x'.repeat(400),
    });
    expect(cited.chars).toBe(400);
    expect(cited.preview.endsWith('…')).toBe(true);
    expect(cited.preview.length).toBeLessThan(400);
  });
});

describe('Atom inject + toLlmRequest', () => {
  it('folds coaching from applyModifications and cites it on the request', () => {
    const atom = molecule();
    atom.applyModifications({ additionalContext: 'restore the probe harness' });
    const req = atom.toLlmRequest('plan', { userContent: 'plan' });
    expect(req.role).toBe('plan');
    expect(req.actor).toEqual({ name: 'Water', tier: 1 });
    expect(req.context).toEqual([
      expect.objectContaining({ source: 'coaching', text: 'restore the probe harness' }),
    ]);
    expect(req.systemPrompt).toContain('source=coaching');
    expect(req.systemPrompt).toContain('restore the probe harness');
    expect(foldContextBlocks('You are Water.', req.context ?? [])).toBe(req.systemPrompt);
  });
});

describe('RecordingLlmClient cites injects', () => {
  it('does not invent a role from prompt markers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-trace-nostamp-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun({ description: 't' });
    const rec = new RecordingLlmClient(new EchoLlm(), recorder);
    try {
      await rec.complete({
        model: 'stub',
        systemPrompt:
          'You validate agent outputs in a three-tier LLM orchestration system.',
        userContent:
          'Supervisor: "Tracheid" (tier 2)\nChild: "Water" (tier 1)\nPLAN:\n{}',
      });
      const llm = recorder.currentRun!.events.find((event) => event.kind === 'llm');
      expect(llm).toMatchObject({ role: 'unknown' });
      expect(llm).not.toHaveProperty('actor');
      expect(llm).not.toHaveProperty('subject');
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a context event once and cites it on the llm event with tool names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-trace-context-'));
    const recorder = new TraceRecorder(dir);
    recorder.beginRun({ description: 't' });
    const inner = new EchoLlm();
    const rec = new RecordingLlmClient(inner, recorder);
    const atom = molecule();
    atom.injectContext({
      source: 'skill',
      skillId: 'web-build-loop',
      text: 'STEP 1: write_file index.html',
    });
    try {
      const first = atom.toLlmRequest('execute', {
        userContent: 'go',
        tools: atom.toolNames().map((name) => ({
          name,
          description: 'd',
          inputSchema: { type: 'object' },
        })),
      });
      await rec.complete(first);
      await rec.complete(atom.toLlmRequest('plan', { userContent: 'again' }));

      const events = recorder.currentRun!.events;
      const contextEvents = events.filter((event) => event.kind === 'context');
      const llmEvents = events.filter((event) => event.kind === 'llm');
      expect(contextEvents).toHaveLength(1);
      expect(contextEvents[0]).toMatchObject({
        kind: 'context',
        source: 'skill',
        skillId: 'web-build-loop',
      });
      expect(llmEvents).toHaveLength(2);
      expect(llmEvents[0]).toMatchObject({
        role: 'execute',
        actor: { name: 'Water', tier: 1 },
        toolNames: ['write_file'],
      });
      expect(llmEvents[0]!.context).toEqual([
        expect.objectContaining({
          id: contextEvents[0]!.id,
          source: 'skill',
          skillId: 'web-build-loop',
        }),
      ]);
      expect(llmEvents[1]!.context?.[0]?.id).toBe(contextEvents[0]!.id);
      expect(events.indexOf(contextEvents[0]!)).toBeLessThan(
        events.findIndex((event) => event.kind === 'llm-start')
      );
    } finally {
      recorder.endRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
