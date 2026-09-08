import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { routeCrossBucketVerification } from '../src/atoms/L3Atom.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import { SMOKE_CANONICAL_STATE_SHAPE } from '../src/atoms/prompts.js';
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
});
