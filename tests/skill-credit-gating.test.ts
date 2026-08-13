import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import {
  ADHERENCE_BODY_MAX_CHARS,
  renderActiveSkillBlock,
  VALIDATION_SYSTEM_PROMPT,
} from '../src/atoms/verdict.js';
import { parseVerdict } from '../src/atoms/json.js';
import { lastResultVerdictSkillFollowed } from '../src/atoms/capability.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Usage-conditioned skill credit (adherence gate, CODESKILL R_A analog).
 *
 * Skill trust counters must only move when the skill actually DROVE the
 * run. The RESULT validator is shown the active recipe and asked for an
 * `activeSkillFollowed` signal; the supervise-loop hooks withhold the
 * counter bump (both directions) on an AFFIRMATIVE `false`. `undefined`
 * (trust fast-path, legacy verdicts, model omission) preserves the legacy
 * bump — absence of evidence is not evidence of free-riding.
 *
 * Why it matters: counters are TRIGGERS, not stats. Unearned successes
 * arm the 5/0 script-compilation trigger on recipes that never worked;
 * an unearned failure permanently blocks promotion until an operator
 * `skills reset`.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('verdict schema — activeSkillFollowed field', () => {
  it('parses the field on approved verdicts', () => {
    const v = parseVerdict(jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: false }));
    expect(v.approved).toBe(true);
    expect(v.activeSkillFollowed).toBe(false);
  });

  it('parses the field on rejected verdicts', () => {
    const v = parseVerdict(
      jsonText({ approved: false, reasoning: 'no', scope: 'ephemeral', activeSkillFollowed: true })
    );
    expect(v.approved).toBe(false);
    expect(v.activeSkillFollowed).toBe(true);
  });

  it('tolerates null (LLM emission quirk)', () => {
    const v = parseVerdict(jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: null }));
    expect(v.approved).toBe(true);
    expect(v.activeSkillFollowed).toBeNull();
  });

  it('coerces the two unambiguous string forms', () => {
    const vFalse = parseVerdict(
      jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: 'false' })
    );
    expect(vFalse.activeSkillFollowed).toBe(false);
    const vTrue = parseVerdict(
      jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: 'true' })
    );
    expect(vTrue.activeSkillFollowed).toBe(true);
  });

  it('drops garbage values instead of failing the whole verdict', () => {
    const v = parseVerdict(
      jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: 'maybe' })
    );
    expect(v.approved).toBe(true);
    expect(v.activeSkillFollowed).toBeUndefined();
  });
});

describe('VALIDATION_SYSTEM_PROMPT — adherence section', () => {
  it('teaches the activeSkillFollowed contract', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/== ACTIVE SKILL ADHERENCE/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/"activeSkillFollowed": true\|false/);
    // false must be an affirmative observation, never a default.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/false is an AFFIRMATIVE observation/);
    // The signal routes credit; it must never gate approval.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/NEVER changes your approve\/reject decision/);
  });
});

describe('renderActiveSkillBlock', () => {
  it('renders id + recipe body with clear delimiters', () => {
    const out = renderActiveSkillBlock({ id: 'web-build', body: 'STEP 1.\nSTEP 2.' });
    expect(out).toMatch(/== ACTIVE SKILL \(adherence check\) ==/);
    expect(out).toMatch(/Skill id: web-build/);
    expect(out).toMatch(/STEP 1\./);
  });

  it('bounds oversized bodies with an explicit truncation marker', () => {
    const out = renderActiveSkillBlock({
      id: 'big',
      body: 'x'.repeat(ADHERENCE_BODY_MAX_CHARS + 500),
    });
    expect(out).toMatch(/skill body truncated for the adherence check/);
    expect(out.length).toBeLessThan(ADHERENCE_BODY_MAX_CHARS + 400);
  });
});

describe('lastResultVerdictSkillFollowed — trace scan', () => {
  it('returns the most recent verdict-result signal', () => {
    const trace = [
      { kind: 'verdict-result', payload: { approved: false, activeSkillFollowed: true } },
      { kind: 'plan', payload: {} },
      { kind: 'verdict-result', payload: { approved: false, activeSkillFollowed: false } },
      { kind: 'escalated', payload: {} },
    ];
    expect(lastResultVerdictSkillFollowed(trace)).toBe(false);
  });

  it('returns undefined when no result verdict exists or the signal is absent', () => {
    expect(lastResultVerdictSkillFollowed([{ kind: 'verdict-plan', payload: {} }])).toBeUndefined();
    expect(
      lastResultVerdictSkillFollowed([{ kind: 'verdict-result', payload: { approved: true } }])
    ).toBeUndefined();
    expect(
      lastResultVerdictSkillFollowed([
        { kind: 'verdict-result', payload: { activeSkillFollowed: 'yes' } },
      ])
    ).toBeUndefined();
  });
});

