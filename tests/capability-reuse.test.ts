import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry, type CreateSeed } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { L3Atom, buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { Result } from '../src/core/types.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';
import { FALLBACK_OPUS } from './tier-pins.js';

const seed: CreateSeed = {
  description: 'file author',
  systemPrompt: 'You are Water, a file author. Read, write, then verify.',
  tools: makeTools(['read_file', 'write_file']),
  params: { temperature: 0.2, maxTokens: 300 },
  createdBy: 'test',
};

afterEach(() => vi.restoreAllMocks());

describe('automatic registry capability reuse', () => {
  it('ignores persona, labels and JSON/tool ordering without erasing failure history', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const original = reg.create(1, seed);
    reg.recordFailure(original.name);
    reg.recordSuccess(original.name);
    const clone = reg.create(1, seed); // explicit operator allocation stays available
    const found = reg.createOrReuse(1, {
      ...seed, description: 'another label', createdBy: 'another supervisor',
      systemPrompt: seed.systemPrompt.replace('Water', 'Glucose'),
      tools: [...seed.tools].reverse().map(tool => ({
        inputSchema: { required: [], properties: {}, type: 'object' },
        description: tool.description, name: tool.name,
      })),
      params: { maxTokens: 300, temperature: 0.2 },
    });
    expect(found.atomId).toBe(original.atomId);
    expect(found).toMatchObject({ successes: 1, failures: 1 });
    expect(reg.listCapabilities(1).map(type => type.name)).toEqual([original.name]);
    expect(reg.getByAtomId(clone.atomId)).not.toBeNull();
    expect(reg.listByTier(1)).toHaveLength(2);
    // Excluding either identity excludes its behavior, never surfaces its twin.
    expect(reg.listCapabilities(1, new Set([clone.name]))).toEqual([]);
    expect(reg.listCapabilities(1, new Set([original.name]))).toEqual([]);
  });

  it('keeps workflows, tool schemas, parameters and tiers distinct', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.createOrReuse(1, seed);
    reg.createOrReuse(1, { ...seed, systemPrompt: `${seed.systemPrompt}\nNever overwrite existing files.` });
    reg.createOrReuse(1, { ...seed, params: { ...seed.params, temperature: 0.3 } });
    reg.createOrReuse(1, { ...seed, tools: seed.tools.map(tool => ({
      ...tool, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    })) });
    reg.createOrReuse(2, seed);
    expect(reg.listCapabilities(1)).toHaveLength(4);
    expect(reg.listCapabilities(2)).toHaveLength(1);
  });

  it('no-op branches retain the source; real repairs reuse an existing exact variant', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const original = reg.create(1, seed);
    const clone = reg.branch(original.name, {}, 'operator');
    const variantPrompt = `${original.systemPrompt}\nVerify with a read-back.`;
    const variant = reg.branch(original.name, { systemPromptReplace: variantPrompt }, 'operator');
    reg.recordFailure(variant.name);
    expect(reg.branchOrReuse(clone.name, { descriptionReplace: 'new label' }, 'validator', 'Fresh').atomId)
      .toBe(clone.atomId);
    expect(reg.branchOrReuse(original.name, { systemPromptReplace: variantPrompt }, 'validator', 'Fresh'))
      .toMatchObject({ atomId: variant.atomId, failures: 1 });
    expect(reg.listByTier(1)).toHaveLength(3);
  });
});

