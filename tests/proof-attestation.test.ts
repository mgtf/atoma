import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { attestingExecutor, baseExecutorOf, createAttestationLog } from '../src/core/attestation.js';
import {
  establishesDomInteraction,
  parseBrowserObservation,
  type AttestationRecord,
} from '../src/contracts/attestation.js';
import { checkProofCoverage, effectiveObligations } from '../src/atoms/proofCoverage.js';
import { PROOF_OBLIGATION_GUIDANCE } from '../src/atoms/prompts.js';
import { subtaskSpecSchema } from '../src/atoms/json.js';
import {
  drainLines,
  encodeMessage,
  isToolCallResponse,
} from '../src/tools/containerProtocol.js';
import { makeCtx, jsonText, nsOf } from './helpers.js';
import type { RunContext, SkillEventInfo, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * SUPERVISOR-HELD PROOF ATTESTATION (A1).
 *
 * The cold `web-counter` run of 2026-08-22: eight requested clicks, all
 * discarded by the smoke filter, an empty interaction log, `ok: true`, an
 * approved RESULT, and a distilled recipe teaching the next run to drive
 * state through `window.__*` hooks. Every test below pins one link of the
 * chain that made that possible.
 *
 * See docs/supervisor-attestation-a1-review-2026-08-22.md.
 */

/** The cold counter case: requested interactions, none executed. */
const COUNTER_RESULT = {
  ok: true,
  url: 'http://localhost:5051/',
  title: 'Counter',
  errors: [],
  warnings: [
    '8 external interaction(s) ignored because the smoke IIFE drives and snapshots its own state transitions',
  ],
  failedRequests: [],
  interactionLog: [],
  requestedInteractions: 8,
  ignoredInteractions: 8,
  smokeResult: { ok: true, count: 3 },
  document: { path: 'index.html', sha256: 'a'.repeat(64) },
};

/** The positive control: Puppeteer actually clicked. */
const STOPWATCH_RESULT = {
  ok: true,
  url: 'http://localhost:5052/',
  title: 'Stopwatch',
  errors: [],
  warnings: [],
  failedRequests: [],
  interactionLog: ['click #startStopBtn', 'click #lapBtn'],
  requestedInteractions: 2,
  ignoredInteractions: 0,
  smokeResult: { ok: true, elapsed: 1.2 },
};

function tool(name: string): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

/** Executor that answers validate_html with a fixed observation. */
class StubExecutor implements ToolExecutor {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    private readonly browserResult: unknown,
    private readonly files: Record<string, string> = {}
  ) {}
  has(name: string): boolean {
    return name === 'validate_html' || name === 'read_file' || name === 'list_files';
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'validate_html') return this.browserResult;
    if (name === 'read_file') {
      const path = String(args['path']);
      if (!(path in this.files)) throw new Error(`ENOENT: ${path}`);
      return { path, content: this.files[path] };
    }
    if (name === 'list_files') {
      return {
        path: '.',
        entries: Object.entries(this.files).map(([n, c]) => ({
          name: n,
          kind: 'file',
          size: c.length,
        })),
      };
    }
    return { ok: true };
  }
}

describe('browser observation — requested and executed are separate facts', () => {
  it('reads the cold counter case as ZERO executed interactions', () => {
    const observed = parseBrowserObservation({ interactions: new Array(8).fill({}) }, COUNTER_RESULT);
    expect(observed).not.toBeNull();
    expect(observed!.ok).toBe(true);
    expect(observed!.requestedInteractions).toBe(8);
    expect(observed!.ignoredInteractions).toBe(8);
    expect(observed!.executedInteractions).toEqual([]);
    // The whole point: ok:true does not establish that input reached the page.
    expect(
      establishesDomInteraction({ eventId: 'e', tool: 'validate_html', observation: observed! })
    ).toBe(false);
  });

  it('reads the positive control as executed interactions', () => {
    const observed = parseBrowserObservation({}, STOPWATCH_RESULT);
    expect(observed!.executedInteractions).toEqual(['click #startStopBtn', 'click #lapBtn']);
    expect(
      establishesDomInteraction({ eventId: 'e', tool: 'validate_html', observation: observed! })
    ).toBe(true);
  });

  it('falls back to the ARGS for the requested count on an older tool build', () => {
    const legacy = { ok: true, errors: [], failedRequests: [], interactionLog: [] };
    const observed = parseBrowserObservation(
      { interactions: [{ type: 'click', selector: '#a' }, { type: 'click', selector: '#b' }] },
      legacy
    );
    expect(observed!.requestedInteractions).toBe(2);
    expect(observed!.executedInteractions).toEqual([]);
  });

  it('is null for anything that is not a browser observation', () => {
    expect(parseBrowserObservation({}, { ok: true })).toBeNull();
    expect(parseBrowserObservation({}, 'a string')).toBeNull();
    expect(parseBrowserObservation({}, null)).toBeNull();
  });
});

