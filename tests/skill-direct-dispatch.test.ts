import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { RunContext, SkillEventInfo, ToolExecutor } from '../src/core/types.js';
import { MockLlmClient } from '../src/core/llm.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Tests for #C4 — DETERMINISTIC DISPATCH of trusted `kind: 'script'`
 * skills. When the skill prefilter matches a script skill whose own
 * counters pass the trust gate (3+ successes, 0 failures) and
 * `ctx.tools` is wired, L2 executes the script directly via
 * write_file + run_shell — zero LLM calls for the subtask (no L1
 * plan/execute, no validators). Any deviation (non-zero exit, missing
 * {"output","summary"} envelope, tool error, kill-switch env) falls
 * back to the normal inject-and-supervise path.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

const SCRIPT_BODY = `console.log(JSON.stringify({ output: { built: true }, summary: 'script ran clean' }));`;

const ENVELOPE_LINE = JSON.stringify({ output: { built: true }, summary: 'script ran clean' });

function makeExecutor(runShellResult: unknown): {
  executor: ToolExecutor;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const executor: ToolExecutor = {
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args });
      if (name === 'write_file') {
        return { ok: true, path: args['path'], bytes: String(args['content'] ?? '').length };
      }
      if (name === 'run_shell') return runShellResult;
      throw new Error(`unexpected tool: ${name}`);
    },
    has(name: string): boolean {
      return name === 'write_file' || name === 'run_shell';
    },
  };
  return { executor, calls };
}

