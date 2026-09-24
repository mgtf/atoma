import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Atom, type Supervisor } from '../src/core/atom.js';
import { createAttestationLog, attestingExecutor } from '../src/core/attestation.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { superviseLoop } from '../src/core/supervisor.js';
import type { Plan, Result, RunContext, Task, Tier, ToolExecutor, Verdict } from '../src/core/types.js';
import { modelForTier } from '../src/core/models.js';
import { rootProofCoverage, acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { dispatchWithAggregation, markLanded } from '../src/atoms/dispatch.js';
import { NON_JSON_PAYLOAD_SUMMARY_PREFIX } from '../src/atoms/json.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { PROBE_MANIFEST_FILENAME } from '../src/contracts/probeManifest.js';
import { runDepthTask, MAX_ROOT_REMEDIATIONS } from '../src/run/depth.js';
import { landingReasons } from '../src/contracts/runLanding.js';
import { acceptanceSchema, type AcceptanceInfo, type PhaseCoverageRecord, type TopologyInfo } from '../src/contracts/depthRouting.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

const task: Task = { description: 'Build the page' };
const floor = [{ obligation: 'dom-interaction' as const, deliverable: 'index.html' }];
const result: Result = { output: { complete: true }, summary: 'Done', trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } };
class Executor implements ToolExecutor {
  files: Record<string, string> = { 'index.html': '<button>Click</button>' };
  has(name: string) { return ['read_file', 'validate_html'].includes(name); }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const path = typeof args['path'] === 'string' ? args['path'] : 'index.html';
    if (name === 'read_file') {
      if (!(path in this.files)) throw new Error('ENOENT');
      return { content: this.files[path] };
    }
    return { ok: true, url: 'http://localhost:5050/', errors: [], warnings: [], failedRequests: [],
      interactionLog: ['click button'], requestedInteractions: 1, ignoredInteractions: 0,
      document: { path, sha256: createHash('sha256').update(this.files[path]!).digest('hex') } };
  }
}
class Actor extends Atom implements Supervisor<Actor> {
  readonly model = 'test';
  fallbackExecutions = 0;
  plans = 0;
  constructor(readonly tier: Tier = 2, readonly reject = false, toolNames = ['read_file', 'validate_html']) {
    super({ name: `actor-${tier}`, ordinal: 1, systemPrompt: '', tools: makeTools(toolNames), params: {} });
  }
  async plan(): Promise<Plan> { this.plans++; return makePlan(); }
  async execute(): Promise<Result> {
    if (this.isFallbackMode()) this.fallbackExecutions++;
    return { ...result, producedBy: { name: this.name, tier: this.tier, viaFallback: this.isFallbackMode() } };
  }
  async validatePlan(): Promise<Verdict> {
    return this.reject ? { approved: false, reasoning: 'fixture verdict', scope: 'ephemeral', modifications: {} }
      : { approved: true, reasoning: 'fixture verdict' };
  }
  async validateResult(): Promise<Verdict> { return this.validatePlan(); }
}
function context(executor = new Executor()) {
  return { ...makeCtx(), tools: executor, attempt: 1, attestations: createAttestationLog() };
}
async function observe(ctx: RunContext, branch = 'descendant', path = 'index.html') {
  const fork = forkBranch(forkBranch(ctx, 'ancestor'), branch);
  await fork.tools!.execute('validate_html', { path });
}