describe('attesting executor — the transport seam', () => {
  it('attests validate_html and passes the result through untouched', async () => {
    const log = createAttestationLog();
    const base = new StubExecutor(STOPWATCH_RESULT);
    const wrapped = attestingExecutor(base, log, 'branch-1')!;
    const result = await wrapped.execute('validate_html', { url: 'http://x/' });
    expect(result).toBe(STOPWATCH_RESULT);
    expect(log.size).toBe(1);
    expect(log.forBranch('branch-1')[0]!.tool).toBe('validate_html');
  });

  it('ignores tools that carry no observation', async () => {
    const log = createAttestationLog();
    const wrapped = attestingExecutor(new StubExecutor(STOPWATCH_RESULT), log, 'b')!;
    await wrapped.execute('read_file', { path: 'a.txt' }).catch(() => undefined);
    expect(log.size).toBe(0);
  });

  it('degrades to UNATTESTED instead of failing the tool call', async () => {
    const failing = {
      append: () => {
        throw new Error('log exploded');
      },
      forBranch: () => [],
      size: 0,
    };
    const messages: string[] = [];
    const wrapped = attestingExecutor(
      new StubExecutor(STOPWATCH_RESULT),
      failing,
      'b',
      (m) => messages.push(m)
    )!;
    await expect(wrapped.execute('validate_html', {})).resolves.toBe(STOPWATCH_RESULT);
    expect(messages.join(' ')).toMatch(/UNATTESTED/);
  });

  it('returns the executor unchanged when there is nothing to attest into', () => {
    const base = new StubExecutor(STOPWATCH_RESULT);
    expect(attestingExecutor(base, undefined, 'b')).toBe(base);
    expect(attestingExecutor(undefined, createAttestationLog(), 'b')).toBeUndefined();
  });
});

describe('forkBranch — one log, forked AND nested', () => {
  function rootCtx(base: ToolExecutor): RunContext {
    return { ...makeCtx(), tools: base };
  }

  it('shares ONE log reference across the root and every fork', () => {
    const base = new StubExecutor(STOPWATCH_RESULT);
    const root = rootCtx(base);
    const a = forkBranch(root, 'a');
    const b = forkBranch(root, 'b');
    const nested = forkBranch(a, 'a-child');
    // Lazily initialised on the PARENT, exactly like the run-scoped memos:
    // a fork-local log would answer "what this fork saw" instead of "what
    // happened in that branch".
    expect(root.attestations).toBeDefined();
    expect(a.attestations).toBe(root.attestations);
    expect(b.attestations).toBe(root.attestations);
    expect(nested.attestations).toBe(root.attestations);
  });

  it('appends EXACTLY ONCE through a nested fork, under the innermost branch', async () => {
    // The double-append hazard: forkBranch runs on an already-forked ctx, so
    // a wrapper wrapping a wrapper would record the same call twice under two
    // branch ids, and coverage would then "find" an observation in an
    // ancestor branch that never made it.
    const base = new StubExecutor(STOPWATCH_RESULT);
    const root = rootCtx(base);
    const outer = forkBranch(root, 'outer');
    const inner = forkBranch(outer, 'inner');
    await inner.tools!.execute('validate_html', { url: 'http://x/' });
    expect(root.attestations!.size).toBe(1);
    expect(root.attestations!.forBranch('inner')).toHaveLength(1);
    expect(root.attestations!.forBranch('outer')).toHaveLength(0);
    expect(baseExecutorOf(inner.tools!)).toBe(base);
  });

  it('keeps sibling lanes separate', async () => {
    const root = rootCtx(new StubExecutor(STOPWATCH_RESULT));
    const laneA = forkBranch(root, 'lane-a');
    const laneB = forkBranch(root, 'lane-b');
    await Promise.all([
      laneA.tools!.execute('validate_html', { url: 'http://a/' }),
      laneB.tools!.execute('validate_html', { url: 'http://b/' }),
    ]);
    expect(root.attestations!.forBranch('lane-a')).toHaveLength(1);
    expect(root.attestations!.forBranch('lane-b')).toHaveLength(1);
  });

  it('preserves the executor when the ctx has no tools at all', () => {
    const bare = makeCtx();
    const forked = forkBranch(bare, 'b');
    expect(forked.tools).toBeUndefined();
    expect(forked.attestations).toBeDefined();
  });
});