describe.each([2, 3] as const)('L%i automatic creation and repair', tier => {
  function setup() {
    const reg = new AtomRegistry(openDb(':memory:'));
    const tools = makeTools(['read_file', 'write_file']);
    const parentType = reg.create(tier, { ...seed, tools, params: {}, systemPrompt: 'Supervise file tasks.' });
    const childType = reg.create(tier === 2 ? 1 : 2, {
      ...seed, tools, params: {},
      systemPrompt: tier === 2 ? buildNarrowL1Prompt('', tools) : buildNarrowL2Prompt('', tools),
    });
    const parent = tier === 2
      ? L2Atom.fromType(parentType, reg)
      : L3Atom.buildWithModel(parentType, reg, FALLBACK_OPUS);
    const contexts: string[] = [];
    const names: string[] = [];
    const prototype = tier === 2 ? L1Atom.prototype : L2Atom.prototype;
    vi.spyOn(prototype, 'plan').mockImplementation(async function (this: L1Atom | L2Atom) {
      names.push(this.name);
      contexts.push(this.contextBlocks().map(block => block.text).join('\n'));
      return makePlan();
    });
    vi.spyOn(prototype, 'execute').mockImplementation(async function (this: L1Atom | L2Atom): Promise<Result> {
      return { output: 'done', summary: 'done', trace: [],
        producedBy: { tier: this.tier, name: this.name, viaFallback: false } };
    });
    vi.spyOn(parent, 'validatePlan').mockResolvedValue({ approved: true, reasoning: 'ok' });
    vi.spyOn(parent, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'ok' });
    return { reg, parent, childType, contexts, names };
  }

  it('plan → execute reuses across tasks and injects each task seed only in its instance', async () => {
    const { reg, parent, childType, contexts, names } = setup();
    reg.recordFailure(childType.name);
    for (const label of ['first', 'second']) {
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'exercise create strategy' }));
      ctx.llm.enqueueText(jsonTextPair(
        { strategy: 'create', reasoning: 'new label', seed: { systemPrompt: `${label} task seed` } },
        makePlan({ subtasks: [{ description: `${label} task` }] })
      ));
      const task = { description: `${label} task` };
      await parent.execute(task, await parent.plan(task, ctx), ctx);
    }
    expect(names).toEqual([childType.name, childType.name]);
    expect(contexts[0]).toContain('first task seed');
    expect(contexts[1]).toContain('second task seed');
    expect(contexts[1]).not.toContain('first task seed');
    expect(reg.listByTier(tier === 2 ? 1 : 2)).toHaveLength(1);
    expect(reg.getByName(childType.name)).toMatchObject({ successes: 2, failures: 1 });
    expect(reg.getByName(childType.name)!.systemPrompt).not.toContain('task seed');
  });

  it('escalation retries a fresh instance with diagnostics without allocating a no-op branch', async () => {
    const { reg, parent, childType, contexts, names } = setup();
    vi.mocked(parent.validatePlan).mockResolvedValueOnce({
      approved: false, reasoning: 'read back the produced file', scope: 'ephemeral', modifications: {},
    });
    const ctx = makeCtx({ limits: { ...DEFAULT_LIMITS, maxPlanIterations: 1 } });
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'exercise create strategy' }));
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'create', reasoning: 'new label', seed: { systemPrompt: 'Keep the document headings.' } },
      makePlan({ subtasks: [{ description: 'repair the document' }] })
    ));
    const task = { description: 'repair the document' };
    await parent.execute(task, await parent.plan(task, ctx), ctx);
    expect(names).toEqual([childType.name, childType.name]);
    expect(contexts[1]).toContain('read back the produced file');
    expect(contexts[1]).toContain('repair the document');
    expect(contexts[1]).toContain('Keep the document headings.');
    expect(reg.listByTier(tier === 2 ? 1 : 2)).toHaveLength(1);
    expect(reg.getByName(childType.name)).toMatchObject({ successes: 1, failures: 1 });
  });
});

describe.each([2, 3] as const)('L%i compact model catalogue', tier => {
  it('sends one original row to both planning calls and honors an excluded clone', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const childTier = tier === 2 ? 1 : 2;
    const original = reg.create(childTier, seed);
    const clone = reg.create(childTier, seed);
    reg.recordFailure(original.name);
    const parentType = reg.create(tier, { ...seed, systemPrompt: 'Supervise file tasks.' });
    const parent = tier === 2 ? L2Atom.fromType(parentType, reg)
      : L3Atom.buildWithModel(parentType, reg, FALLBACK_OPUS);
    const task = { description: 'some file task' };
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'exercise strategy' }));
    const plan = makePlan({ subtasks: [{ description: task.description }] });
    ctx.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: original.name, reasoning: 'ok' }, plan));
    await parent.plan(task, ctx);
    expect(ctx.llm.calls).toHaveLength(2);
    for (const call of ctx.llm.calls) {
      expect(call.userContent).toContain(`- ${original.name}:`);
      expect(call.userContent).not.toContain(`- ${clone.name}:`);
    }
    // A committed twin must exclude the equivalence class on a replan.
    const memo = (parent as unknown as { triedChildren: { mark(name: string): void } }).triedChildren;
    memo.mark(clone.name);
    const retry = makeCtx();
    retry.llm.enqueueText(jsonTextPair({ strategy: 'create', reasoning: 'excluded prior behavior' }, plan));
    await parent.plan(task, retry);
    expect(retry.llm.calls).toHaveLength(1);
    expect(retry.llm.calls[0]!.userContent).not.toContain(`- ${original.name}:`);
    expect(retry.llm.calls[0]!.userContent).not.toContain(`- ${clone.name}:`);
  });
});