describe('root delivery coverage', () => {
  it('collects descendant evidence only once and carries attempt through nested forks', async () => {
    const ctx = context();
    const beforeFallback = vi.fn();
    const recordPhaseCoverage = vi.fn();
    const nested = forkBranch(forkBranch({ ...ctx, beforeFallback, recordPhaseCoverage }, 'a'), 'b');
    expect(nested.beforeFallback).toBe(beforeFallback);
    expect(nested.recordPhaseCoverage).toBe(recordPhaseCoverage);
    await nested.tools!.execute('validate_html', {});
    expect(ctx.attestations.forAttempt(1)).toHaveLength(1);
    expect(ctx.attestations.forAttempt(1)[0]).toMatchObject({ attempt: 1, branchId: 'b' });
    expect(await rootProofCoverage(ctx, floor)).toMatchObject([{ status: 'covered', observationRefs: [expect.any(String)] }]);
  });
  it.each(['sibling', 'mutated', 'abandoned', 'unbound', 'missing'] as const)('does not cover %s proof', async (kind) => {
    const ctx = context();
    ctx.tools.files['other.html'] = ctx.tools.files['index.html']!;
    await observe(ctx, 'branch', kind === 'sibling' ? 'other.html' : 'index.html');
    if (kind === 'mutated') ctx.tools.files['index.html'] = 'changed';
    if (kind === 'missing') delete ctx.tools.files['index.html'];
    if (kind === 'abandoned') ctx.attempt = 2;
    if (kind === 'unbound') {
      const record = ctx.attestations.forAttempt(1)[0]!;
      const { document: _document, ...observation } = record.observation;
      ctx.attestations = createAttestationLog();
      ctx.attestations.append({ ...record, observation });
    }
    expect(await rootProofCoverage(ctx, floor)).toEqual([{ kind: 'dom-interaction', deliverable: 'index.html', status: 'uncovered', observationRefs: [] }]);
  });
  it('records direct fallback observations without a branch', async () => {
    const ctx = context();
    await attestingExecutor(ctx.tools, ctx.attestations, undefined, undefined, 2)!.execute('validate_html', {});
    expect(ctx.attestations.forAttempt(2)[0]).toMatchObject({ attempt: 2 });
    expect(ctx.attestations.forAttempt(2)[0]!.branchId).toBeUndefined();
    expect(await rootProofCoverage({ ...ctx, attempt: 2 }, floor)).toMatchObject([{ status: 'covered' }]);
  });
});

describe('one common root acceptance, independent of phase credit', () => {
  it.each([2, 3] as const)('does not probe internal plan/verdict/fallback quotes at tier %s', async (tier) => {
    const ctx = context();
    ctx.tools.files['server.js'] = 'const answer = 42;';
    const staleQuote = 'Line 1 of server.js:\nconst answer = "abandoned implementation";';
    // These strings really occur in Result.trace, outside the delivery claims.
    const delivered: Result = { ...result, output: { files: ['server.js'] }, summary: 'Server written',
      trace: [
        { ts: new Date().toISOString(), atom: 'leaf', kind: 'plan', payload: makePlan({ reasoning: staleQuote }) },
        { ts: new Date().toISOString(), atom: 'cell', kind: 'verdict-result', payload: { approved: true, reasoning: staleQuote } },
        { ts: new Date().toISOString(), atom: 'cell', kind: 'escalated', payload: { diagnostic: staleQuote } },
      ] };
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Unexpected review' }));
    const actor = new Actor(tier, false, ['read_file', 'write_file']);
    const accepted = await acceptRootResult({ actor, task, result: delivered, ctx, floor: [], phaseCoverage: [] });
    expect(accepted).toMatchObject({ approved: true, basis: 'mechanical', probe: { requiresReview: false, contradiction: false } });
    expect(ctx.llm.calls).toHaveLength(0);

    // The SAME false quote in the final summary is still a delivery claim.
    const reviewed = await acceptRootResult({ actor, task, result: { ...delivered, summary: staleQuote }, ctx, floor: [], phaseCoverage: [] });
    expect(reviewed).toMatchObject({ basis: 'validation-call', probe: { requiresReview: true, contradiction: true } });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('NOT FOUND');
  });
  it('accepts covered delivery mechanically and copies phase records without reevaluating them', async () => {
    const ctx = context();
    await observe(ctx);
    const phase: PhaseCoverageRecord = { attempt: 1, branchId: 'added-by-plan', acceptor: { name: 'cell', tier: 2 },
      executor: { name: 'leaf', tier: 1 }, obligations: [{ obligation: 'dom-interaction', covered: false, reason: 'No phase proof', eventIds: [] }] };
    const accepted = await acceptRootResult({ actor: new Actor(), task, result, ctx, floor, phaseCoverage: [phase, { ...phase, attempt: 2 }] });
    expect(acceptanceSchema.parse(accepted)).toMatchObject({ approved: true, basis: 'mechanical', phaseCoverage: [phase, { ...phase, attempt: 2 }] });
    expect(ctx.llm.calls).toHaveLength(0);
  });
  it.each([true, false])('reviews uncovered delivery once, accepts=%s, with no method-credit hooks', async (approved) => {
    const ctx = context();
    const recordRunStat = vi.fn();
    const recordSkill = vi.fn();
    const recordTrust = vi.fn();
    ctx.llm.enqueueText(jsonText({ approved, reasoning: 'Reviewed delivery' }));
    const accepted = await acceptRootResult({ actor: new Actor(), task, result,
      ctx: { ...ctx, recordRunStat, recordSkill, recordTrust }, floor, phaseCoverage: [] });
    expect(accepted).toMatchObject({ approved, basis: 'validation-call', floorCoverage: [{ status: 'uncovered' }] });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.model).toBe(modelForTier(1));
    expect(recordRunStat).not.toHaveBeenCalled();
    expect(recordSkill).not.toHaveBeenCalled();
    expect(recordTrust).not.toHaveBeenCalled();
  });
  it('rejects the delegated failure envelope without a validator call', async () => {
    const ctx = context();
    const accepted = await acceptRootResult({ actor: new Actor(3), task, ctx, floor: [], phaseCoverage: [],
      result: { ...result, summary: NON_JSON_PAYLOAD_SUMMARY_PREFIX + ' broken' } });
    expect(accepted).toMatchObject({ approved: false, gates: [{ id: 'non-json-envelope', disposition: 'reject' }] });
    expect(ctx.llm.calls).toHaveLength(0);
  });
  it('reviews a malformed manifest even when it is not a contradiction', async () => {
    const ctx = context();
    ctx.tools.files[PROBE_MANIFEST_FILENAME] = '{';
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Malformed proof reviewed' }));
    const accepted = await acceptRootResult({ actor: new Actor(3), task, ctx, floor: [], phaseCoverage: [],
      result: { ...result, output: { url: 'http://localhost:5050/', probes: [{ probe: 'web', smoke: '({ok:true})' }] } } });
    expect(accepted).toMatchObject({ basis: 'validation-call', probe: { requiresReview: true, contradiction: false } });
    expect(ctx.llm.calls).toHaveLength(1);
  });
});