describe('checkProofCoverage', () => {
  function ctxWith(records: AttestationRecord[], files: Record<string, string> = {}): RunContext {
    const log = createAttestationLog();
    for (const record of records) log.append(record);
    const base = new StubExecutor(STOPWATCH_RESULT, files);
    return { ...makeCtx(), tools: base, attestations: log, currentBranchId: 'phase' };
  }

  function record(raw: unknown, args: Record<string, unknown> = {}): AttestationRecord {
    return {
      eventId: 'ev-1',
      branchId: 'phase',
      tool: 'validate_html',
      observation: parseBrowserObservation(args, raw)!,
    };
  }

  it('costs nothing when the plan declared no obligation', async () => {
    const ctx = ctxWith([]);
    const coverage = await checkProofCoverage({ ctx, obligations: [] });
    expect(coverage).toEqual([]);
    expect((ctx.tools as StubExecutor).calls).toHaveLength(0);
  });

  it('is UNCOVERED when every requested interaction was filtered', async () => {
    const ctx = ctxWith([record(COUNTER_RESULT, { interactions: new Array(8).fill({}) })]);
    const coverage = await checkProofCoverage({ ctx, obligations: ['dom-interaction'] });
    expect(coverage[0]!.covered).toBe(false);
    expect(coverage[0]!.reason).toMatch(/none with an executed interaction/);
    expect(coverage[0]!.reason).toMatch(/8 requested interaction\(s\) were filtered/);
  });

  it('is UNCOVERED when no browser observation was attested at all', async () => {
    const coverage = await checkProofCoverage({
      ctx: ctxWith([]),
      obligations: ['dom-interaction'],
    });
    expect(coverage[0]!.covered).toBe(false);
    expect(coverage[0]!.reason).toMatch(/no browser observation was attested/);
  });

  it('is COVERED by an executed interaction whose document is unchanged', async () => {
    const html = '<html><button id="startStopBtn"></button></html>';
    const digest = createHash('sha256').update(html, 'utf8').digest('hex');
    const ctx = ctxWith(
      [record({ ...STOPWATCH_RESULT, document: { path: 'index.html', sha256: digest } })],
      { 'index.html': html }
    );
    const coverage = await checkProofCoverage({ ctx, obligations: ['dom-interaction'] });
    expect(coverage[0]!.covered).toBe(true);
    expect(coverage[0]!.reason).toMatch(/executed=2/);
    expect(coverage[0]!.eventIds).toEqual(['ev-1']);
  });

  it('is UNCOVERED when the observed document was MUTATED afterwards', async () => {
    // Binding an observation to an artifact revision is the whole reason the
    // digest exists: without it a proof taken before a rewrite is
    // indistinguishable from one taken after.
    const ctx = ctxWith(
      [record({ ...STOPWATCH_RESULT, document: { path: 'index.html', sha256: 'stale'.repeat(10) } })],
      { 'index.html': '<html>rewritten</html>' }
    );
    const coverage = await checkProofCoverage({ ctx, obligations: ['dom-interaction'] });
    expect(coverage[0]!.covered).toBe(false);
    expect(coverage[0]!.reason).toMatch(/index\.html was MUTATED after the observation/);
  });

  it('COVERS an unbound observation rather than inventing staleness', async () => {
    // Deliberate asymmetry: absent evidence grants coverage, contradictory
    // evidence refuses it. A digest over a guessed file set would produce
    // false staleness, and a silently withheld credit is the failure mode
    // this contract exists to remove.
    const ctx = ctxWith([record(STOPWATCH_RESULT)]);
    const coverage = await checkProofCoverage({ ctx, obligations: ['dom-interaction'] });
    expect(coverage[0]!.covered).toBe(true);
  });
});

