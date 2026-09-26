import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { parseBrowserObservation, parseExecutionObservation, renderObservation } from '../src/contracts/attestation.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import type { LlmCompletionRequest, LlmCompletionResponse, ToolExecutor } from '../src/core/types.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * WHAT THE ATTESTATION LOG HOLDS: the WORKER's tool calls, with the facts a
 * validator needs to judge them (2026-09-25 review, 1.4, 1.6, 2.10).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const browserResult = (width: number) => ({
  ok: true, url: 'http://127.0.0.1:4000/', errors: [], warnings: [], failedRequests: [], interactionLog: [],
  requestedInteractions: 0, ignoredInteractions: 0, viewport: { width, height: 600 },
  document: { path: 'index.html', sha256: 'a'.repeat(64) }, smokeResult: { ok: true },
});
const reply = (value: unknown): LlmCompletionResponse => ({
  text: jsonText(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
});
const declare = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } });

describe('the attested browser observation', () => {
  it('carries the size the page was laid out at, so 320px and 800px proofs differ', () => {
    const at320 = parseBrowserObservation({ url: 'http://127.0.0.1:4000/', viewport: { width: 320 } }, browserResult(320))!;
    const at800 = parseBrowserObservation({ url: 'http://127.0.0.1:4000/' }, browserResult(800))!;
    expect(at320).toMatchObject({ viewport: { width: 320, height: 600 } });
    const line = (observation: typeof at320) => renderObservation({ eventId: 'e', tool: 'validate_html', observation });
    expect(line(at320)).toContain('viewport=320x600');
    expect(line(at320)).not.toBe(line(at800));
    // Observations recorded before the field existed still parse.
    const { viewport: _viewport, ...legacy } = browserResult(800);
    expect(parseBrowserObservation({}, legacy)?.viewport).toBeUndefined();
  });

  it('shows the validator what a smoke asserted, not only what it returned (production run 5a5f1e27)', () => {
    // The check was named `controlsVisible`; the 44px requirement lived in the
    // expression, which the line dropped, and the delivery was refused for it.
    const smoke = "(() => { const controls = [...document.querySelectorAll('input,button')]; const checks = { controlsVisible: controls.every(el => el.getBoundingClientRect().height >= 44) }; return { ok: Object.values(checks).every(Boolean), checks }; })()";
    const observation = parseBrowserObservation({ url: 'http://127.0.0.1:4000/', smoke, viewport: { width: 320 } }, browserResult(320))!;
    const line = renderObservation({ eventId: 'e', tool: 'validate_html', observation });
    expect(line).toContain('height >= 44');
    expect(line.indexOf('smoke=')).toBeLessThan(line.indexOf('smokeResult='));
    const long = parseBrowserObservation({ smoke: `(() => { ${'x'.repeat(5000)} })()` }, browserResult(800))!;
    const bounded = renderObservation({ eventId: 'e', tool: 'validate_html', observation: long });
    expect(bounded).toContain('[truncated]');
    expect(bounded.length).toBeLessThan(1200);
  });

  it('attests record_probe, the shell evidence tool, like run_shell', () => {
    expect(parseExecutionObservation('record_probe', { cmd: 'node test.js' }, { exitCode: 0 })).toMatchObject({ kind: 'execution' });
  });
});

describe('the result validator prompt', () => {
  it('keeps the browser observations however many file reads follow them', async () => {
    const names = ['write_file', 'read_file', 'validate_html'];
    const child = new L1Atom({ name: 'Methane', ordinal: 2, systemPrompt: 'full stack', tools: names.map(declare), params: {} });
    const attestations = createAttestationLog();
    const base: ToolExecutor = {
      has: (name) => names.includes(name),
      execute: async (name, args) => name === 'validate_html'
        ? { ...browserResult(800), requestedInteractions: 8, ignoredInteractions: 8 }
        : { path: args['path'], content: 'const x = 1; '.repeat(200) },
    };
    const ctx = { ...makeCtx(), attestations, currentBranchId: 'phase-1', attempt: 1,
      tools: attestingExecutor(base, attestations, 'phase-1', undefined, 1)! };
    ctx.llm.enqueue(async (req: LlmCompletionRequest) => {
      await req.executor!.execute('validate_html', { url: 'http://127.0.0.1:4000/', smoke: '({ok:true})' });
      for (let i = 0; i < 20; i += 1) await req.executor!.execute('read_file', { path: `src/file${i}.js` });
      return reply({ output: { files: ['index.html'] }, summary: 'done' });
    });
    const result = await child.execute({ description: 'Build a page' }, makePlan({ proposedAction: 'build' }), ctx);
    ctx.llm.enqueue(reply({ approved: true, reasoning: 'ok' }));
    await llmVerdict({ ctx, model: 'api:anthropic:claude-haiku-4-5-20251001', supervisorName: 'Sclereid', supervisorTier: 2, child,
      task: { description: 'Build a page' }, subject: 'RESULT', payload: { output: result.output, summary: result.summary },
      evidence: result.evidence ?? [], groundTruthBlock: '' });
    const prompt = ctx.llm.calls.at(-1)!.userContent;
    expect(prompt).toMatch(/validate_html: ok=true, requested=8, executed=0, FILTERED=8, viewport=800x600/);
    expect(prompt).toMatch(/earlier observations omitted/);
  });
});