describe('depth transition through the production supervision loop', () => {
  it('does not start L3 or accept a result when backend teardown cannot be confirmed', async () => {
    const ctx = context();
    const actor = new Actor(2, true);
    const createExecutor = vi.fn(() => ({ actor, handle: (t: Task, c: RunContext) =>
      superviseLoop(actor, new Actor(1), t, c, {
        applyByScope: async (same) => same, branchOnEscalation: async () => {},
      }) }));
    const onAcceptance = vi.fn();
    const onTopology = vi.fn();
    await expect(runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 1 } }, createExecutor,
      restart: async () => { throw new Error('Worker is still running'); }, onTopology, onAcceptance,
    })).rejects.toThrow('Worker is still running');
    expect(createExecutor).toHaveBeenCalledTimes(1);
    expect(onTopology).toHaveBeenCalledTimes(1);
    expect(onAcceptance).not.toHaveBeenCalled();
  });
  it('rearms mechanical one-shots in a fresh attempt while sharing them across its branches', async () => {
    const ctx = context();
    const checkedAttempts: number[] = [];
    const gateTask = { description: 'running node test-api.js must exit 0' };
    await runDepthTask({ mode: 'short', task, ctx, floor: [], restart: async () => new Executor(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: (mode) => {
        const actor = new Actor(mode === 'short' ? 2 : 3);
        return { actor, handle: async (_task, current) => {
          const first = forkBranch(current, 'first');
          const sibling = forkBranch(current, 'sibling');
          expect(first.mechanicalPlanRejections!.has('spent-plan-coaching')).toBe(false);
          first.mechanicalPlanRejections!.add('spent-plan-coaching');
          expect(sibling.mechanicalPlanRejections!.has('spent-plan-coaching')).toBe(true);
          const env = buildResultGateEnv({ task: gateTask, result, ctx: first, childName: 'leaf', childToolNames: ['read_file'] });
          expect((await runResultGates(env, first.mechanicalResultRejections)).rejection?.gateId).toBe('required-command-manifest');
          const repeated = await runResultGates(env, sibling.mechanicalResultRejections);
          expect(repeated.rejection).toBeNull();
          expect(repeated.reviewFindings).toMatchObject([{ gateId: 'required-command-manifest' }]);
          checkedAttempts.push(current.attempt!);
          if (mode === 'short') current.beforeFallback!(actor);
          return actor.execute();
        } };
      },
    });
    expect(checkedAttempts).toEqual([1, 2]);
  });
  it('deepens when a mutualized peer reaches the entry fallback moment', async () => {
    const ctx = context();
    const peer = new Actor(2, true);
    const restart = vi.fn(async () => new Executor());
    const root = new Actor(2);
    const deep = new Actor(3);
    const final = await runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 1 } },
      restart, onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: (mode) => mode === 'short' ? {
        actor: root, handle: (t, c) => superviseLoop(peer, new Actor(1), t, c, {
          applyByScope: async (same) => same, branchOnEscalation: async () => {},
        }),
      } : { actor: deep, handle: () => deep.execute() },
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(peer.fallbackExecutions).toBe(0);
    expect(final.producedBy.tier).toBe(3);
  });

  it('does not deliver an acceptance that finishes after the run was cancelled', async () => {
    const ctx = context();
    const controller = new AbortController();
    const accepted = vi.fn();
    ctx.llm.enqueue(() => {
      controller.abort(new Error('Deadline passed'));
      return { text: jsonText({ approved: true, reasoning: 'Late verdict' }), stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const actor = new Actor(3);
    await expect(runDepthTask({ mode: 'deep', task, ctx: { ...ctx, signal: controller.signal }, floor,
      restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor, handle: () => actor.execute() }),
    })).rejects.toThrow('Deadline passed');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('exhausts the branch retry, cancels and drains siblings, then permits deep fallback and root rejection', async () => {
    const ctx = context();
    ctx.limits = { ...ctx.limits, maxPlanIterations: 1 };
    // TWO refusals since 2026-09-23: a refused delivery is handed back for one
    // more pass before the run ends (`MAX_ROOT_REMEDIATIONS`), and that budget
    // is per RUN, so a deepened run still gets exactly one.
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Missing final proof' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Still missing final proof' }));
    const short = new Actor(2, true);
    const deep = new Actor(3, true);
    const children: Actor[] = [];
    const order: string[] = [];
    const topologies: TopologyInfo[] = [];
    const acceptances: AcceptanceInfo[] = [];
    const stats = vi.fn();
    const restart = vi.fn(async () => { order.push('restart'); return new Executor(); });
    const originalTask: Task = { ...task, constraints: ['immutable original'] };
    const landedOut = await runDepthTask({ mode: 'short', task: originalTask, ctx: { ...ctx, recordRunStat: stats }, floor,
      restart, onTopology: (item) => topologies.push(item), onAcceptance: (item) => acceptances.push(item),
      createExecutor: (mode) => {
        const actor = mode === 'short' ? short : deep;
        return { actor, handle: async (receivedTask, current) => {
          // The deepened attempt runs the ORIGINAL task, and a remediation pass
          // keeps its description and constraints — only `inputs` gains the
          // acceptor's reasons, so planning and skill matching still key on the
          // same task.
          expect(receivedTask.description).toBe(originalTask.description);
          expect(receivedTask.constraints).toBe(originalTask.constraints);
          expect(current.deadlineAt).toBe(ctx.deadlineAt);
          const supervise = async () => {
            const child = new Actor(1);
            children.push(child);
            return superviseLoop(actor, child, receivedTask, forkBranch(current, 'failure'), {
              applyByScope: async (same) => same,
              branchOnEscalation: async () => { const branch = new Actor(1); children.push(branch); return branch; },
            });
          };
          if (mode === 'deep') return supervise();
          const plan = makePlan({ subtasks: [{ description: 'wait' }, { description: 'fail' }] });
          const siblings = await dispatchWithAggregation(plan.subtasks, plan, current, async (_sub, idx) => {
            if (idx === 1) return supervise();
            await observe(current);
            if (!current.signal.aborted) await new Promise<void>((resolve) => current.signal.addEventListener('abort', () => resolve(), { once: true }));
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            order.push('sibling-drained');
            current.signal.throwIfAborted();
            return result;
          });
          return siblings.results[0]!;
        } };
      },
    });
    // LANDS since 2026-09-24. What this test pins is unchanged: the branch
    // retry drains, the deepening happens exactly once, and the workspace is
    // restarted for it — only the shape of "the root said no" moved from a
    // throw to a returned, refused result.
    expect(landedOut.refusal).toBe('Still missing final proof');
    expect(short.fallbackExecutions).toBe(0);
    // Two, since 2026-09-23: the deepened attempt runs once, is refused, and
    // runs once more with the acceptor's reasons.
    expect(deep.fallbackExecutions).toBe(2);
    // Six, since 2026-09-23: the remediation pass supervises its own children.
    expect(children.filter((child) => child.plans === 1)).toHaveLength(6);
    expect(order).toEqual(['sibling-drained', 'restart']);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(topologies).toEqual([{ at: 'entry', mode: 'short', reason: 'arm', attempt: 1 },
      { at: 'deepening', mode: 'deep', reason: 'fallback-moment', attempt: 2 }]);
    expect(acceptances).toMatchObject([
      { attempt: 2, approved: false, executor: { tier: 3, viaFallback: true }, floorCoverage: [{ status: 'uncovered' }] },
      { attempt: 2, approved: false },
    ]);
    expect(stats.mock.calls.filter(([signal]) => signal === 'deepening')).toHaveLength(1);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(1);
    expect(ctx.llm.calls).toHaveLength(2);
  });
  it('carries a LANDED result through root acceptance, and tells the validator what a landing is', async () => {
    // Root acceptance reached project runs on 2026-09-23 (commit 2102979).
    // Landing on the budget shipped on 2026-09-22, and was never exercised
    // under depth routing, because depth routing was not running on the path
    // that lands. This test exists to put the two together.
    //
    // A landed result reaches the root with `unfinishedPhases` set and a
    // summary whose first word is INCOMPLETE. The profile floor is uncovered
    // (a landed run stopped before proving it), so `review` is true and an LLM
    // verdict decides.
    //
    // Until 2026-09-24 nothing in the payload said an incomplete result could
    // be legitimate, and the only statement the host made about incompleteness
    // was a rejection. `LANDED_RESULT_GUIDANCE` now travels with a landed
    // result and nowhere else; the ordinary-result half below is what proves
    // the "nowhere else".
    const ctx = context();
    const landed: Result = {
      ...result,
      summary: 'INCOMPLETE — the run deadline landed this plan with 1 phase(s) never run: write the README. Delivered so far: built the API',
      unfinishedPhases: ['write the README'],
    };
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'The phases that ran are honest' }));
    const accepted = vi.fn();
    const delivered = await runDepthTask({
      mode: 'short', task, ctx, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor: new Actor(), handle: async () => landed }),
    });
    // The landing survives the root: the typed field is what every reader
    // downstream uses to call the run `partial` rather than a delivery.
    expect(delivered.unfinishedPhases).toEqual(['write the README']);
    expect(accepted).toHaveBeenCalledTimes(1);
    // An uncovered floor forces the verdict call — a landed run stopped before
    // it could prove the floor, so this is its ordinary shape, not an edge.
    expect(accepted.mock.calls[0]![0].basis).toBe('validation-call');
    expect(accepted.mock.calls[0]![0].floorCoverage).toMatchObject([{ status: 'uncovered' }]);
    expect(ctx.llm.calls).toHaveLength(1);

    // THE GAP, stated as a comparison so it cannot be read as a preference.
    // Everything the validator learns about the landing comes from the
    // EXECUTOR'S OWN SUMMARY. Run the same acceptance over an ordinary result
    // and the concept vanishes entirely: the host never names it, so the
    // validator has no statement that an incomplete result can be legitimate,
    // and decides on model prose alone.
    const landedPrompt = JSON.stringify(ctx.llm.calls[0]).toLowerCase();
    expect(landedPrompt).toContain('incomplete');
    // Since 2026-09-24 the host NAMES the landing for the judge that decides
    // it. Before that, everything below was true and this line was not, which
    // is the whole finding: the validator ruled on model prose alone.
    expect(landedPrompt).toContain('this result landed on the run budget');
    expect(landedPrompt).toContain('reject it for being incomplete');

    const plain = context();
    plain.llm.enqueueText(jsonText({ approved: true, reasoning: 'fine' }));
    await runDepthTask({
      mode: 'short', task, ctx: plain, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => result }),
    });
    const plainPrompt = JSON.stringify(plain.llm.calls[0]).toLowerCase();
    for (const word of ['landed', 'unfinishedphases', 'deadline landed']) {
      expect(plainPrompt).not.toContain(word);
    }
    // And the ONE thing the validator is told about incompleteness points the
    // other way. The sentence is scoped to visual artefacts, so it does not
    // decide a landed run on its own — but it is the only statement on the
    // subject the host makes, and it is a rejection.
    expect(plainPrompt).toContain('a visually-incomplete artefact is a failed deliverable');
  });

  it('keeps BOTH reasons when a landed result is then refused', async () => {
    // This test was written on 2026-09-24 to pin the defect: a landed result
    // that the root refused left as a thrown error, the runner
    // recorded `failed`, and the phases that genuinely ran seeded nothing.
    // It now pins the fix, and the case it covers is the one the design nearly
    // missed — the two reasons COMPOSE, and a reader that reports only the
    // phases drops the half that says the work was judged.
    const ctx = context();
    const landed: Result = {
      ...result,
      summary: 'INCOMPLETE — the run deadline landed this plan with 1 phase(s) never run: write the README.',
      unfinishedPhases: ['write the README'],
    };
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'The README was never written' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Still no README' }));
    const out = await runDepthTask({
      mode: 'short', task, ctx, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => landed }),
    });
    expect(out.unfinishedPhases).toEqual(['write the README']);
    expect(out.refusal).toBe('Still no README');
    expect(landingReasons(out)).toEqual([
      'reached its budget with 1 phase(s) never run: write the README',
      'refused at delivery: Still no README',
    ]);
    expect(out.summary).toContain('REFUSED AT DELIVERY');
    expect(out.summary).toContain('INCOMPLETE');
  });

  it('hands a refusal back for ONE more pass, in the same attempt and workspace', async () => {
    // Measured 2026-09-23 on production runs 69f6f608 and 671da856: root
    // acceptance refused both, naming exactly which behaviours were never
    // probed, and the run ended there. One pass does not cover a goal naming
    // nine verifiable behaviours — the same goal, told to verify, came back
    // with FEWER gaps — so the refusal is handed back instead of ending it.
    const ctx = context();
    const restart = vi.fn();
    const stats = vi.fn();
    const seen: Task[] = [];
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'DELETE and restart persistence remain unverified' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Every named behaviour is now probed' }));
    const accepted = vi.fn();
    const delivered = await runDepthTask({
      mode: 'short', task, floor, restart, onTopology: vi.fn(), onAcceptance: accepted,
      ctx: { ...ctx, recordRunStat: stats },
      createExecutor: () => ({ actor: new Actor(), handle: async (t) => { seen.push(t); return result; } }),
    });
    expect(delivered).toBe(result);
    expect(seen).toHaveLength(2);
    // The refusal reaches the second pass as DATA, under inputs — the
    // description is what planning and skill matching key on and must not move.
    expect(seen[0]!.inputs?.['rootAcceptanceRefusal']).toBeUndefined();
    expect(seen[1]!.description).toBe(task.description);
    expect(seen[1]!.inputs).toMatchObject({
      rootAcceptanceRefusal: 'DELETE and restart persistence remain unverified',
      rootAcceptanceAttempt: 1,
    });
    // Same attempt, same workspace: the first pass's proof still stands, and
    // nothing is archived. Deepening is the mechanism that replaces a
    // workspace, and this is deliberately not it.
    expect(restart).not.toHaveBeenCalled();
    expect(accepted.mock.calls.map(([info]) => info.attempt)).toEqual([1, 1]);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(1);
  });

  it('refuses for good after the last remediation, without a third pass', async () => {
    const ctx = context();
    const stats = vi.fn();
    let passes = 0;
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'first refusal' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'second refusal' }));
    const out = await runDepthTask({
      mode: 'short', task, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      ctx: { ...ctx, recordRunStat: stats },
      createExecutor: () => ({ actor: new Actor(), handle: async () => { passes++; return result; } }),
    });
    // LANDS rather than throws since 2026-09-24: the work is real and is kept.
    expect(out.refusal).toBe('second refusal');
    expect(passes).toBe(1 + MAX_ROOT_REMEDIATIONS);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(MAX_ROOT_REMEDIATIONS);
  });

  it('spends no pass the wall clock cannot pay for', async () => {
    // Same floor landing already uses: opening work the deadline will truncate
    // buys nothing, and here it would also cost the refusal's own diagnosis.
    const ctx = context();
    const stats = vi.fn();
    let passes = 0;
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'unverified' }));
    const out = await runDepthTask({
      mode: 'short', task, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      ctx: { ...ctx, recordRunStat: stats, deadlineAt: Date.now() + 5_000 },
      createExecutor: () => ({ actor: new Actor(), handle: async () => { passes++; return result; } }),
    });
    expect(out.refusal).toBe('unverified');
    expect(passes).toBe(1);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(0);
  });

  it('arm A uses the same root rejection for an L3 fallback and never restarts', async () => {
    const ctx = context();
    const actor = new Actor(3, true);
    const restart = vi.fn();
    const accepted = vi.fn();
    // TWO refusals, since 2026-09-23: the first is handed back for one more
    // pass (`MAX_ROOT_REMEDIATIONS`), and the run ends on the second. What this
    // test pins is unchanged — an L3 fallback never restarts the workspace.
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Reject root' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Reject root again' }));
    const out = await runDepthTask({ mode: 'deep', task, ctx: { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 1 } }, floor,
      restart, onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor, handle: (t, c) => superviseLoop(actor, new Actor(2), t, c, {
        applyByScope: async (same) => same, branchOnEscalation: async () => {},
      }) }),
    });
    expect(out.refusal).toBe('Reject root again');
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ executor: { name: actor.name, tier: 3, viaFallback: true } }));
    expect(restart).not.toHaveBeenCalled();
  });
  it('does not restart for cancellation or an unrelated failure', async () => {
    const ctx = context();
    const restart = vi.fn();
    await expect(runDepthTask({ mode: 'short', task, ctx, floor, restart, onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => { throw new Error('transport failed'); } }),
    })).rejects.toThrow('transport failed');
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('deadline landing across dispatch and depth acceptance', () => {
  it.each(['sequential', 'concat'] as const)('retains accepted work after a real %s dispatch abort', async mode => {
    const ctx = context();
    const controller = new AbortController();
    const accepted = vi.fn();
    ctx.llm.enqueue({ text: jsonText({ approved: true, reasoning: 'Accepted completed work' }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    const plan = makePlan({ subtasks: [{ description: 'completed' }, { description: 'interrupted' }], aggregation: { mode } });
    const out = await runDepthTask({ mode: 'deep', task, floor, ctx: { ...ctx, signal: controller.signal },
      restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        const dispatch = await dispatchWithAggregation(plan.subtasks, plan, current, async (_subtask, idx) => {
          if (idx === 0) return result;
          await Promise.resolve();
          controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
          current.signal.throwIfAborted();
          return result;
        });
        return markLanded(dispatch.results[0]!, dispatch.unfinished);
      } }),
    });
    expect(controller.signal.aborted).toBe(true);
    expect(out.unfinishedPhases).toEqual(['interrupted']);
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.signal?.aborted).toBe(false);
  });
});