describe('declared obligations — plan shape and inheritance', () => {
  it('parses the one accepted value and DROPS anything else', () => {
    const parsed = subtaskSpecSchema.parse({
      description: 'click the buttons',
      proofObligations: ['dom-interaction', 'clicks-work', ' dom-interaction '],
    });
    expect(parsed.proofObligations).toEqual(['dom-interaction']);
    expect(subtaskSpecSchema.parse({ description: 'd', proofObligations: null }).proofObligations)
      .toBeUndefined();
    expect(subtaskSpecSchema.parse({ description: 'd' }).proofObligations).toBeUndefined();
  });

  it('inherits an obligation declared one tier up', () => {
    expect(effectiveObligations({ description: 'd' } as never, { proofObligations: ['dom-interaction'] }))
      .toEqual(['dom-interaction']);
    expect(
      effectiveObligations({ proofObligations: ['dom-interaction'] }, { proofObligations: ['dom-interaction'] })
    ).toEqual(['dom-interaction']);
    expect(effectiveObligations(undefined, undefined)).toEqual([]);
  });

  it('is taught to planners, and teaches the hook trap explicitly', () => {
    expect(PROOF_OBLIGATION_GUIDANCE).toMatch(/"proofObligations": \["dom-interaction"\]/);
    expect(PROOF_OBLIGATION_GUIDANCE).toMatch(/window\.\*/);
  });
});