describe("a supervisor probe is never the child's evidence (review 1.4)", () => {
  it('keeps the L2 ground-truth reads out of the evidence its next validator reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-actors-'));
    dirs.push(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };
    reg.create(2, seed);
    const names = ['write_file', 'read_file', 'fetch_url', 'start_node_server', 'validate_html'];
    const l1 = reg.create(1, { ...seed, description: 'full stack builder', systemPrompt: 'You are an L1.', tools: names.map(declare) });
    const files: Record<string, string> = {};
    const base: ToolExecutor = {
      has: (name) => names.includes(name) || name === 'list_files',
      execute: async (name, args) => {
        const path = String(args['path']);
        if (name === 'write_file') { files[path] = String(args['content']); return { ok: true }; }
        if (name === 'read_file') {
          if (!(path in files)) throw new Error(`ENOENT ${path}`);
          return { path, content: files[path] };
        }
        if (name === 'list_files') return { path: '.', entries: Object.keys(files).map((file) => ({ name: file, kind: 'file' })) };
        if (name === 'validate_html') return { ...browserResult(800), requestedInteractions: 8, ignoredInteractions: 8 };
        if (name === 'fetch_url') return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
        return { ok: true };
      },
    };
    const ctx = { ...makeCtx(), tools: base };
    let executes = 0;
    let verdicts = 0;
    const deliverables = ['index.html', 'server.js', 'a.js', 'b.js', 'c.js', 'd.js'];
    const turn = async (req: LlmCompletionRequest): Promise<LlmCompletionResponse> => {
      if (req.role === 'prefilter') return reply({ kind: 'reuse', target: l1.name, confidence: 'high', reasoning: 't' });
      if (req.role === 'plan' && req.actor?.tier === 1) return reply({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' });
      if (req.role === 'validate-plan') return reply({ approved: true, reasoning: 'plan ok' });
      if (req.role === 'execute') {
        executes += 1;
        if (executes === 1) {
          for (const file of deliverables) {
            await req.executor!.execute('write_file', { path: file, content: `// ${file}\n` + 'export const value = 1; '.repeat(120) });
          }
          await req.executor!.execute('validate_html', { url: 'http://localhost:5051/', smoke: '({ok:true})' });
        } else {
          await req.executor!.execute('write_file', { path: 'a.js', content: `// a.js v${executes}` });
        }
        return reply({ output: { url: 'http://localhost:5051/api', files: deliverables }, summary: `cycle ${executes} done` });
      }
      if (req.role === 'validate-result') {
        verdicts += 1;
        return reply(verdicts <= 3
          ? { approved: false, reasoning: `distinct gap ${verdicts}`, scope: 'ephemeral', modifications: {} }
          : { approved: true, reasoning: 'ok' });
      }
      throw new Error(`unexpected role ${String(req.role)}`);
    };
    for (let i = 0; i < 40; i += 1) ctx.llm.enqueue(turn);
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], new SkillRegistry(dir));
    await l2.handleDirect({ description: 'Build an app' }, ctx);
    const prompts = ctx.llm.calls.filter((call) => call.role === 'validate-result');
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    const last = prompts.at(-1)!.userContent;
    const block = last.slice(last.indexOf('== TRANSPORT-OBSERVED TOOL EVIDENCE =='));
    // The child read nothing itself: no read_file line may be attributed to it.
    expect(block).not.toMatch(/: read_file \(/);
    expect(block).toMatch(/FILTERED=8/);
  });
});
