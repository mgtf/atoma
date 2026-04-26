import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { SkillEventInfo } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * The skill-pipeline events surfaced via `RunContext.recordSkill` are
 * the only signal the viz has to render a Skills lane during a run.
 * If a future refactor drops one of the call sites, the lane silently
 * goes dark — these tests pin the contract end-to-end on the happy
 * path (match → inject → success) and on a no-skill run (no events).
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('L2 — recordSkill events', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-viz-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function trustChild(): void {
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Hydrogen');
  }

  it('emits match + inject + success on a clean skill-driven run', async () => {
    trustChild();
    skills.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'when web',
      kind: 'llm',
      body: 'STEP 1.',
    });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const seen: SkillEventInfo[] = [];
    const ctx = { ...makeCtx(), recordSkill: (info: SkillEventInfo) => seen.push(info) };

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'task' }, ctx);

    const ops = seen.map((e) => e.op);
    expect(ops).toEqual(['match', 'inject', 'success']);
    expect(seen.every((e) => e.l1Name === 'Hydrogen' && e.skillId === 'web-build-loop')).toBe(true);
    expect(seen.every((e) => e.actorName === 'Water' && e.actorTier === 2)).toBe(true);
    // Match carries the prefilter reasoning verbatim.
    expect(seen[0]!.reasoning).toMatch(/fits/);
    // Inject carries kind metadata for the viz badge.
    expect(seen[1]!.reasoning).toMatch(/kind=llm/);
  });

  it('emits no skill events when the L1 has no skills', async () => {
    trustChild();
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const seen: SkillEventInfo[] = [];
    const ctx = { ...makeCtx(), recordSkill: (info: SkillEventInfo) => seen.push(info) };

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'task' }, ctx);
    expect(seen).toHaveLength(0);
  });

  it('emits no skill events when the prefilter escalates (no match)', async () => {
    trustChild();
    skills.save('Hydrogen', {
      id: 'unrelated',
      description: 'd',
      whenToUse: 'never',
      kind: 'llm',
      body: 'unused',
    });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const seen: SkillEventInfo[] = [];
    const ctx = { ...makeCtx(), recordSkill: (info: SkillEventInfo) => seen.push(info) };

    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    // Skill prefilter says escalate.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'task' }, ctx);
    expect(seen).toHaveLength(0);
  });
});