describe('L2 — an uncovered obligation withholds METHOD credit, never approval', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;

  const seed = {
    description: 'web orchestrator',
    systemPrompt: 'You are an L2.',
    tools: [],
    params: {},
    createdBy: 'test',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-proof-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function webChild(): L1Atom {
    const type = reg.getByName('Water')!;
    return L1Atom.fromType({ ...type, tools: [tool('write_file'), tool('validate_html')] });
  }

  /**
   * A LIVE context: no attestation is pre-seeded. The log is created by
   * `forkBranch` during dispatch and written by the supervisor's own probe,
   * so the test exercises the seam rather than a fixture of it.
   */
  function liveCtx(raw: unknown): RunContext & {
    llm: ReturnType<typeof makeCtx>['llm'];
    skillEvents: SkillEventInfo[];
    stats: string[];
  } {
    const skillEvents: SkillEventInfo[] = [];
    const stats: string[] = [];
    return {
      ...makeCtx(),
      tools: new StubExecutor(raw, { 'index.html': '<html></html>' }),
      recordSkill: (info) => skillEvents.push(info),
      recordRunStat: (name) => stats.push(name),
      skillEvents,
      stats,
    };
  }

  function ctxWithObservation(raw: unknown): RunContext & {
    llm: ReturnType<typeof makeCtx>['llm'];
    skillEvents: SkillEventInfo[];
    stats: string[];
  } {
    const log = createAttestationLog();
    const observation = parseBrowserObservation({}, raw);
    if (observation) {
      log.append({ eventId: 'ev-1', branchId: 'phase', tool: 'validate_html', observation });
    }
    const skillEvents: SkillEventInfo[] = [];
    const stats: string[] = [];
    const base = makeCtx();
    return {
      ...base,
      tools: new StubExecutor(raw, { 'index.html': '<html></html>' }),
      attestations: log,
      currentBranchId: 'phase',
      recordSkill: (info) => skillEvents.push(info),
      recordRunStat: (name) => stats.push(name),
      skillEvents,
      stats,
    };
  }

  const RESULT = {
    output: { url: 'http://localhost:5051/', files: ['index.html'] },
    summary: 'counter built and validated',
    toolCallResults: [{ name: 'validate_html', ok: true }],
    trace: [],
    producedBy: { tier: 1 as const, name: 'Water', viaFallback: false },
  };

  const TASK = {
    description: 'build a counter whose buttons change the displayed count',
    proofObligations: ['dom-interaction'] as const,
  };

  it('marks the verdict proofUncovered and shows the validator the machine facts', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = ctxWithObservation(COUNTER_RESULT);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the page works' }));

    const verdict = await neuron.validateResult(webChild(), RESULT, TASK, ctx);

    expect(verdict.approved).toBe(true);
    expect(verdict.approved === true && verdict.proofUncovered).toBe(true);
    const prompt = ctx.llm.calls.at(-1)!.userContent;
    expect(prompt).toMatch(/== DECLARED PROOF OBLIGATIONS/);
    expect(prompt).toMatch(/UNCOVERED — dom-interaction NOT covered/);
    // It must not read as an instruction to reject a working deliverable.
    expect(prompt).toMatch(/not by itself a reason to reject/);
  });

  it('leaves a covered phase completely untouched', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = ctxWithObservation(STOPWATCH_RESULT);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    const verdict = await neuron.validateResult(webChild(), RESULT, TASK, ctx);

    expect(verdict.approved === true && verdict.proofUncovered).toBeFalsy();
    expect(ctx.llm.calls.at(-1)!.userContent).toMatch(/COVERED — dom-interaction covered/);
  });

  it('denies the trust fast-path to an uncovered phase', async () => {
    // A trusted type is precisely the one nobody is watching any more: the
    // fast path may skip the LLM verdict, it may not skip the attestation.
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = ctxWithObservation(COUNTER_RESULT);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'full verdict' }));

    const verdict = await neuron.validateResult(webChild(), RESULT, TASK, ctx);

    expect(ctx.llm.calls).toHaveLength(1);
    expect(verdict.approved === true && verdict.proofUncovered).toBe(true);
  });

  it('takes the trust fast-path when the obligation IS covered', async () => {
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = ctxWithObservation(STOPWATCH_RESULT);

    const verdict = await neuron.validateResult(webChild(), RESULT, TASK, ctx);

    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  /**
   * End-to-end through the PRODUCTION path: `handleDirect` plans, dispatches
   * a subtask, forks the branch, and the supervisor's own ground-truth probe
   * runs `validate_html` through the forked (attesting) executor. The stub
   * decides what that observation contains, which is how the two controls
   * differ here — the plumbing under test is everything after the tool
   * returns.
   */
  function enqueuePlanCycle(
    ctx: ReturnType<typeof makeCtx>,
    opts: { skill?: string } = {}
  ): void {
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    if (opts.skill) {
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: opts.skill, confidence: 'high', reasoning: 's' })
      );
    }
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    // The L1 execute turn. The mock has no tool loop of its own, so the turn
    // itself drives the browser through the executor the runtime handed the
    // child — the attesting wrapper installed by `forkBranch`. That is the
    // seam under test: what the child calls, the transport observes.
    ctx.llm.enqueue(async (req) => {
      await req.executor!.execute('validate_html', {
        url: 'http://localhost:5051/',
        interactions: [
          { type: 'click', selector: '#inc' },
          { type: 'click', selector: '#dec' },
        ],
        smoke: 'window.__counter.value === 1',
      });
      return {
        text: jsonText({
          output: { url: 'http://localhost:5051/', files: ['index.html'] },
          summary: 'counter built and validated',
        }),
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    });
  }

  it('withholds atom trust, skill credit and the run stat on an approved run', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    skills.save(nsOf(reg, 'Water'), {
      id: 'build-interactive-html-widget',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'Simulate interactions through the exposed window object.',
    });
    const ctx = liveCtx(COUNTER_RESULT);
    enqueuePlanCycle(ctx, { skill: 'build-interactive-html-widget' });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the page works' }));
    const before = reg.getByName('Water')!.successes;

    const result = await neuron.handleDirect(TASK, ctx);

    // The deliverable is delivered: approval is a judgment about the artifact.
    expect(result.summary).toMatch(/counter built/);
    // Every claim about the METHOD is withheld.
    expect(reg.getByName('Water')!.successes).toBe(before);
    expect(skills.loadFor(nsOf(reg, 'Water'))[0]!.successes ?? 0).toBe(0);
    expect(ctx.skillEvents.filter((e) => e.op === 'credit-withheld')).toHaveLength(1);
    expect(
      ctx.skillEvents.find((e) => e.op === 'credit-withheld')!.reasoning
    ).toMatch(/no transport-observed attestation/);
    expect(ctx.skillEvents.some((e) => e.op === 'success')).toBe(false);
    expect(ctx.stats).toContain('uncovered-obligation');
  });

  it('credits atom trust and the skill when the obligation is covered', async () => {
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    skills.save(nsOf(reg, 'Water'), {
      id: 'click-through-the-real-dom',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'Drive the affordance with selector-based interactions.',
    });
    const ctx = liveCtx(STOPWATCH_RESULT);
    enqueuePlanCycle(ctx, { skill: 'click-through-the-real-dom' });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    const before = reg.getByName('Water')!.successes;

    await neuron.handleDirect(TASK, ctx);

    expect(reg.getByName('Water')!.successes).toBe(before + 1);
    expect(ctx.skillEvents.some((e) => e.op === 'success')).toBe(true);
    expect(ctx.skillEvents.some((e) => e.op === 'credit-withheld')).toBe(false);
    expect(ctx.stats).not.toContain('uncovered-obligation');
  });

  it('does not distil a skill from an uncovered novel run', async () => {
    // The measured contamination path: the counter run was novel, approved,
    // and distilled `build-interactive-html-widget`, which the next run then
    // matched, injected and credited.
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const previous = process.env['ATOMA_SKILL_LEARN'];
    process.env['ATOMA_SKILL_LEARN'] = '1';
    try {
      const ctx = liveCtx(COUNTER_RESULT);
      enqueuePlanCycle(ctx);
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the page works' }));

      await neuron.handleDirect(TASK, ctx);

      expect(skills.loadFor(nsOf(reg, 'Water'))).toHaveLength(0);
      expect(ctx.skillEvents.some((e) => e.op === 'learn')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['ATOMA_SKILL_LEARN'];
      else process.env['ATOMA_SKILL_LEARN'] = previous;
    }
  });
});

