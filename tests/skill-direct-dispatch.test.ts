import { subtaskMutatesFiles, subtaskMutationTargets } from '../src/skills/lifecycle.js';
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

// The body WRITES (fs.writeFileSync). That matters since the capability
// filter added for round 7: a compiled script with no write surface is no
// longer offered for a subtask that asks a file to change, so a non-writing
// body here would never reach the deliverable gate these tests exercise.
const SCRIPT_BODY = `import fs from 'node:fs';\nfs.writeFileSync('out.txt', 'x');\nconsole.log(JSON.stringify({ output: { built: true }, summary: 'script ran clean' }));`;

const ENVELOPE_LINE = JSON.stringify({ output: { built: true }, summary: 'script ran clean' });

function enqueueExecutedResult(
  ctx: RunContext & { llm: MockLlmClient },
  payload: unknown
): void {
  ctx.llm.enqueue((req) => {
    req.onToolInvocation?.({
      name: 'write_file',
      args: { path: 'artefact.txt' },
      result: { ok: true },
      durationMs: 1,
      startedAt: Date.now(),
    });
    return {
      text: jsonText(payload),
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  });
}

function makeExecutor(runShellResult: unknown): {
  executor: ToolExecutor;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const executor: ToolExecutor = {
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args });
      if (name === 'write_file') {
        return { ok: true, path: args['path'], bytes: ((args['content'] as string | undefined) ?? '').length };
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

    // write + run mirror skillContextBlock's calling convention, then the
    // scratch script is removed — it is scaffolding, not deliverable, and
    // subtasks routinely assert the exact workspace contents afterwards.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      name: 'write_file',
      args: { path: '_skill_scaffold-config.mjs', content: SCRIPT_BODY },
    });
    expect(calls[1]!.name).toBe('run_shell');
    expect(calls[1]!.args).toEqual({
      command: 'node',
      args: ['_skill_scaffold-config.mjs', JSON.stringify('scaffold the config')],
    });
    expect(calls[2]!.name).toBe('run_shell');
    expect(calls[2]!.args['args']).toEqual([
      '-e',
      'require("fs").rmSync(process.argv[1],{force:true})',
      '_skill_scaffold-config.mjs',
    ]);

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
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

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
    enqueueExecutedResult(ctx, { output: 'saved by the loop', summary: 'llm path ok' });

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);

    expect(result.summary).toBe('llm path ok');
    // The direct attempt DID try both tools before giving up — and still
    // cleaned up its scratch file on the way out (the `finally`), so a failed
    // dispatch doesn't leave debris for the LLM loop to trip over.
    expect(calls.map((c) => c.name)).toEqual(['write_file', 'run_shell', 'run_shell']);
    expect(calls[2]!.args['args']).toContain('_skill_scaffold-config.mjs');
    // A deterministic failure is NOT a skill failure: the LLM loop got
    // its shot and approved, so the skill records a success.
    const loaded = skills.loadFor('Hydrogen').find((s) => s.id === 'scaffold-config')!;
    expect(loaded.failures).toBe(0);
    expect(loaded.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
  });

  it('DEMOTES a script back to its llm fallback after 2 consecutive deterministic failures', async () => {
    trustAtomType();
    // Reach kind:script the production way — promotion writes _fallback.md,
    // which is what demotion restores.
    skills.save('Hydrogen', {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'llm',
      body: '1. derive fields from the workspace.\n2. write_file config.\n3. read back.',
    });
    skills.promoteToScript({
      l1Name: 'Hydrogen',
      skillId: 'scaffold-config',
      language: 'node',
      scriptBody: SCRIPT_BODY,
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skills.recordSuccess('Hydrogen', 'scaffold-config');
    }
    // Brittle script: exits 1 on every run, LLM loop saves the subtask.
    const { executor } = makeExecutor({ exitCode: 1, stdout: '', stderr: 'REVERIFY-FAIL: nothing extracted' });

    for (const runLabel of ['first', 'second'] as const) {
      const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
      const events: SkillEventInfo[] = [];
      const ctx = makeCtxWith(executor, events);
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
      );
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
      );
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      enqueueExecutedResult(ctx, {
        output: 'saved by the loop',
        summary: `llm ok (${runLabel})`,
      });
      const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
      expect(result.summary).toBe(`llm ok (${runLabel})`);
      if (runLabel === 'first') {
        // Streak at 1 — still a script, no demotion yet.
        expect(skills.loadFor('Hydrogen')[0]!.kind).toBe('script');
        expect(skills.loadFor('Hydrogen')[0]!.directFailures).toBe(1);
      } else {
        // Streak hit 2 — demoted, original llm recipe restored, and the
        // demotion is visible in the event stream.
        const demoted = skills.loadFor('Hydrogen')[0]!;
        expect(demoted.kind).toBe('llm');
        expect(demoted.body).toMatch(/derive fields from the workspace/);
        expect(events.some((e) => e.op === 'demote')).toBe(true);
        // save() during demotion cleared the streak with the body rewrite.
        expect(demoted.directFailures).toBeUndefined();
        // Anti-oscillation: without the stamp, the restored llm form would
        // re-earn 5/0, recompile the SAME body, produce the SAME brittle
        // script, and loop forever. Cleared only by a body revision.
        expect(demoted.promotionRefusedAt).toBeTruthy();
        expect(demoted.promotionRefusedReason).toMatch(/auto-demoted/);
      }
    }
  });

  it('a deterministic SUCCESS clears the failure streak', async () => {
    trustAtomType();
    saveScriptSkill(TRUST_THRESHOLD_SUCCESSES);
    skills.markDirectFailure('Hydrogen', 'scaffold-config');
    expect(skills.loadFor('Hydrogen')[0]!.directFailures).toBe(1);
    const { executor } = makeExecutor({ exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtxWith(executor);
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('script ran clean');
    expect(skills.loadFor('Hydrogen')[0]!.directFailures).toBeUndefined();
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
    enqueueExecutedResult(ctx, { output: 'done properly', summary: 'ok' });

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
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

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
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    expect(ctx.llm.calls).toHaveLength(4);
  });

  it('never RUNS a script whose body cannot emit the envelope (pre-flight gate)', async () => {
    trustAtomType();
    // A hand-authored script written against a different calling convention:
    // positional argv, prose stdout. Dispatching it would write a bogus
    // artefact (its argv[0] is the whole JSON-encoded subtask description)
    // BEFORE the envelope parse could reject it, leaving the LLM loop to
    // clean up after a side effect it didn't cause. The gate must skip the
    // run entirely, not run-then-reject.
    skills.save('Hydrogen', {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'script',
      language: 'node',
      body: [
        `const fs = require('fs');`,
        `const name = process.argv[2];`,
        `fs.writeFileSync('config.json', JSON.stringify({ name }));`,
        `console.log('wrote config.json: ' + name);`,
      ].join('\n'),
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skills.recordSuccess('Hydrogen', 'scaffold-config');
    }
    const { executor, calls } = makeExecutor({ exitCode: 0, stdout: 'wrote config.json', stderr: '' });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const events: SkillEventInfo[] = [];
    const ctx = makeCtxWith(executor, events);

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

    const result = await water.handleDirect({ description: 'scaffold the config' }, ctx);
    expect(result.summary).toBe('ok');
    // Zero tool calls from the dispatch path: no write_file, no run_shell,
    // and therefore no scratch-script cleanup either.
    expect(calls).toHaveLength(0);
    // No deterministic-dispatch event was recorded: the skill still drove the
    // run (and so still earns its counter bump through the normal validated
    // path), but it was never credited with a script execution.
    expect(events.map((e) => e.op)).not.toContain('direct');
    expect(events.map((e) => e.op)).toContain('match');
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
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

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
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });

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

describe('anti-redispatch guard — a reproduced dispatch output routes to the LLM loop (epoch-5 run 5)', () => {
  it('same ctx, reworded subtask, fresh L2 instance: the byte-identical output is caught', async () => {
    // The $1.63 lesson, with the REAL replan shape: supervisor replans
    // build FRESH L2 instances and reword subtasks, so no instance/task
    // state survives — only the run context does. The guard keys on the
    // dispatch OUTPUT: a summary this run has already seen from this
    // skill means the deterministic re-run cannot answer the content
    // rejection that caused the retry.
    process.env['ATOMA_SKILL_DIRECT'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'atoma-redispatch-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    for (let i = 0; i < 3; i++) reg.recordSuccess('Hydrogen');
    skills.save('Hydrogen', {
      id: 'verify-stuff', description: 'd', whenToUse: 'w', kind: 'script', language: 'node',
      body: 'console.log(JSON.stringify({output: "ok", summary: "done"}))',
    });
    for (let i = 0; i < 3; i++) skills.recordSuccess('Hydrogen', 'verify-stuff');

    const executor = {
      has: () => true,
      declarations: () => [],
      execute: async (name: string) => {
        if (name === 'run_shell')
          return { stdout: JSON.stringify({ output: 'ok', summary: 'done' }) + '\n', exitCode: 0, stderr: '' };
        return { ok: true };
      },
    };
    const ctx = { ...makeCtx(), tools: executor as never };

    // Attempt 1: dispatch fires (2 prefilter calls only).
    const water1 = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'verify-stuff', confidence: 'high', reasoning: 'f' }));
    const first = await water1.handleDirect({ description: 'verify every documented command' }, ctx);
    expect(first.summary).toBe('done');
    expect(ctx.llm.calls).toHaveLength(2);

    // Attempt 2 (upstream rejected the content → replan): FRESH instance,
    // reworded description, same ctx. The dispatch reproduces 'done' — the
    // guard catches it and the validated LLM loop runs instead.
    const water2 = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'verify-stuff', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, {
      output: 'adapted',
      summary: 'did it differently this time',
    });
    const second = await water2.handleDirect(
      { description: 're-run EVERY command in the README verbatim' },
      ctx
    );
    expect(second.summary).toMatch(/differently/);
    expect(ctx.llm.calls.length).toBe(6); // the L1 loop actually ran

    // A NEW run (fresh ctx): the guard resets, dispatch fires again.
    const ctx2 = { ...makeCtx(), tools: executor as never };
    const water3 = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    ctx2.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx2.llm.enqueueText(jsonText({ kind: 'reuse', target: 'verify-stuff', confidence: 'high', reasoning: 'f' }));
    const third = await water3.handleDirect({ description: 'verify commands' }, ctx2);
    expect(third.summary).toBe('done');
    expect(ctx2.llm.calls).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('deliverable gate — a script cannot report success for a file it never wrote', () => {
  // NOTE ON LAYERING (2026-08-11): the match-time capability test now refuses a
  // script whose PROVABLE write destinations miss the files a mutating subtask
  // names, so the provable case never reaches dispatch at all. This describe
  // therefore uses a body whose destination is UNPROVABLE — a runtime variable
  // — which is exactly the residual the gate is the last resort for. The two
  // layers hold OPPOSITE dispositions on purpose: refuse the match when the
  // mismatch is proven, dispatch-then-gate when it is not.
  //
  // The match-filter half is covered by unit tests in
  // tests/script-write-targets.test.ts, not end-to-end here. An end-to-end
  // version was written and DELETED: when the filter empties the catalogue
  // matchSkill short-circuits with no LLM call, so the mock's fixed enqueue
  // order shifts and the run dies on schema validation instead of on the
  // behaviour under test. It passed with the filter neutralised — i.e. it
  // proved nothing. Reinstate it only with a harness that can assert on the
  // catalogue itself rather than on a response queue.
  const OPAQUE_SCRIPT_BODY = `import fs from 'node:fs';\nconst target = process.argv[3];\nfs.writeFileSync(target, 'x');\nconsole.log(JSON.stringify({ output: { built: true }, summary: 'script ran clean' }));`;
  // MEASURED on the real compiled verifier: handed the subtask "Write a
  // README.md documenting the CLI usage", it replayed the manifest,
  // printed a valid envelope, exited 0 and wrote no README. This path
  // returns BEFORE superviseLoop, so no validator sees it, onFailed is
  // unreachable, and the phantom success entrenches the script — the
  // documented `document-cli-from-source` class, with no gate at all.
  const SEED2 = {
    description: 'orchestrator',
    systemPrompt: 'You are an L2.',
    tools: [],
    params: {},
    createdBy: 'test',
  };

  function fsExecutor(
    present: Record<string, string>,
    onRunShell?: (files: Record<string, string>) => void
  ): {
    executor: ToolExecutor;
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const executor: ToolExecutor = {
      async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
        calls.push({ name, args });
        if (name === 'write_file') return { ok: true, path: args['path'] };
        if (name === 'run_shell') {
          onRunShell?.(present);
          return { exitCode: 0, stdout: `${ENVELOPE_LINE}\n`, stderr: '' };
        }
        if (name === 'read_file') {
          const p = String(args['path']);
          if (p in present) return { content: present[p] };
          throw new Error(`ENOENT: ${p}`);
        }
        throw new Error(`unexpected tool: ${name}`);
      },
      has(name: string): boolean {
        return ['write_file', 'run_shell', 'read_file'].includes(name);
      },
    };
    return { executor, calls };
  }

  let dir2: string;
  let skills2: SkillRegistry;
  let reg2: AtomRegistry;
  let envBefore2: string | undefined;

  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'atoma-deliv-gate-'));
    skills2 = new SkillRegistry(dir2);
    reg2 = new AtomRegistry(openDb(':memory:'));
    reg2.create(2, SEED2);
    reg2.create(1, { ...SEED2, description: 'builder', systemPrompt: 'You are an L1.' });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg2.recordSuccess('Hydrogen');
    skills2.save('Hydrogen', {
      id: 'scaffold-config',
      description: 'write a canonical config file',
      whenToUse: 'when the subtask asks for the standard config scaffold',
      kind: 'script',
      language: 'node',
      body: OPAQUE_SCRIPT_BODY,
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skills2.recordSuccess('Hydrogen', 'scaffold-config');
    }
    envBefore2 = process.env['ATOMA_SKILL_DIRECT'];
    delete process.env['ATOMA_SKILL_DIRECT'];
  });
  afterEach(() => {
    rmSync(dir2, { recursive: true, force: true });
    if (envBefore2 === undefined) delete process.env['ATOMA_SKILL_DIRECT'];
    else process.env['ATOMA_SKILL_DIRECT'] = envBefore2;
  });

  function queuePrefilters(ctx: ReturnType<typeof makeCtx>): void {
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 's' })
    );
  }

  it('falls back to the LLM loop when the named deliverable is absent, crediting nothing', async () => {
    const { executor, calls } = fsExecutor({}); // README.md does NOT exist
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);
    // The fallback LLM loop then runs normally.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'wrote it properly' });

    await water.handleDirect(
      { description: 'Write a README.md documenting the CLI usage and options.' },
      ctx
    );

    // The script DID run (that is how we learn it produced nothing)…
    expect(calls.some((c) => c.name === 'run_shell')).toBe(true);
    // …but the deliverable was missing, so the LLM loop took over.
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
    // The PHANTOM success never happened: no 'direct' event was emitted.
    // (The skill may still earn a success afterwards — from the validated
    // LLM loop it then drove, which is a real one.)
    expect(events.some((e) => e.op === 'direct')).toBe(false);
    // And NOT a directFailure either: the script is not broken, it was
    // matched to the wrong kind of subtask.
    expect(skills2.loadFor('Hydrogen')[0]!.directFailures ?? 0).toBe(0);
  });

  it('never OFFERS a read-only script for a write subtask — the round-7 filter', async () => {
    // Round 6: the compiled verifier was matched to three "update README.md"
    // subtasks and once to the code-edit subtask; the gate then caught it
    // after a wasted dispatch, five times in six runs, taking dispatches from
    // 10 to 1. Filtering the catalogue is cheaper and more precise than
    // rejecting the result.
    skills2.save('Hydrogen', {
      id: 'readonly-verifier',
      description: 'replay recorded invocations',
      whenToUse: 'confirm a CLI still behaves as recorded',
      kind: 'script',
      language: 'node',
      body: "import fs from 'node:fs';\nJSON.parse(fs.readFileSync('.atoma-probes.json','utf8'));\nconsole.log('{}');",
    });
    const { executor, calls } = fsExecutor({ 'README.md': 'old\n' });
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    // The skill prefilter must not even be offered the read-only script; if
    // it were, this queued reply would name it and a dispatch would follow.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'nothing fits' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));

    await water
      .handleDirect({ description: 'update README.md to describe the new behaviour' }, ctx)
      .catch(() => undefined);

    // No scratch script was ever written: the dispatch never started.
    expect(calls.some((c) => ((c.args['path'] as string | undefined) ?? '').startsWith('_skill_'))).toBe(false);
  });

  it('falls back when the named file already existed and is byte-identical afterwards', async () => {
    // MEASURED, 2026-08-11 maintenance round: every file was seeded before the
    // run, so the existence check above is inert — the compiled verifier took
    // "update README.md …", printed a valid envelope, wrote nothing, and was
    // CREDITED. Seven of nine deliverables shipped a README asserting
    // `chars 36` about a CLI that prints 35.
    const { executor } = fsExecutor({ 'README.md': 'chars 36\n' }); // never rewritten
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));

    await water
      .handleDirect({ description: 'update README.md with the new behaviour' }, ctx)
      .catch(() => undefined);

    // The dispatch ran but was not credited: the LLM loop took over.
    expect(events.some((e) => e.op === 'direct')).toBe(false);
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
  });

  it('does not require a named INPUT file to change when every output changed', async () => {
    // Live packaging run: "write package.json and README.md ... pointing at
    // pathcase.js". The deterministic script changed both outputs, but the
    // old gate snapshot every named path and rejected it because pathcase.js
    // correctly stayed byte-identical. Match-time target extraction already
    // distinguishes inputs; the after-dispatch gate must use the same rule.
    const files = {
      'pathcase.js': 'source stays unchanged\n',
      'package.json': '{"name":"old"}\n',
      'README.md': 'old docs\n',
    };
    const { executor } = fsExecutor(files, (present) => {
      present['package.json'] = '{"name":"pathcase"}\n';
      present['README.md'] = 'new docs\n';
    });
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);

    const description =
      'write package.json for pathcase.js and write README.md using the verified invocations; no server, no browser, no index.html';
    expect(subtaskMutationTargets(description)).toEqual(['package.json', 'README.md']);
    await water.handleDirect({ description }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(events.some((e) => e.op === 'direct')).toBe(true);
    expect(files['pathcase.js']).toBe('source stays unchanged\n');
  });

  it('preserves full output paths instead of accepting a root basename write', async () => {
    const files = {
      'docs/README.md': 'stale nested docs\n',
      'README.md': 'stale root docs\n',
    };
    const { executor } = fsExecutor(files, (present) => {
      // Wrong destination: a basename-only gate used to accept this.
      present['README.md'] = 'new root docs\n';
    });
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'fixed', summary: 'updated the nested docs' });

    await water.handleDirect({ description: 'update docs/README.md with current usage' }, ctx);

    expect(events.some((e) => e.op === 'direct')).toBe(false);
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
    expect(files['docs/README.md']).toBe('stale nested docs\n');
  });

  it('falls back before dispatch when a mutating task names no output path', async () => {
    const { executor, calls } = fsExecutor({});
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor };
    queuePrefilters(ctx);
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'hardened it' });

    await water.handleDirect({ description: 'harden the existing CLI' }, ctx);

    expect(
      calls.some(
        (call) =>
          typeof call.args['path'] === 'string' &&
          call.args['path'].startsWith('_skill_')
      )
    ).toBe(false);
    expect(ctx.llm.calls.length).toBeGreaterThan(2);
  });

  it('does NOT gate a pure re-verification subtask, which writes nothing by design', async () => {
    // Rejecting these would send healthy dispatches back to the LLM loop.
    const { executor } = fsExecutor({ 'README.md': 'chars 36\n' });
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'scaffold-config', confidence: 'high', reasoning: 'f' }));

    await water.handleDirect(
      { description: 'Re-execute every invocation documented in README.md and report whether each still matches' },
      ctx
    );

    expect(events.some((e) => e.op === 'direct')).toBe(true);
  });

  it('dispatches normally for a read-only check when the named file is present', async () => {
    const { executor } = fsExecutor({ 'config.json': '{}' });
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor };
    queuePrefilters(ctx);
    // No further LLM replies queued: the dispatch must NOT fall through.

    await water.handleDirect({ description: 'Verify config.json against the template.' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2); // the two prefilters only
    expect(skills2.loadFor('Hydrogen')[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
  });

  it('does not require a file mentioned only in a read-only negation', async () => {
    const { executor } = fsExecutor({ 'config.json': '{}' });
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const events: SkillEventInfo[] = [];
    const ctx = { ...base, tools: executor, recordSkill: (e: SkillEventInfo) => events.push(e) };
    queuePrefilters(ctx);

    await water.handleDirect({
      description: 'Verify config.json against the template; no browser and no index.html.',
    }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(events.some((e) => e.op === 'direct')).toBe(true);
  });

  it('stays out of the way when the subtask names no file at all', async () => {
    const { executor } = fsExecutor({});
    const water = L2Atom.fromType(reg2.getByName('Water')!, reg2, [], skills2);
    const base = makeCtx();
    const ctx = { ...base, tools: executor };
    queuePrefilters(ctx);

    await water.handleDirect({ description: 'Re-run the recorded invocations and report.' }, ctx);

    expect(ctx.llm.calls).toHaveLength(2);
    expect(skills2.loadFor('Hydrogen')[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
  });
});

describe('subtaskMutatesFiles — does the subtask ask for a file to CHANGE', () => {
  it('recognises the phrasing that shipped stale documentation', () => {
    // Verbatim from the 2026-08-11 maintenance round: the compiled verifier
    // took this subtask, printed a valid envelope, wrote nothing, and left a
    // README asserting `chars 36` about a CLI that now prints 35.
    expect(
      subtaskMutatesFiles(
        'Using the verdicts from the previous phase, update README.md so that only the invocations whose behaviour legitimately changed are corrected'
      )
    ).toBe(true);
  });

  it('recognises the other mutating verbs', () => {
    for (const v of ['rewrite', 'edit', 'fix', 'amend', 'revise', 'append', 'regenerate', 'refresh']) {
      expect(subtaskMutatesFiles(`${v} the README.md accordingly`)).toBe(true);
    }
  });

  it('does NOT fire on a pure re-verification, which legitimately writes nothing', () => {
    // Rejecting these would send healthy dispatches back to the LLM loop.
    expect(
      subtaskMutatesFiles(
        'Re-execute every invocation documented in README.md against the edited CLI and report whether each still matches'
      )
    ).toBe(false);
    expect(subtaskMutatesFiles('confirm the recorded exit codes still hold')).toBe(false);
    expect(subtaskMutatesFiles('replay the probe manifest and diff the outputs')).toBe(false);
  });


});
