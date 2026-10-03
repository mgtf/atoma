import { outOfPhaseBudget } from '../core/limits.js';
import type { LlmCompletionResponse, Plan, Result, RunContext, Task } from '../core/types.js';
import { renderRestorationPrefix, restorationMatters } from '../contracts/readOnlyPhase.js';
import type { AttestationRecord } from '../contracts/attestation.js';
import { baseExecutorOf } from '../core/attestation.js';
import { abortedForLanding, landingSignal, withinSignal } from './cost.js';
import { previousResultInput } from './taskContext.js';

type Subtask = Plan['subtasks'][number];

/**
 * What a dispatch produced, and what it did not.
 *
 * `unfinished` is non-empty only when the RUN DEADLINE landed the dispatch:
 * the results are real, accepted work, and the named subtasks never produced
 * one. It exists because the alternative — returning a short array — is
 * indistinguishable from a complete dispatch of fewer phases, and the caller
 * would aggregate it into something that looks exactly like a delivery. A
 * landed dispatch must be able to say so; see `Result.unfinishedPhases`.
 */
export interface DispatchOutcome {
  readonly results: Result[];
  readonly unfinished: readonly Subtask[];
}

/**
 * SHARED DISPATCH SHAPE (structural: L2/L3 mirror helper).
 * ========================================================
 * The aggregation.mode → dispatch mapping was duplicated verbatim in
 * L2Atom and L3Atom (the files even said "mirror of" each other):
 *   - sequential  → one at a time, threading the previous step's summary
 *                   AND its declared `outputs` into the next subtask's
 *                   inputs (narrative + structured paths; the sandbox
 *                   filesystem still carries the bytes implicitly);
 *   - concat / llm-synthesize → parallel allSettled (orthogonal fan-out).
 * ONE implementation, parameterised by the per-subtask runner — the only
 * thing that genuinely differs between the tiers. Alias-map clearing and
 * child resolution stay with the callers: resolution runs in the
 * synchronous prefix of each runner, which is what keeps the parallel
 * branch race-free.
 *
 * LANDING ON THE RUN DEADLINE. Reaching the deadline used to discard every
 * completed phase: `out` lived on the stack and left with it. Measured twice
 * on production runs of 2026-09-21 (`cc894dad`, `d3098d25` —
 * docs/incidents/progressive-runs-2026-09-21.md), where three of four phases
 * were finished, validated and CREDITED before the fourth was aborted
 * mid-flight; 2.83 USD and 3.50 USD bought nothing, and a run that completed
 * three phases delivered exactly as much as one that completed none. Both
 * branches now land instead, by the two routes the deadline actually arrives
 * by:
 *   - sequential: refuse to OPEN a phase the remaining wall clock cannot pay
 *     for (`outOfPhaseBudget`), and keep the earlier phases when a phase that
 *     was opened is aborted mid-flight;
 *   - parallel: keep the branches that settled when the deadline cut their
 *     siblings.
 * A dispatch that completed NO phase never lands — it throws, as before. There
 * is nothing to deliver, and a landing that reported zero phases would be a
 * failure wearing a softer word.
 *
 * `ctx.signal` is the run's BUDGET signal and nothing else: the deadline, or a
 * platform token/spend ceiling (`abortedForLanding`, src/atoms/cost.ts).
 * Operator cancellation reaches a run as process teardown, not as an abort on
 * this signal (`runTask`). So `signal.aborted` unambiguously means "a budget
 * ran out", which is what makes the distinction below safe to draw.
 */