describe('the observation survives the worker/container protocol', () => {
  it('round-trips requested/executed/document through encode → drain', () => {
    // The observation is only useful if it reaches the supervisor from
    // WHEREVER the tool ran. Both out-of-process executors forward the tool
    // result as opaque JSON, which is exactly why the added fields need no
    // protocol change — and exactly why that needs pinning: a future
    // field-enumerating serialiser would drop them silently and the seam
    // would keep reporting "no interaction executed" for every container run.
    const line = encodeMessage({ id: 1, ok: true, result: STOPWATCH_RESULT });
    const { messages } = drainLines(line);
    expect(messages).toHaveLength(1);
    const response = messages[0];
    expect(isToolCallResponse(response)).toBe(true);
    const observed = parseBrowserObservation(
      {},
      (response as { result: unknown }).result
    );
    expect(observed!.executedInteractions).toEqual(['click #startStopBtn', 'click #lapBtn']);
    expect(observed!.requestedInteractions).toBe(2);

    const filtered = encodeMessage({ id: 2, ok: true, result: COUNTER_RESULT });
    const parsedFiltered = parseBrowserObservation(
      {},
      (drainLines(filtered).messages[0] as { result: unknown }).result
    );
    expect(parsedFiltered!.ignoredInteractions).toBe(8);
    expect(parsedFiltered!.executedInteractions).toEqual([]);
    expect(parsedFiltered!.document).toEqual({ path: 'index.html', sha256: 'a'.repeat(64) });
  });
});