describe('L2 supervise loop — usage-conditioned skill credit (end-to-end)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-credit-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
    skills.save('Water', {
      id: 'the-recipe',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'STEP 1: do the thing.\nSTEP 2: verify it.',
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** tier prefilter → skill prefilter → one clean L1 cycle up to validateResult. */
  function enqueueHappyPathUpToResult(ctx: ReturnType<typeof makeCtx>): void {
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'the-recipe', confidence: 'high', reasoning: 's' })
    );
    // L1.plan + L2.validatePlan (Water is untrusted → full LLM verdict).
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    // L1.execute — validateResult response is scenario-specific.
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));
  }

  it('shows the recipe to the RESULT validator only (adherence block placement)', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    enqueueHappyPathUpToResult(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: true }));

    await neuron.handleDirect({ description: 'task' }, ctx);

    // Call #4 is the PLAN verdict: adherence is a RESULT-phase judgment,
    // the block must not leak into plan validation.
    expect(ctx.llm.calls[3]!.userContent).not.toMatch(/ACTIVE SKILL \(adherence check\)/);
    // Call #6 is the RESULT verdict: recipe shown, signal requested.
    const resultCall = ctx.llm.calls[5]!;
    expect(resultCall.userContent).toMatch(/== ACTIVE SKILL \(adherence check\) ==/);
    expect(resultCall.userContent).toMatch(/Skill id: the-recipe/);
    expect(resultCall.userContent).toMatch(/STEP 1: do the thing/);
  });

  it('bumps the skill on activeSkillFollowed: true', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    enqueueHappyPathUpToResult(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: true }));

    await neuron.handleDirect({ description: 'task' }, ctx);
    expect(skills.loadFor('Water')[0]!.successes).toBe(1);
  });

  it('WITHHOLDS skill credit on activeSkillFollowed: false — atom type still credited', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    enqueueHappyPathUpToResult(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok', activeSkillFollowed: false }));

    await neuron.handleDirect({ description: 'task' }, ctx);

    const skill = skills.loadFor('Water')[0]!;
    expect(skill.successes).toBe(0);
    expect(skill.failures).toBe(0);
    // The match itself IS recorded (markMatched fires at match time), so
    // the withheld credit shows up as a free-ride gap in `skills stats`.
    expect(skill.matches).toBe(1);
    // The CHILD did succeed, whatever it was following — type credit is
    // orthogonal to skill credit and must survive the withholding.
    expect(reg.getByName('Water')!.successes).toBe(1);
  });

  it('marks an ignored script skill as not followed even on the type trust fast-path', async () => {
    skills.save('Water', {
      id: 'the-recipe',
      description: 'd',
      whenToUse: 'w',
      kind: 'script',
      language: 'node',
      body: 'process.stdout.write(JSON.stringify({output:{},summary:"ok"}))',
    });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess('Water');
    }
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const water = L1Atom.fromType(reg.getByName('Water')!);
    water.setActiveSkill('the-recipe', 'Water');
    const ctx = makeCtx();
    const verdict = await neuron.validateResult(
      water,
      {
        output: 'packaged without running the injected scratch script',
        summary: 'deliverable exists',
        activeScriptSkillExecuted: false,
        toolCallResults: [{ name: 'write_file', ok: true }],
        trace: [],
        producedBy: { tier: 1, name: 'Water', viaFallback: false },
      },
      { description: 'package the CLI' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(verdict.activeSkillFollowed).toBe(false);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('keeps the legacy bump when the validator omits the signal', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    enqueueHappyPathUpToResult(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await neuron.handleDirect({ description: 'task' }, ctx);
    expect(skills.loadFor('Water')[0]!.successes).toBe(1);
  });

  it('WITHHOLDS skill blame and SKIPS the revision when the failing run ignored the recipe', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'the-recipe', confidence: 'high', reasoning: 's' })
    );
    // Three identical RESULT rejections, each carrying the affirmative
    // non-adherence observation → repeat-escalation with the signal on
    // the last result verdict.
    for (let i = 0; i < 3; i++) {
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
      ctx.llm.enqueueText(jsonText({ output: 'wrong', summary: 'did something else' }));
      ctx.llm.enqueueText(
        jsonText({
          approved: false,
          reasoning: 'deliverable is wrong',
          scope: 'ephemeral',
          activeSkillFollowed: false,
        })
      );
    }
    // NO improveSkillBody stub here: the revision must be skipped outright
    // (an unconsumed queue would throw on the Sonnet call). The legacy
    // registry-branch path fires instead and the branched L1 gets its
    // one-shot retry, which we let succeed.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a2', expectedOutput: 'e2' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok now' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await neuron.handleDirect({ description: 'task' }, ctx);

    const skill = skills.loadFor('Water')[0]!;
    // Blame withheld: the failure was not the recipe's.
    expect(skill.failures).toBe(0);
    // Revision skipped: no Sonnet improveSkillBody call was made, and the
    // body is untouched.
    expect(ctx.llm.calls.some((c) => c.userContent.includes('IMPROVED body'))).toBe(false);
    expect(skill.body).toBe('STEP 1: do the thing.\nSTEP 2: verify it.');
    // The atom type still records its failure (the child DID fail).
    expect(reg.getByName('Water')!.failures).toBe(1);
  });

  it('still blames the skill when the signal is absent from the failing cycle', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'the-recipe', confidence: 'high', reasoning: 's' })
    );
    for (let i = 0; i < 3; i++) {
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
      ctx.llm.enqueueText(jsonText({ output: 'wrong', summary: 'nope' }));
      ctx.llm.enqueueText(
        jsonText({ approved: false, reasoning: 'deliverable is wrong', scope: 'ephemeral' })
      );
    }
    // Legacy behaviour: the skill-update path fires (improveSkillBody).
    ctx.llm.enqueueText('STEP 1: do the REVISED thing.\nSTEP 2: verify it better.');
    // One-shot retry with the revised recipe — let it succeed.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a2', expectedOutput: 'e2' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok now' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await neuron.handleDirect({ description: 'task' }, ctx);

    const skill = skills.loadFor('Water')[0]!;
    expect(skill.failures).toBe(1);
    expect(ctx.llm.calls.some((c) => c.userContent.includes('IMPROVED body'))).toBe(true);
    expect(skill.body).toBe('STEP 1: do the REVISED thing.\nSTEP 2: verify it better.');
  });
});
