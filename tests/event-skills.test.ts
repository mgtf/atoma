import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { SkillRegistry, parseFrontmatter, renderFrontmatter } from '../src/skills/registry.js';
import {
  EVENT_TRIGGER_MATCH_THRESHOLD,
  eventSkillBlock,
  matchEventSkill,
  triggerContainment,
} from '../src/skills/events.js';
import { parseEventSkillDraft } from '../src/skills/lifecycle.js';
import { makeCtx, jsonText } from './helpers.js';
import type { Skill } from '../src/skills/types.js';

/**
 * EVENT-DRIVEN skills (#E1) — recovery guidance matched MID-RUN against
 * validator rejections / escalation diagnostics (mechanical, zero LLM)
 * and injected into the retry cycle; distilled from RECOVERED runs.
 * CODESKILL's ablation motivates the split: event-triggered micro-
 * guidance carries the value (+8.3pp), task-level strategy much less.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

function fakeSkill(over: Partial<Skill>): Skill {
  return {
    id: 'x',
    description: 'd',
    whenToUse: 'w',
    kind: 'llm',
    body: 'b',
    successes: 0,
    failures: 0,
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...over,
  };
}

describe('frontmatter — trigger field', () => {
  it('round-trips through render + parse', () => {
    const md = renderFrontmatter(
      {
        id: 'recover-x',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        trigger: 'validator rejects missing evidence',
      },
      'guidance body'
    );
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.trigger).toBe('validator rejects missing evidence');
    expect(body).toBe('guidance body');
  });

  it('rejects trigger on kind:script at parse AND at save', () => {
    const md = [
      '---',
      'id: bad',
      'description: d',
      'when_to_use: w',
      'kind: script',
      'language: node',
      'trigger: some event',
      '---',
      '',
      'code',
    ].join('\n');
    expect(() => parseFrontmatter(md)).toThrow(/trigger.*only valid with kind:"llm"/);

    const dir = mkdtempSync(join(tmpdir(), 'atoma-trig-'));
    const reg = new SkillRegistry(dir);
    expect(() =>
      reg.save('Hydrogen', {
        id: 'bad',
        description: 'd',
        whenToUse: 'w',
        kind: 'script',
        language: 'node',
        trigger: 'event',
        body: 'code',
      })
    ).toThrow(/must not declare a trigger/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('matchEventSkill — mechanical trigger containment', () => {
  const recovery = fakeSkill({
    id: 'recover-evidence',
    trigger: 'validator rejects result missing ground-truth evidence',
    body: 'paste the run_shell output into the summary',
  });

  it('matches when enough trigger tokens appear in the event text', () => {
    const event =
      'The RESULT is missing the ground-truth evidence block; the summary is unverifiable.';
    expect(triggerContainment(recovery.trigger!, event)).toBeGreaterThanOrEqual(
      EVENT_TRIGGER_MATCH_THRESHOLD
    );
    const m = matchEventSkill(event, [recovery]);
    expect(m?.skill.id).toBe('recover-evidence');
  });

  it('does not fire on unrelated complaints or trigger-less skills', () => {
    expect(matchEventSkill('plan delegates to an unknown catalog name', [recovery])).toBeNull();
    expect(
      matchEventSkill('missing ground-truth evidence', [fakeSkill({ id: 'task-skill' })])
    ).toBeNull();
  });

  it('requires an absolute shared-token floor, not just the ratio', () => {
    const tiny = fakeSkill({ id: 'tiny', trigger: 'evidence missing' });
    // 2/2 tokens shared = ratio 1.0, but below the 3-shared-token floor.
    expect(matchEventSkill('evidence missing', [tiny])).toBeNull();
  });

  it('picks the best-scoring candidate', () => {
    const other = fakeSkill({
      id: 'recover-smoke',
      trigger: 'validator rejects result for failing smoke expression',
    });
    const event = 'RESULT rejected: missing ground-truth evidence in the result summary';
    const m = matchEventSkill(event, [other, recovery]);
    expect(m?.skill.id).toBe('recover-evidence');
  });
});

describe('eventSkillBlock', () => {
  it('renders greppable delimiters distinct from ACTIVE SKILL', () => {
    const out = eventSkillBlock({ id: 'recover-x', body: 'do Y', trigger: 'pattern Z' });
    expect(out).toMatch(/== EVENT RECOVERY SKILL: recover-x ==/);
    expect(out).toMatch(/pattern Z/);
    expect(out).toMatch(/do Y/);
    expect(out).not.toMatch(/== ACTIVE SKILL/);
  });
});

describe('parseEventSkillDraft', () => {
  it('parses a full draft and defaults when_to_use to the trigger', () => {
    const draft = parseEventSkillDraft(
      jsonText({
        id: 'recover-evidence',
        trigger: 'validator rejects missing evidence',
        description: 'paste evidence',
        body: '1. paste run_shell output',
      })
    );
    expect(draft?.id).toBe('recover-evidence');
    expect(draft?.trigger).toBe('validator rejects missing evidence');
    expect(draft?.whenToUse).toBe('validator rejects missing evidence');
  });

  it('returns null without a trigger', () => {
    expect(
      parseEventSkillDraft(jsonText({ id: 'x-y-z', description: 'd', body: 'b' }))
    ).toBeNull();
  });
});

describe('L2 supervise loop — event-skill injection + learning (e2e)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-event-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    envBefore = process.env['ATOMA_SKILL_LEARN'];
    delete process.env['ATOMA_SKILL_LEARN'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env['ATOMA_SKILL_LEARN'];
    else process.env['ATOMA_SKILL_LEARN'] = envBefore;
  });

  /** One rejected cycle then one approved cycle, both plan-approved. */
  function enqueueRecoveredRun(ctx: ReturnType<typeof makeCtx>, rejectionReasoning: string): void {
    // Cycle 1: plan → approve → execute → REJECT.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'draft', summary: 'first attempt' }));
    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: rejectionReasoning, scope: 'ephemeral' })
    );
    // Cycle 2: plan → approve → execute → APPROVE.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a2', expectedOutput: 'e2' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'fixed', summary: 'second attempt with evidence' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok now' }));
  }

  it('injects the matched event skill into the retry after a rejection', async () => {
    skills.save('Hydrogen', {
      id: 'recover-evidence',
      description: 'paste ground-truth evidence into the summary',
      whenToUse: 'on evidence rejections',
      kind: 'llm',
      trigger: 'validator rejects result missing ground-truth evidence',
      body: 'On the retry: paste the verbatim run_shell output into a == GROUND TRUTH == block.',
    });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter picks Hydrogen. NO skill-prefilter slot: the only
    // skill is event-driven and the task prefilter must not see it.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    enqueueRecoveredRun(
      ctx,
      'RESULT is missing the ground-truth evidence block; summary unverifiable'
    );

    await water.handleDirect({ description: 'build a page' }, ctx);

    // 9 calls: tier prefilter + 2×(plan, vplan, exec, vresult). A skill-
    // prefilter call here would mean event skills leaked into task matching.
    expect(ctx.llm.calls).toHaveLength(9);
    // Cycle-1 L1 calls carry no recovery block; the cycle-2 plan does.
    expect(ctx.llm.calls[1]!.systemPrompt).not.toMatch(/EVENT RECOVERY SKILL/);
    expect(ctx.llm.calls[5]!.systemPrompt).toMatch(/== EVENT RECOVERY SKILL: recover-evidence ==/);
    expect(ctx.llm.calls[5]!.systemPrompt).toMatch(/GROUND TRUTH == block/);
    // Utility signal: the injection counts as a match.
    expect(skills.loadFor('Hydrogen')[0]!.matches).toBe(1);
  });

  it('does not inject when no trigger matches the complaint', async () => {
    skills.save('Hydrogen', {
      id: 'recover-evidence',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      trigger: 'validator rejects result missing ground-truth evidence',
      body: 'irrelevant here',
    });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    enqueueRecoveredRun(ctx, 'plan targets an unknown catalog name');

    await water.handleDirect({ description: 'build a page' }, ctx);
    for (const call of ctx.llm.calls) {
      expect(call.systemPrompt ?? '').not.toMatch(/EVENT RECOVERY SKILL/);
    }
    expect(skills.loadFor('Hydrogen')[0]!.matches).toBeUndefined();
  });

  it('distills an event skill from a recovered run (novel event, learning on)', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    enqueueRecoveredRun(ctx, 'RESULT is missing the ground-truth evidence block');
    // onApproved fires the C3 task-skill distillation first (no skill was
    // matched) — feed it an unusable response so it skips cleanly.
    ctx.llm.enqueueText('not json, no skill to learn here');
    // Then the post-loop event-skill distillation.
    ctx.llm.enqueueText(
      jsonText({
        id: 'recover-missing-evidence',
        trigger: 'validator rejects result missing ground-truth evidence',
        description: 'paste evidence on retry',
        body: '1. re-run the probe.\n2. paste verbatim output into the summary.',
      })
    );

    await water.handleDirect({ description: 'build a page' }, ctx);

    const learned = skills.loadFor('Hydrogen').find((s) => s.id === 'recover-missing-evidence');
    expect(learned).toBeDefined();
    expect(learned!.trigger).toBe('validator rejects result missing ground-truth evidence');
    expect(learned!.kind).toBe('llm');
    const eventLearnCall = ctx.llm.calls.find((c) =>
      c.userContent.includes('EVENT-DRIVEN recovery skill')
    );
    expect(eventLearnCall).toBeDefined();
    expect(eventLearnCall!.userContent).toMatch(/VALIDATOR REJECTION \(verbatim\)/);
    expect(eventLearnCall!.userContent).toMatch(/MUST GENERALISE/);
  });

  it('does NOT distill on a clean run, and NOT when an event skill was injected', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    // Case 1: clean run (no rejection) — only the C3 task-skill call fires.
    {
      const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
      const ctx = makeCtx();
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
      );
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
      ctx.llm.enqueueText('not json, skip the task-skill distillation');
      await water.handleDirect({ description: 'task one' }, ctx);
      expect(
        ctx.llm.calls.some((c) => c.userContent.includes('EVENT-DRIVEN recovery skill'))
      ).toBe(false);
    }
    // Case 2: recovered run WITH an injected event skill — confounded, skip.
    {
      skills.save('Hydrogen', {
        id: 'recover-evidence',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        trigger: 'validator rejects result missing ground-truth evidence',
        body: 'paste the evidence',
      });
      const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
      const ctx = makeCtx();
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
      );
      enqueueRecoveredRun(ctx, 'RESULT is missing the ground-truth evidence block');
      // C3 task-skill distillation still fires post-approval; event-skill
      // distillation must NOT (the recovery is confounded with the skill).
      ctx.llm.enqueueText('not json, skip');
      await water.handleDirect({ description: 'task two' }, ctx);
      expect(
        ctx.llm.calls.some((c) => c.userContent.includes('EVENT-DRIVEN recovery skill'))
      ).toBe(false);
    }
  });
});