export async function dispatchWithAggregation(
  subtasks: readonly Subtask[],
  plan: Plan,
  ctx: RunContext,
  runOne: (subtask: Subtask, idx: number) => Promise<Result>
): Promise<DispatchOutcome> {
  if (plan.aggregation.mode === 'sequential') {
    const out: Result[] = [];
    let previousSummary: string | undefined;
    let previousResult: unknown;
    let previousOutputs: readonly string[] | undefined;
    for (let idx = 0; idx < subtasks.length; idx++) {
      // The floor is checked BEFORE the phase is built, and never on a
      // dispatch that has produced nothing yet: a run with no accepted phase
      // has nothing to land on, so it spends what it has left trying.
      if (out.length > 0 && outOfPhaseBudget(ctx.deadlineAt)) {
        ctx.logger.warn(
          `[dispatch] landing on ${out.length}/${subtasks.length} phase(s): too little run budget left to open the next one`
        );
        return { results: out, unfinished: subtasks.slice(idx) };
      }
      const baseSubtask = subtasks[idx]!;
      // Give the phase (and its result validator) the schedule it is spending
      // from. A validator can then consolidate recorded probes instead of
      // unknowingly consuming later phases, while contradictions still take
      // the normal validation path.
      const schedule = {
        phase: idx + 1,
        totalPhases: subtasks.length,
        remainingPhases: subtasks.slice(idx + 1).map((item) => item.description),
        recordedProbeCountFromCompletedPhases: out.reduce(
          (count, item) => count + (item.evidence?.length ?? 0),
          0
        ),
      };
      const subtask = {
        ...baseSubtask,
        inputs: {
          ...(baseSubtask.inputs ?? {}),
          atomaSequentialSchedule: schedule,
          ...(previousSummary !== undefined
            ? {
                previousStepSummary: previousSummary,
                previousStepResult: previousResult,
                previousStepIndex: idx - 1,
                ...(previousOutputs && previousOutputs.length > 0
                  ? { previousStepOutputs: previousOutputs }
                  : {}),
              }
            : {}),
        },
      };
      let r: Result;
      try {
        r = await runOne(subtask, idx);
      } catch (err) {
        // The deadline landing INSIDE a phase — the exact shape of both
        // 2026-09-21 runs. Everything already accepted still lands; anything
        // else rethrows unchanged, including a deadline that arrived before
        // the first phase closed.
        if (out.length > 0 && ctx.signal.aborted) {
          ctx.logger.warn(
            `[dispatch] landing on ${out.length}/${subtasks.length} phase(s): the run budget (deadline or ceiling) aborted phase #${idx + 1}`
          );
          return { results: out, unfinished: subtasks.slice(idx) };
        }
        throw err;
      }
      out.push(r);
      previousSummary = r.summary;
      previousResult = previousResultInput(r.output);
      // Declared writes of THIS phase become the next phase's structured
      // handover. Do not merge them into the next subtask's `outputs`:
      // that field is what THIS phase creates, and skill/promotion gates
      // must keep reading the current phase only.
      previousOutputs = baseSubtask.outputs;
    }
    return { results: out, unfinished: [] };
  }
  const pending = subtasks.map((subtask, idx) => runOne(subtask, idx));
  // `allSettled` unconditionally, where it used to be reserved for depth
  // transitions (which archive the workspace and so need every sibling
  // settled first). Partial landing needs the same guarantee for the same
  // reason — you cannot keep the branches that succeeded without waiting to
  // learn which those are — and a fail-fast `Promise.all` left its siblings
  // running unobserved anyway. The cost is that a genuine error surfaces once
  // its siblings have settled rather than immediately.
  const settled = await Promise.allSettled(pending);
  const fulfilled: Result[] = [];
  const unfinished: Subtask[] = [];
  let failure: unknown;
  let failed = false;
  for (let idx = 0; idx < settled.length; idx++) {
    const item = settled[idx]!;
    if (item.status === 'fulfilled') {
      fulfilled.push(item.value);
      continue;
    }
    unfinished.push(subtasks[idx]!);
    if (!failed) {
      failed = true;
      failure = item.reason;
    }
  }
  if (!failed) return { results: fulfilled, unfinished: [] };
  // A rejection that is NOT the deadline is a real failure and keeps its
  // original meaning, whatever else settled. Only the deadline lands.
  if (!ctx.signal.aborted || fulfilled.length === 0) throw failure;
  ctx.logger.warn(
    `[dispatch] landing on ${fulfilled.length}/${subtasks.length} branch(es): the run budget (deadline or ceiling) cut the rest`
  );
  return { results: fulfilled, unfinished };
}

