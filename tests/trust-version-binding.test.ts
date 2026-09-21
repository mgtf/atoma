import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { RecordingRegistry } from '../src/viz/recordingRegistry.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import type { AtomModifications, Result, RunContext } from '../src/core/types.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan, makeTool } from './helpers/factories.js';
import { FALLBACK_OPUS } from './tier-pins.js';

const seed = { description: 'Reusable capability', systemPrompt: 'Original behavior.', tools: [], params: {}, createdBy: 'test' };
const task = { description: 'Inspect the result' };
const approval = jsonText({ approved: true, reasoning: 'Reviewed by the validator' });
const resultFor = (child: L1Atom | L2Atom): Result => ({ output: 'done', summary: 'done', trace: [],
  producedBy: { name: child.name, tier: child.tier, viaFallback: false } });

async function validate(parent: L2Atom | L3Atom, child: L1Atom | L2Atom,
  subject: 'PLAN' | 'RESULT', ctx: RunContext, result = resultFor(child)) {
  if (parent instanceof L2Atom && child instanceof L1Atom) {
    return subject === 'PLAN'
      ? parent.validatePlan(child, makePlan(), task, ctx)
      : parent.validateResult(child, result, task, ctx);
  }
  if (parent instanceof L3Atom && child instanceof L2Atom) {
    return subject === 'PLAN'
      ? parent.validatePlan(child, makePlan(), task, ctx)
      : parent.validateResult(child, result, task, ctx);
  }
  throw new Error('The fixture must pair a supervisor with its direct child tier');
}
afterEach(() => vi.restoreAllMocks());

describe('RecordingRegistry forwards supervised version bindings', () => {
  it('keeps stale and locally modified successes in history without crediting the current streak', () => {
    const db = openDb(':memory:');
    // Exercise the runner's real registry wrapper. An inactive recorder performs
    // no filesystem writes; tracing must not change the counter semantics.
    const registry: AtomRegistry = new RecordingRegistry(db, new TraceRecorder());
    try {
      const original = registry.create(1, seed);
      const changed = registry.patch(original.name, { systemPromptAppend: 'New workflow.' }, 'parallel-lane');
      registry.recordSuccess(original.name, 'supervisor', original.version);
      registry.recordSuccess(original.name, 'supervisor', null);
      expect(registry.getByName(original.name)).toMatchObject({ successes: 2, consecutiveSuccesses: 0 });
      registry.recordSuccess(original.name, 'supervisor', changed.version);
      expect(registry.getByName(original.name)).toMatchObject({ successes: 3, consecutiveSuccesses: 1 });
      expect(projectCounters(readLedger(db)).get(original.atomId)?.successes).toBe(3);
    } finally { db.close(); }
  });
});

