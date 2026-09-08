import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { L3Atom, routeCrossBucketVerification } from '../src/atoms/L3Atom.js';
import { llmVerdict, VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { capabilityDescription } from '../src/atoms/capability.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';
import { SMOKE_CANONICAL_STATE_SHAPE } from '../src/atoms/prompts.js';
import type { SupervisionHooks } from '../src/core/supervisor.js';
import type { Tool } from '../src/core/types.js';

const tools: Tool[] = ['write_file', 'run_shell', 'start_node_server', 'fetch_url', 'validate_html']
  .map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
const seed = { description: 'generic builder', systemPrompt: 'You NEVER invoke elements yourself.', tools, params: {}, createdBy: 'test' };

describe('prompt review regressions', () => {
  it('labels a fallback supervisor as a direct executor for plan and result validation', async () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const child = L2Atom.fromType(reg.create(2, seed), reg);
      child.setFallbackMode(true);
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
      await llmVerdict({ ctx, model: child.validationModel, supervisorName: 'root', supervisorTier: 3,
        subject: 'PLAN', child, task: { description: 'write a file' }, payload: makePlan(), groundTruthBlock: '' });
      expect(ctx.llm.calls[0]!.userContent).toContain('Plan kind: DIRECT');
      expect(ctx.llm.calls[0]!.userContent).toContain("Child's DECLARED TOOLS");
      child.setFallbackMode(false);
      const executionCtx = makeCtx();
      executionCtx.llm.enqueueText(jsonText({ output: 'reasoned result', summary: 'no tools available' }));
      const fallbackResult = await child.execute({ description: 'reason about a file' }, makePlan(), executionCtx);
      expect(fallbackResult.producedBy.viaFallback).toBe(true);
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
      await llmVerdict({ ctx, model: child.validationModel, supervisorName: 'root', supervisorTier: 3,
        subject: 'RESULT', child, task: { description: 'write a file' }, groundTruthBlock: '',
        payload: { output: 'file', summary: 'done', trace: [], producedBy: { name: child.name, tier: 2, viaFallback: true } } });
      expect(ctx.llm.calls[1]!.userContent).toContain('Plan kind: DIRECT');
    } finally { db.close(); }
  });

  it('keeps combined browser and harness proof on a cell with both capabilities', () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const cell = reg.create(2, seed);
      const plan = makePlan({ subtasks: [{ description: 'Verify in a real browser. Run node test-api.js and require exit code 0.', preferredChild: cell.name }], aggregation: { mode: 'sequential' } });
      expect(routeCrossBucketVerification(plan, reg)).toEqual(plan);
    } finally { db.close(); }
  });

  it('the canonical smoke rejects an implementation capped below the task threshold', async () => {
    const expression = SMOKE_CANONICAL_STATE_SHAPE.split('smoke: ')[1]!;
    const element = { className: 'initial', textContent: '0' };
    let value = 0;
    const widget = {
      get value() { return value; },
      reset() { value = 0; element.className = 'initial'; element.textContent = '0'; },
      increment() { value = Math.min(5, value + 1); element.className = 'filled'; element.textContent = String(value); },
    };
    const result = await (runInNewContext(expression, {
      window: { __testOrWidget: widget }, exactElement: element, thresholdFromContract: 10,
      classFromSource: 'filled', setTimeout: (fn: () => void) => fn(),
    }) as Promise<{ ok: boolean }>);
    expect(result.ok).toBe(false);
  });

  it('repairs a copied persisted registry through the operator process with backup, history and idempotence', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-prompt-repair-'));
    const path = join(root, 'atoma.db');
    const db = openDb(path);
    const reg = new AtomRegistry(db);
    const oldPrompt = 'Your current subtask: old notes app\nPRIOR ATTEMPT DIAGNOSIS: invented blocker';
    const atom = reg.create(1, { ...seed, systemPrompt: oldPrompt });
    reg.recordSuccess(atom.name, 'test');
    db.close();
    for (const dir of ['runs', 'skills']) {
      mkdirSync(join(root, dir)); writeFileSync(join(root, dir, 'evidence.txt'), dir);
    }
    const run = (apply = false) => execFileSync(process.execPath,
      ['--import', 'tsx', resolve('scripts/repair-atom-prompts.mjs'), '--db', path, ...(apply ? ['--apply'] : [])],
      { encoding: 'utf8' });
    try {
      expect(run()).toContain('preview');
      let copy = openDb(path);
      expect(new AtomRegistry(copy).getByName(atom.name)!.systemPrompt).toBe(oldPrompt);
      copy.close();
      expect(run(true)).toContain('"patched":1');
      copy = openDb(path);
      const current = new AtomRegistry(copy).getByName(atom.name)!;
      expect(current.atomId).toBe(atom.atomId);
      expect(current.version).toBe(atom.version + 1);
      expect(current.successes).toBe(0);
      expect(current.tools.map(t => t.name)).toEqual(tools.map(t => t.name));
      expect(current.systemPrompt).not.toContain('old notes app');
      expect(copy.prepare('SELECT system_prompt FROM atom_type_versions WHERE version = ?').get(atom.version)).toMatchObject({ system_prompt: oldPrompt });
      copy.close();
      const archive = join(root, '.registry-archive', readdirSync(join(root, '.registry-archive'))[0]!);
      for (const dir of ['runs', 'skills']) expect(readFileSync(join(archive, dir, 'evidence.txt'), 'utf8')).toBe(dir);
      expect(run(true)).toContain('"changes": []');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a dynamically created L1 carries exactly ONE evidence contract, matching its bucket', () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const cases: Array<[string[], string]> = [
        [['write_file', 'read_file', 'list_files', 'start_static_server', 'validate_html'], '"probe": "web"'],
        [['write_file', 'run_shell', 'fetch_url', 'start_node_server'], 'LISTENING_ON_PORT=<N>'],
        [['write_file', 'read_file', 'run_shell', 'record_probe'], 'record_probe'],
      ];
      for (const [names, marker] of cases) {
        const cellTools = makeTools(names);
        const cell = L2Atom.fromType(reg.create(2, { ...seed, tools: cellTools }), reg);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const created = (cell as any).createSubtaskL1(
          { description: 'leaf' }, { action: 'create', seed: { tools: [], params: {} } }, { description: 'parent' });
        const contracts = created.systemPrompt.split('RESULT-REPORTING CONTRACT (mandatory)').length - 1;
        expect(contracts).toBe(1);
        expect(created.systemPrompt).toContain(marker);
        // The shell contract must not be taught to a molecule that lacks its tool
        // (the HTTP contract may still NAME record_probe to forbid it).
        if (!names.includes('record_probe')) expect(created.systemPrompt).not.toContain('USE record_probe, DO NOT TRANSCRIBE BY HAND');
        expect(created.systemPrompt).not.toContain('"summary": "<one sentence>"');
      }
      // The web escalation template ends on the web contract too, not on a one-liner.
      const webNarrow = buildNarrowL1Prompt('', makeTools(['write_file', 'start_static_server', 'validate_html']));
      expect(webNarrow).toContain('== GROUND TRUTH ==');
      expect(webNarrow).toContain('"probe": "web"');
    } finally { db.close(); }
  });

  it('planning prompts match on capability, never on task domain', async () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const cellType = reg.create(2, seed);
      reg.create(1, { ...seed, description: 'leaf' });
      const cell = L2Atom.fromType(cellType, reg);
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      ctx.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'r' },
        { reasoning: 'r', subtasks: [{ description: 't', preferredChild: 'Water' }], aggregation: { mode: 'concat' }, expectedOutput: 'e' }));
      await cell.plan({ description: 'build a dashboard' }, ctx);
      const tissue = L3Atom.fromType(reg.create(3, seed), reg);
      const l3ctx = makeCtx();
      l3ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      l3ctx.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: cellType.name, reasoning: 'r' },
        { reasoning: 'r', subtasks: [{ description: 't', preferredChild: cellType.name }, { description: 'u', preferredChild: cellType.name }], aggregation: { mode: 'sequential' }, expectedOutput: 'e' }));
      await tissue.plan({ description: 'build a dashboard' }, l3ctx);
      for (const prompt of [ctx.llm.calls[1]!.userContent, l3ctx.llm.calls[1]!.userContent]) {
        expect(prompt).toContain('capability-match rule');
        expect(prompt).not.toMatch(/domain-match rule|Mario-like platformer/);
        expect(prompt).toMatch(/Do NOT "create"[\s\S]{0,80}domain/);
      }
      // The validator no longer teaches theme-bound labels or domain branches.
      expect(VALIDATION_SYSTEM_PROMPT).not.toMatch(/WebGL Minesweeper builder|DashboardBuilder|"L1 builder for single-/);
      expect(VALIDATION_SYSTEM_PROMPT).toContain('NEVER a branch reason');
      expect(VALIDATION_SYSTEM_PROMPT).toContain('NEVER by itself grounds to reject');
      expect(VALIDATION_SYSTEM_PROMPT.length / 3.7).toBeGreaterThan(4200);
    } finally { db.close(); }
  });

  it('a validator-authored themed descriptionReplace is replaced by the capability label on patch and branch', async () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const cell = L2Atom.fromType(reg.create(2, seed), reg);
      const leaf = reg.create(1, seed);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hooks: SupervisionHooks<L1Atom> = (cell as any).makeL1Hooks(makeCtx(), 'sub',
        { l1Name: leaf.name, subTask: { description: 'sub' }, skillMatchAttempted: false, eventState: { injected: false } });
      const themed = 'Single-file WebGL Minesweeper builder with validation loop.';
      const patched = await hooks.applyByScope(L1Atom.fromType(leaf), {
        approved: false, reasoning: 'drift', scope: 'patch', modifications: { descriptionReplace: themed } });
      expect(reg.getByName(patched.name)!.description).toBe(capabilityDescription(tools, 1));
      const branched = await hooks.applyByScope(L1Atom.fromType(leaf), {
        approved: false, reasoning: 'drift', scope: 'branch', branchName: 'Themed',
        modifications: { descriptionReplace: themed, systemPromptAppend: 'paste evidence' } });
      expect(reg.getByName(branched.name)!.description).not.toMatch(/Minesweeper|WebGL/i);
      // A clean capability label authored by the validator is honoured.
      const clean = await hooks.applyByScope(L1Atom.fromType(leaf), {
        approved: false, reasoning: 'drift', scope: 'patch',
        modifications: { descriptionReplace: 'file and HTTP builder: writes files, boots a Node server and probes endpoints over HTTP' } });
      expect(reg.getByName(clean.name)!.description).toMatch(/^file and HTTP builder/);
    } finally { db.close(); }
  });

  it('the L1 execute prompt teaches one proof mode per call and edit_file repairs', async () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const leaf = L1Atom.fromType(reg.create(1, seed));
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ output: 'x', summary: 'y' }));
      await leaf.execute({ description: 'build a page' }, makePlan(), ctx);
      const prompt = ctx.llm.calls[0]!.userContent;
      expect(prompt).not.toMatch(/MUST pass an "interactions" array|rewrite with write_file|Loop up to 5/);
      expect(prompt).toContain('never both');
      expect(prompt).toContain('apply the fix with edit_file');
      const planCtx = makeCtx();
      planCtx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      await leaf.plan({ description: 'build a page' }, planCtx);
      expect(planCtx.llm.calls[0]!.userContent).not.toContain('until validate_html reports no errors');
      expect(planCtx.llm.calls[0]!.userContent).toContain('A clean console alone is not success');
    } finally { db.close(); }
  });
});