describe('an obligation declared at L3 reaches the supervisor that watches the tools', () => {
  /**
   * MEASURED REGRESSION, first armed control 2026-08-22. The L3 planner
   * declared `proofObligations: ["dom-interaction"]` on its phase and the
   * gate stayed inert: `L3Atom.runSubtask` threaded `outputs` onto the child
   * Task and dropped this field, so the L2 saw a task with no obligation and
   * had nothing to union. Fourteen requested interactions were discarded,
   * zero executed, the RESULT was approved, atom trust was credited, and a
   * recipe teaching "a smoke script exercising each control" was distilled.
   *
   * 2419 unit tests were green at the time: every one of them declared the
   * obligation at the tier that CONSUMES it. This test therefore crosses the
   * L3 → L2 → L1 boundary the bug crossed, declares the obligation ONLY in
   * the L3 plan, and asserts both ends — what the L2's verdict was shown, and
   * what the run refused to credit.
   */
  const seed = {
    description: 'seed',
    systemPrompt: 'sys',
    tools: [],
    params: {},
    createdBy: 'test',
  };

  /**
   * Answers by ROLE and by ACTOR TIER, so the assertions depend on neither
   * call ordering nor prompt prose. Only the TIER-3 plan declares the
   * obligation; if the field failed to travel, the L2 would see none.
   */
  class RoleDrivenLlm {
    readonly calls: Array<{ role?: string; tier?: number; userContent: string }> = [];
    constructor(
      private readonly l2Name: string,
      private readonly l1Name: string
    ) {}
    async complete(req: {
      role?: string;
      actor?: { tier?: number };
      userContent: string;
      executor?: ToolExecutor;
    }): Promise<{
      text: string;
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      this.calls.push({
        role: req.role,
        ...(req.actor?.tier !== undefined ? { tier: req.actor.tier } : {}),
        userContent: req.userContent,
      });
      const reply = (value: unknown) => ({
        text: JSON.stringify(value),
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      });
      const tier = req.actor?.tier;
      switch (req.role) {
        case 'prefilter':
          return reply({
            kind: 'reuse',
            target: tier === 3 ? this.l2Name : this.l1Name,
            confidence: 'high',
            reasoning: 'fits',
          });
        case 'plan':
          if (tier === 3) {
            // L3's plan turn returns a PAIR: the routing strategy, then the
            // plan (`parseTwoJson`).
            return {
              text: JSON.stringify([
                { strategy: 'reuse', target: this.l2Name, reasoning: 'fits' },
                {
                  reasoning: 'one phase',
                  subtasks: [
                    {
                      description: 'build and verify the counter widget',
                      preferredChild: this.l2Name,
                      outputs: ['index.html'],
                      proofObligations: ['dom-interaction'],
                    },
                  ],
                  aggregation: { mode: 'sequential' },
                  expectedOutput: 'a working widget',
                },
              ]),
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 10 },
            };
          }
          if (tier === 2) {
            // Deliberately silent about the obligation: the L2 plan must not
            // be the thing that saves the gate.
            return reply({
              reasoning: 'delegate',
              subtasks: [
                {
                  description: 'write index.html and verify it in the browser',
                  preferredChild: this.l1Name,
                  outputs: ['index.html'],
                },
              ],
              aggregation: { mode: 'concat' },
              expectedOutput: 'index.html verified',
            });
          }
          return reply({ reasoning: 'r', proposedAction: 'write and verify', expectedOutput: 'e' });
        case 'validate-plan':
        case 'validate-result':
          return reply({ approved: true, reasoning: 'ok' });
        case 'execute': {
          // The child drives the browser through the executor the runtime
          // handed it — the attesting wrapper installed by forkBranch.
          if (req.executor) {
            await req.executor.execute('validate_html', {
              url: 'http://localhost:5051/',
              interactions: [{ type: 'click', selector: '#inc' }],
              smoke: 'window.__counter.increment()',
            });
          }
          return reply({
            output: { url: 'http://localhost:5051/', files: ['index.html'] },
            summary: 'widget built and validated',
          });
        }
        default:
          return reply({ approved: true, reasoning: 'ok' });
      }
    }
  }

  it('withholds credit on a phase whose obligation only the L3 plan declared', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    const l1Type = reg.create(1, {
      ...seed,
      tools: [tool('write_file'), tool('validate_html')],
    });
    const stats: string[] = [];
    const llm = new RoleDrivenLlm(l2Type.name, l1Type.name);
    const ctx = {
      ...makeCtx(),
      llm: llm as unknown as RunContext['llm'],
      tools: new StubExecutor(COUNTER_RESULT, { 'index.html': '<html></html>' }),
      recordRunStat: (name: string) => stats.push(name),
    };

    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    await l3.handle(
      { description: 'build a counter whose buttons change the displayed count' },
      ctx
    );

    // End 1: the L2's RESULT verdict was shown the machine-observed facts.
    const shown = llm.calls
      .filter((c) => c.role === 'validate-result' && c.tier === 2)
      .map((c) => c.userContent)
      .join('\n');
    expect(shown).toMatch(/== DECLARED PROOF OBLIGATIONS/);
    expect(shown).toMatch(/UNCOVERED — dom-interaction NOT covered/);

    // End 2: the run refused to credit the method.
    expect(reg.getByName(l1Type.name)!.successes).toBe(0);
    expect(stats).toContain('uncovered-obligation');
  });
});