/**
 * One execution of a READ-ONLY phase (`Task.readOnly`), between a photograph
 * of the workspace and its restoration (`src/contracts/readOnlyPhase.ts`):
 * whatever it changed is put back before anything validates it, and its
 * result says what was put back. On a throw the workspace is restored too,
 * and the error goes on unchanged. A task not marked read-only, or a context
 * without the host capability, runs untouched.
 *
 * Called where a read-only phase STARTS — the tissue's phase dispatch, or a
 * root cell's own — around every path that executes it (`aroundExecute`, and
 * a cell's deterministic script dispatch), never again below it.
 *
 * What the execution recorded rides the restoration: its attestations, and
 * the paths its own element writes named. When the phase changed files ITSELF
 * (`restorationDamaged`) root acceptance counts none of those attestations,
 * and the Node servers it started are stopped: one it restarted on code the
 * restore put back would go on answering from the undone version (second
 * adversarial review, 2026-09-30). Dispatch is sequential here — parallel
 * plans are never marked — so what the attempt's log gained meanwhile is this
 * execution's.
 */
export async function withinReadOnlyPhase<R extends Result | null>(
  ctx: RunContext,
  task: Task,
  execute: () => Promise<R>,
  options: { readonly script?: true } = {}
): Promise<R> {
  const phases = task.readOnly ? ctx.readOnlyPhases : undefined;
  if (!phases) return execute();
  const attempt = ctx.attempt ?? 1;
  const recordedBefore = ctx.attestations?.forAttempt(attempt).length ?? 0;
  const recorded = (): readonly AttestationRecord[] => (ctx.attestations?.forAttempt(attempt) ?? []).slice(recordedBefore);
  const end = async () => {
    const records = recorded();
    const restoration = guard.end({
      observations: records.map((record) => record.eventId),
      writes: requestedPaths(records, ['write_file', 'edit_file'], 'path'),
      serverEntries: requestedPaths(records, ['start_node_server'], 'entry'),
      commands: records.flatMap((record) =>
        (record.tool === 'run_shell' || record.tool === 'record_probe') && record.observation.kind === 'execution'
          ? [record.observation.request] : []),
      ...(options.script ? { ownsEveryChange: true as const } : {}),
    });
    // What the disk went back to, no process it started may keep answering
    // for: a server restarted on code the restore put back answered from the
    // undone version (second review).
    if (restoration.paths.some((path) => path.restored)) await stopServersStarted(ctx, records);
    return restoration;
  };
  const guard = phases.begin(task.description, attempt);
  let result: R;
  try {
    result = await execute();
  } catch (error) {
    await end();
    throw error;
  }
  const restoration = await end();
  if (result === null || !restorationMatters(restoration)) return result;
  return {
    ...result,
    summary: `${renderRestorationPrefix(restoration)} ${result.summary}`,
    readOnlyRestoration: { restoration, summary: result.summary },
  };
}