describe('L2.runSubtask — deterministic script dispatch (C4)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-direct-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
    envBefore = process.env['ATOMA_SKILL_DIRECT'];
    delete process.env['ATOMA_SKILL_DIRECT'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env['ATOMA_SKILL_DIRECT'];
    else process.env['ATOMA_SKILL_DIRECT'] = envBefore;
  });

  function trustAtomType(): void {
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Hydrogen');
  }

  function saveScriptSkill(successes: number): void {
    skills.save('Hydrogen', {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'script',
      language: 'node',
      body: SCRIPT_BODY,
    });
    for (let i = 0; i < successes; i++) skills.recordSuccess('Hydrogen', 'scaffold-config');
  }

  function makeCtxWith(
    executor: ToolExecutor,
    events?: SkillEventInfo[]
  ): RunContext & { llm: MockLlmClient } {
    const base = makeCtx();
    return {
      ...base,
      tools: executor,
      ...(events ? { recordSkill: (e: SkillEventInfo) => events.push(e) } : {}),
    };
  }

  it('runs a TRUSTED script skill with zero LLM calls beyond the two prefilters', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES); // 3/0 — trusted
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const events: SkillEventInfo[] = [];
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor, events);

    // ONLY the two prefilter replies are queued. If the dispatch fell
    // through to the LLM loop, MockLlmClient would throw "no queued
    // reply" on the L1 plan call — that's the strongest assertion that
    // the fast-path really made zero further LLM calls.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(result.output).toEqual({ built: true });
    expect(result.summary).toBe('script ran clean');
    expect(result.producedBy).toEqual({ tier: 1, name: 'Hydrogen', viaFallback: false });

    // The two tool calls mirror skillContextBlock's calling convention.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      name: 'write_file',
      args: { path: '_skill_scaffold-config.js', content: SCRIPT_BODY },
    });
    expect(calls[1]!.name).toBe('run_shell');
    expect(calls[1]!.args).toEqual({
      command: 'node',
      args: ['_skill_scaffold-config.js', JSON.stringify('scaffold the config')],
    });

    // Skill success counter bumped by the dispatch itself (the supervise
    // loop never ran, so its onApproved hook could not).
    const loaded = skills.loadFor('Hydrogen').find((s) => s.id === 'scaffold-config')!;
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
    expect(loaded.failures).toBe(0);

    // Event stream: match → direct → success, and NO inject (the body
    // never entered any prompt).
    expect(events.map((e) => e.op)).toEqual(['match', 'direct', 'success']);
  });

  it('does NOT dispatch an untrusted script skill (falls through to the LLM loop)', async () => {
    trustAtomType();
    saveScriptSkill(0); // 0/0 — below the trust threshold
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' });
    const events: SkillEventInfo[] = [];
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor, events);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    // L1.plan + L1.execute — the normal skilled path.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
    // No direct tool calls happened (the L1's mocked execute made none).
    expect(calls).toHaveLength(0);
    // The script body was injected for the LLM path instead.
    expect(ctx.llm.calls[2]!.systemPrompt).toMatch(/== ACTIVE SKILL: scaffold-config/);
    expect(events.map((e) => e.op)).toEqual(['match', 'inject', 'success']);
  });

  it('falls back to the LLM loop when the script exits non-zero — without bumping the failure counter', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const { executor, calls } = makeExecutor({ exitCode: 1, stdout: '', stderr: 'boom' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'saved by the loop', summary: 'llm path ok' }));

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('llm path ok');
    // The direct attempt DID try both tools before giving up.
    expect(calls.map((c) => c.name)).toEqual(['write_file', 'run_shell']);
    // A deterministic failure is NOT a skill failure: the LLM loop got
    // its shot and approved, so the skill records a success.
    const loaded = skills.loadFor('Hydrogen').find((s) => s.id === 'scaffold-config')!;
    expect(loaded.failures).toBe(0);
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
  });

  it('treats a self-reported FAILED envelope as off-contract even on exit 0', async () => {
    // The deterministic path has no validator downstream, and a compiled
    // script can announce its own failure while still exiting 0 — measured on
    // the freshly-promoted `document-cli-from-source`:
    //   {"output":null,"summary":"FAILED: index.js ... not found ..."}  EXIT=0
    // Accepting that credited a success and entrenched a broken script.
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const failEnvelope = JSON.stringify({
      output: null,
      summary: 'FAILED: index.js and/or package.json not found in workspace.',
    });
    const { executor } = makeExecutor({ exitCode: 0, stdout: failEnvelope, stderr: '' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    // The LLM loop must take over.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done properly', summary: 'ok' }));

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });

  it('treats output:null as off-contract (no silent success on a null deliverable)', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const nullOut = JSON.stringify({ output: null, summary: 'wrote nothing, all good!' });
    const { executor } = makeExecutor({ exitCode: 0, stdout: nullOut, stderr: '' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'scaffold the config' }, ctx);
    // And crucially: no success was credited to the skill by the direct path.
    const loaded = skills.loadFor('Hydrogen').find((s) => s.id === 'scaffold-config')!;
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1); // from the LLM loop only
    expect(loaded.failures).toBe(0);
  });

  it('falls back to the LLM loop when stdout carries no {"output","summary"} envelope', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const { executor } = makeExecutor({ exitCode: 0, stdout: 'plain text, no envelope', stderr: '' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });

  it('honours the ATOMA_SKILL_DIRECT=0 kill switch', async () => {
    process.env['ATOMA_SKILL_DIRECT'] = '0';
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: ENVELOPE_LINE, stderr: '' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
    expect(calls).toHaveLength(0);
  });

  it('does not dispatch when ctx.tools is absent (research-brief-style runs)', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx(); // no tools

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });
});

describe('SkillRegistry.resetCounters', () => {
  let dir: string;
  let skills: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-reset-'));
    skills = new SkillRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('zeroes counters AND clears the promotion-refusal stamp', () => {
    skills.save('Hydrogen', {
      id: 'some-skill',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    skills.recordSuccess('Hydrogen', 'some-skill');
    skills.recordFailure('Hydrogen', 'some-skill');
    skills.markPromotionRefused('Hydrogen', 'some-skill');

    const meta = skills.resetCounters('Hydrogen', 'some-skill');
    expect(meta).toEqual(
      expect.objectContaining({ successes: 0, failures: 0 })
    );
    const loaded = skills.loadFor('Hydrogen').find((s) => s.id === 'some-skill')!;
    expect(loaded.successes).toBe(0);
    expect(loaded.failures).toBe(0);
    expect(loaded.promotionRefusedAt).toBeUndefined();
  });

  it('returns null for a skill that does not exist', () => {
    expect(skills.resetCounters('Hydrogen', 'ghost')).toBeNull();
  });

  it('listNamespaces enumerates L1 folders (sorted), empty store yields []', () => {
    expect(skills.listNamespaces()).toEqual([]);
    skills.save('Lithium', { id: 'a-skill', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    skills.save('Hydrogen', { id: 'b-skill', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    expect(skills.listNamespaces()).toEqual(['Hydrogen', 'Lithium']);
  });
});