it('retains deadline work as refused partial if final acceptance itself expires', async () => {
  const ctx = context();
  const controller = new AbortController();
  const finalization = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(finalization.signal);
  ctx.llm.enqueue(() => {
    finalization.abort(new DOMException('Finalization deadline', 'TimeoutError'));
    return new Promise(() => {}); // The outer lifetime must not trust cooperation.
  });
  try {
    const out = await runDepthTask({ mode: 'short', task, floor,
      ctx: { ...ctx, signal: controller.signal }, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => {
        controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
        return markLanded(result, [{ description: 'unfinished' }]);
      } }),
    });
    expect(out.unfinishedPhases).toEqual(['unfinished']);
    expect(out.refusal).toContain('landing budget');
  } finally { timeout.mockRestore(); }
});

it('never converts an explicit cancellation into a deadline landing', async () => {
  const ctx = context();
  const controller = new AbortController();
  const accepted = vi.fn();
  await expect(runDepthTask({ mode: 'short', task, floor,
    ctx: { ...ctx, signal: controller.signal }, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
    createExecutor: () => ({ actor: new Actor(), handle: async () => {
      controller.abort(new Error('Cancelled by operator'));
      return markLanded(result, [{ description: 'unfinished' }]);
    } }),
  })).rejects.toThrow('Cancelled by operator');
  expect(accepted).not.toHaveBeenCalled();
});