/** The value one attested tool call's JSON excerpt holds at `key`, when it parses. */
function excerptField(excerpt: string, key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(excerpt);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/** The path argument (`key`) each of an execution's calls to `tools` named. */
function requestedPaths(records: readonly AttestationRecord[], tools: readonly string[], key: string): string[] {
  return records.flatMap((record) => {
    if (!tools.includes(record.tool) || record.observation.kind !== 'execution') return [];
    const path = excerptField(record.observation.request, key);
    return typeof path === 'string' ? [path] : [];
  });
}

/**
 * Stop the Node servers an execution started (`start_node_server` reports
 * its pid and spawns it as a group leader), through the tools' own shell and
 * a fixed command: the process lives where the tools do, in the container
 * when there is one. Its group first, so what it spawned stops with it.
 */
async function stopServersStarted(ctx: RunContext, records: readonly AttestationRecord[]): Promise<void> {
  const pids = records.flatMap((record) => {
    if (record.tool !== 'start_node_server' || record.observation.kind !== 'execution') return [];
    const pid = excerptField(record.observation.response, 'pid');
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? [String(pid)] : [];
  });
  if (pids.length === 0) return;
  if (!ctx.tools?.has('run_shell')) {
    ctx.logger.warn(`[read-only phase] cannot stop the server(s) the restored execution started (pid ${pids.join(', ')}): no shell`);
    return;
  }
  try {
    await baseExecutorOf(ctx.tools).execute('run_shell', {
      command: 'node',
      args: ['-e', 'for (const pid of process.argv.slice(1)) { try { process.kill(-Number(pid), "SIGTERM"); } catch { try { process.kill(Number(pid), "SIGTERM"); } catch {} } }', ...pids],
    });
    ctx.logger.warn(`[read-only phase] stopped ${pids.length} server(s) the restored execution started: pid ${pids.join(', ')}`);
  } catch (error) {
    ctx.logger.warn(`[read-only phase] could not stop the servers the restored execution started: ${String(error)}`);
  }
}

/**
 * Stamp a landed dispatch's aggregate so no reader downstream can mistake it
 * for a complete one. Phases that did not complete with an accepted result
 * are named, and the summary says
 * INCOMPLETE in its first word — the validators, the trace and the operator
 * all read that string, and the previous behaviour's whole defect was that
 * nothing distinguished "three phases of four" from "four of four".
 *
 * A complete dispatch passes through untouched, so call sites need no branch.
 */
export function markLanded(result: Result, unfinished: readonly Subtask[]): Result {
  if (unfinished.length === 0) return result;
  const phases = unfinished.map((subtask) => subtask.description);
  return {
    ...result,
    summary:
      `INCOMPLETE — the run deadline landed this plan with ${phases.length} unfinished phase(s) that did not complete with an accepted result: ` +
      `${phases.join(' | ')}. Delivered so far: ${result.summary}`,
    // Union with what came from below: an L2 that landed inside one L3 phase
    // makes the whole run partial, and its unfinished phases must survive the
    // aggregate that wraps it.
    unfinishedPhases: [...(result.unfinishedPhases ?? []), ...phases],
  };
}

/**
 * `llm-synthesize` over sub-results that ALREADY EXIST is finalization, not
 * execution (2026-09-25 review, 1.2c). The L1 molecules wrote the files; the
 * synthesis is one text call that merges what they reported. Losing it must
 * not lose them: until 2026-09-26 a synthesis the run deadline cut over
 * complete sub-results rejected `execute`, and a landed one that failed had no
 * fallback — either way the run recorded `failed` and seeded nothing.
 *
 * Returns the response, or why the caller must KEEP the sub-results without
 * synthesis (`keptWithoutSynthesis`): the call failed or ran out of window
 * while landing, or the run deadline fell during it. Explicit cancellation
 * and deepening are interruptions and rethrow; any other error before the
 * deadline is an error. Bounded by `withinSignal` because a transport may
 * ignore abort.
 */
export async function synthesizeOrKeep(
  ctx: RunContext,
  landed: boolean,
  call: (signal: AbortSignal) => Promise<LlmCompletionResponse>
): Promise<{ readonly response: LlmCompletionResponse } | { readonly keptBecause: string }> {
  const signal = landed ? landingSignal(ctx.deadlineAt) : ctx.signal;
  try {
    return { response: await withinSignal(call(signal), signal) };
  } catch (error) {
    if (ctx.signal.aborted && !abortedForLanding(ctx)) throw error;
    if (!landed && !abortedForLanding(ctx)) throw error;
    // Say what actually happened: a landing synthesis may also fail outright.
    const keptBecause = !landed ? 'the run deadline fell during it'
      : signal.aborted ? 'its landing window closed'
      : `it failed while landing: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
    ctx.logger.warn(`[synthesis] not completed (${keptBecause}); keeping the sub-results as they are`);
    return { keptBecause };
  }
}

/**
 * The sub-results as they are, when their synthesis could not finish. LANDED:
 * the missing synthesis is named as an unfinished step, so the run is judged
 * as a partial and its work seeds the next run instead of being claimed.
 */
export function keptWithoutSynthesis(
  subResults: readonly Result[],
  producedBy: Result['producedBy'],
  why: string
): Result {
  const evidence = subResults.flatMap((result) => result.evidence ?? []);
  return {
    output: subResults.map((result) => result.output),
    summary: `${subResults.length} sub-results kept without synthesis (${why}): ${subResults
      .map((result, i) => `#${i + 1} ${result.summary}`).join(' | ')}`,
    trace: [],
    producedBy,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(subResults.some((result) => result.proofCoverage?.length)
      ? { proofCoverage: subResults.flatMap((result) => result.proofCoverage ?? []) }
      : {}),
    unfinishedPhases: [
      ...subResults.flatMap((result) => result.unfinishedPhases ?? []),
      `synthesis of ${subResults.length} sub-results (${why})`,
    ],
  };
}