describe.each([1, 2] as const)('L%i trust is bound to the instantiated registry version', tier => {
  function setup() {
    const db = openDb(':memory:');
    const registry = new AtomRegistry(db);
    const type = registry.create(tier, seed);
    const parentType = registry.create(tier === 1 ? 2 : 3, seed);
    const parent = tier === 1 ? L2Atom.fromType(parentType, registry) : L3Atom.buildWithModel(parentType, registry, FALLBACK_OPUS);
    const instantiate = () => {
      const current = registry.getByName(type.name)!;
      return tier === 1 ? L1Atom.fromType(current) : L2Atom.fromType(current, registry);
    };
    const earn = () => { for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) registry.recordSuccess(type.name); };
    return { db, registry, type, parent, instantiate, earn };
  }

  it('reviews stale plans/results even after the changed type earns trust again', async () => {
    const { db, registry, type, parent, instantiate, earn } = setup();
    try {
      const stale = instantiate();
      registry.patch(type.name, { systemPromptAppend: 'New workflow.' }, 'parallel-lane');
      earn();
      const ctx = makeCtx();
      ctx.llm.enqueueText(approval);
      ctx.llm.enqueueText(approval);
      await validate(parent, stale, 'PLAN', ctx);
      await validate(parent, stale, 'RESULT', ctx);
      expect(ctx.llm.calls).toHaveLength(2);
      const current = instantiate();
      await validate(parent, current, 'PLAN', ctx);
      await validate(parent, current, 'RESULT', ctx);
      expect(ctx.llm.calls).toHaveLength(2);
    } finally { db.close(); }
  });

  it('retains stored trust across a description edit but reviews older instances conservatively', async () => {
    const { db, registry, type, parent, instantiate, earn } = setup();
    try {
      const stale = instantiate();
      earn();
      registry.describe(type.name, 'Clearer capability label');
      const ctx = makeCtx();
      ctx.llm.enqueueText(approval);
      await validate(parent, stale, 'PLAN', ctx);
      await validate(parent, instantiate(), 'PLAN', ctx);
      expect(ctx.llm.calls).toHaveLength(1);
      expect(registry.getByName(type.name)!.consecutiveSuccesses).toBe(TRUST_THRESHOLD_SUCCESSES);
    } finally { db.close(); }
  });

  it('rechecks the shared version after the awaited ground-truth probe', async () => {
    const { db, registry, type, parent, instantiate, earn } = setup();
    try {
      registry.patch(type.name, { addTools: [makeTool('validate_html')] }, 'test');
      const child = instantiate();
      earn();
      const probe = vi.fn(async () => {
        registry.patch(type.name, { systemPromptAppend: 'Changed during the probe.' }, 'parallel-lane');
        earn();
        return { ok: true, consoleErrors: [], pageErrors: [] };
      });
      const ctx = { ...makeCtx(), tools: { has: (name: string) => name === 'validate_html', execute: probe } };
      ctx.llm.enqueueText(approval);
      const result = { ...resultFor(child), output: { url: 'http://localhost:3000' } };
      await validate(parent, child, 'RESULT', ctx, result);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-result')).toHaveLength(1);
    } finally { db.close(); }
  });

  it.each([
    { systemPromptAppend: 'Use a different workflow.' },
    { addTools: [makeTool('new_tool')] },
    { params: { temperature: 0.4 } },
  ] satisfies AtomModifications[])('reviews local behavior mutations: %j', async modifications => {
    const { db, parent, instantiate, earn } = setup();
    try {
      earn();
      const child = instantiate();
      child.applyModifications(modifications);
      expect(child.registryVersion()).toBeNull();
      const ctx = makeCtx();
      ctx.llm.enqueueText(approval);
      ctx.llm.enqueueText(approval);
      await validate(parent, child, 'PLAN', ctx);
      await validate(parent, child, 'RESULT', ctx);
      expect(ctx.llm.calls).toHaveLength(2);
    } finally { db.close(); }
  });

  it('keeps coaching and behavior-identical modifications bound to their registry version', async () => {
    const { db, type, parent, instantiate, earn } = setup();
    try {
      earn();
      const child = instantiate();
      child.injectContext({ source: 'coaching', text: 'Read the requested output carefully.' });
      child.applyModifications({ systemPromptReplace: type.systemPrompt, removeTools: ['absent'],
        params: {}, additionalContext: 'Honor the task constraints.' });
      expect(child.registryVersion()).toBe(type.version);
      const ctx = makeCtx();
      await validate(parent, child, 'PLAN', ctx);
      expect(ctx.llm.calls).toHaveLength(0);
    } finally { db.close(); }
  });

  it.each(['registry patch', 'local mutation'] as const)('retains history without streak credit after %s during execution', async change => {
    const { db, registry, type, parent, earn } = setup();
    try {
      earn();
      const prototype = tier === 1 ? L1Atom.prototype : L2Atom.prototype;
      vi.spyOn(prototype, 'plan').mockResolvedValue(makePlan());
      vi.spyOn(prototype, 'execute').mockImplementation(async function (this: L1Atom | L2Atom) {
        if (change === 'registry patch') {
          registry.patch(this.name, { systemPromptAppend: 'Changed by another lane.' }, 'parallel-lane');
        } else {
          this.applyModifications({ systemPromptAppend: 'Temporary changed behavior.' });
          // A concurrent terminal failure clears the old earned series.
          registry.recordFailure(this.name);
        }
        return resultFor(this);
      });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'Exercise full parent strategy' }));
      ctx.llm.enqueueText(jsonTextPair(
        { strategy: 'reuse', target: type.name, reasoning: 'Existing capability fits' },
        makePlan({ subtasks: [{ description: task.description, preferredChild: type.name }] })
      ));
      ctx.llm.enqueueText(approval);
      const plan = await parent.plan(task, ctx);
      const result = await parent.execute(task, plan, ctx);
      expect(result.producedBy.viaFallback).toBe(false);
      expect(registry.getByName(type.name)).toMatchObject({
        successes: TRUST_THRESHOLD_SUCCESSES + 1,
        consecutiveSuccesses: 0,
      });
      expect(projectCounters(readLedger(db)).get(type.atomId)?.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-result')).toHaveLength(1);
    } finally { db.close(); }
  });
});
