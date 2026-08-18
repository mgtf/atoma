import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AtomType } from '../registry/atomRegistry.js';
import type { Task, Tier } from '../core/types.js';

/**
 * Minimal structured event log for the web visualizer. One run corresponds to
 * a single `L3Atom.handle(task, ctx)` call; during that run we collect every
 * LLM request (with prompts + response) and every registry mutation. At the
 * end we dump the run as JSON so `viz/server.ts` can serve it.
 */

export interface VizAtomRef {
  tier?: Tier;
  name?: string;
}

export interface VizLlmEvent {
  id: string;
  ts: number;
  kind: 'llm';
  /** Coarse role inferred from the request prompts — drives the UI icon. */
  role:
    | 'plan'
    | 'execute'
    | 'validate-plan'
    | 'validate-result'
    | 'prefilter'
    | 'skill'
    | 'fallback-plan'
    | 'fallback-execute'
    | 'unknown';
  model: string;
  /**
   * The model the transport ACTUALLY invoked when it differs from the pin
   * (`model` above stays the routing identity — `codex:claude-opus-5` —
   * while a transport may serve `gpt-5.6-sol`). Optional and additive:
   * events recorded before 2026-08-15, and events from transports that
   * serve the pin verbatim, simply lack it. `costUsd` is priced on this
   * when present (review 2026-08-14 §1.13).
   */
  servedModel?: string;
  actor?: VizAtomRef;
  child?: VizAtomRef;
  subject?: 'PLAN' | 'RESULT';
  systemPrompt: string;
  userContent: string;
  response: string;
  stopReason: string | null;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  costUsd: number;
  error?: string;
  /**
   * Optional identifier of the fan-out branch this event belongs to.
   * When a supervisor dispatches N subtasks in parallel, each subtask
   * runs under its own `branchId`, letting the viz group events by
   * lane so parallel chains don't collapse into one confused timeline.
   * Absent (undefined) for events outside any fan-out context (e.g. the
   * supervisor's own plan/aggregation calls at the trunk level).
   */
  branchId?: string;
}

export interface VizRegistrySnapshot {
  tier: Tier;
  ordinal: number;
  name: string;
  description: string;
  systemPrompt: string;
  params: Record<string, unknown>;
  /** Tool names attached to the type (kept compact for JSON size). */
  tools: string[];
  version: number;
  successes: number;
  failures: number;
  createdBy: string;
  createdAt: string;
}

export interface VizRegistryEvent {
  id: string;
  ts: number;
  kind: 'registry';
  op: 'create' | 'patch' | 'branch' | 'recordSuccess' | 'recordFailure';
  tier?: Tier;
  name: string;
  /** Initiator of the mutation/counter decision, when known. */
  actor?: VizAtomRef;
  /** Agent type created, patched, branched or credited/blamed. */
  child?: VizAtomRef;
  by?: string;
  from?: string;
  version?: number;
  reason?: string;
  modifications?: unknown;
  snapshot?: VizRegistrySnapshot;
}

/**
 * One tool invocation inside an L1 execute loop. Emitted by the Anthropic
 * client via the `onToolInvocation` observer and recorded verbatim so
 * post-mortem analyses can see, for every tool call:
 *   - the exact `args` the model sent (not just that a call happened),
 *   - the `result` the tool returned (or the `error`),
 *   - which LLM event triggered the loop, via `llmEventId`.
 * Without this, we could only see "validate_html was called" in the
 * terminal log — not whether the smoke/interactions were task-appropriate.
 */
export interface VizToolEvent {
  id: string;
  ts: number;
  kind: 'tool';
  /** The LLM event id whose tool-use loop produced this call. */
  llmEventId: string;
  /** Name of the atom that "owns" the LLM call triggering this tool. */
  actor?: VizAtomRef;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
  /** See VizLlmEvent.branchId — fan-out lane identifier. */
  branchId?: string;
}

/**
 * Trust fast-path decision recorded by the supervise loop. These are
 * synthetic approvals emitted by `trustedApproval` when a child type has
 * enough clean successes to skip validator LLM calls. They carry no cost
 * and no prompt, but are real supervision events — the UI shows them so
 * users can see why an "empty lane" (zero L2 LLM calls on a trusted
 * pipeline) is actually the correct behaviour.
 */
export interface VizTrustEvent {
  id: string;
  ts: number;
  kind: 'trust';
  actor?: VizAtomRef;
  child?: VizAtomRef;
  subject: 'PLAN' | 'RESULT';
  successes: number;
  failures: number;
  reasoning: string;
  /** See VizLlmEvent.branchId — fan-out lane identifier. */
  branchId?: string;
}

/**
 * Skill-pipeline event recorded during a run: match, body injection,
 * trust counter bump, auto-creation, post-failure update. Skills run
 * orthogonally to the atom-type registry (different on-disk store,
 * different counters), so they get their own VizEvent variant rather
 * than reusing VizRegistryEvent — viz consumers can render them in a
 * dedicated lane without conflating with atom_types mutations.
 *
 * `op` semantics:
 *   - 'match'    Haiku skill-prefilter picked this skill for the
 *                current subtask. Carries `reasoning`.
 *   - 'inject'   The skill body was injected into the L1's effective
 *                system prompt via injectContext. Always follows a
 *                'match' (paired event for symmetry).
 *   - 'learn'    Sonnet auto-distilled a NEW skill from a successful
 *                novel-task run (#C3). Carries `reasoning` describing
 *                the body summary.
 *   - 'update'   Sonnet revised an EXISTING skill's body after a
 *                supervise-loop escalation (#C2b). Carries the
 *                validator diagnosis as `reasoning`.
 *   - 'success'  / 'failure'  Trust counter bumped. Mirrors the
 *                onApproved / onFailed hook outcomes.
 *   - 'direct'   Trusted `kind: 'script'` skill executed via the
 *                DETERMINISTIC dispatch fast-path (write_file +
 *                run_shell, zero LLM calls — no L1 plan/execute, no
 *                validators). Carries the run outcome as `reasoning`.
 *   - 'quarantine'      The static scan flagged a matched `kind: script`
 *                body, so it was neither dispatched NOR injected and the
 *                run proceeded skill-less. `reasoning` carries the flags.
 *                Without this event the block is invisible: the run
 *                simply looks like nothing matched.
 *   - 'credit-withheld' The adherence gate refused to move this skill's
 *                counters because the validator observed the run did not
 *                follow the recipe. `reasoning` says which direction was
 *                withheld (credit on success, blame on failure) — the
 *                only visible trace otherwise is a counter that did not
 *                move, which reads identically to "nothing happened".
 */
export interface VizSkillEvent {
  id: string;
  ts: number;
  kind: 'skill';
  op:
    | 'match'
    | 'inject'
    | 'learn'
    | 'update'
    | 'success'
    | 'failure'
    | 'promote'
    | 'demote'
    | 'direct'
    | 'quarantine'
    | 'credit-withheld';
  /** Display name of the molecule that owns the skill. */
  l1Name: string;
  /** Stored namespace key (atom id) — what `/api/skills/:l1Name` expects. */
  l1AtomId: string;
  /** Stable kebab-case skill id within that namespace. */
  skillId: string;
  /** Atom that triggered the event (usually the supervising L2). */
  actor?: VizAtomRef;
  /** Free-form text — match reasoning, validator diagnosis, body excerpt. */
  reasoning?: string;
  /** Fan-out lane id (echo from the supervisor's branchCtx). */
  branchId?: string;
}

/**
 * Emitted the moment an LLM call LEAVES the process, before any response
 * exists — the completion event (kind 'llm', same id in `llmEventId`)
 * supersedes it. Purpose: the polling UI can show what a live run is doing
 * RIGHT NOW (in-flight call + ticking elapsed) instead of only completed
 * steps, and an ended run with an unpaired start renders as "interrupted" —
 * the exact signature of a network blip killing a claude-cli subprocess
 * mid-call (observed live: a run went silent for 10 minutes with zero
 * events while its README-phase call hung; the viz showed nothing amiss).
 * Deliberately tiny — no prompts, no usage; the completion carries those.
 */
export interface VizLlmStartEvent {
  id: string;
  ts: number;
  kind: 'llm-start';
  /** Pre-allocated id of the completion event this start will pair with. */
  llmEventId: string;
  model: string;
  role: VizLlmEvent['role'];
  actor?: VizLlmEvent['actor'];
  child?: VizLlmEvent['child'];
  subject?: VizLlmEvent['subject'];
  branchId?: string;
}

/**
 * A prefilter routing decision replayed from the on-disk decision cache
 * instead of being asked of the model. Its whole point is to be VISIBLE:
 * the call it replaces leaves no llm event, so without this the timeline
 * shows a gap and the run looks cheaper for no stated reason. Sibling of
 * VizTrustEvent — both record "a decision taken without an LLM call".
 */
export interface VizCacheEvent {
  id: string;
  ts: number;
  kind: 'cache';
  /** 'reuse <target>' | 'escalate' — the replayed decision. */
  outcome: string;
  reasoning: string;
  /** Model the ORIGINAL decision used — i.e. the call that did not happen. */
  model: string;
  actor?: VizAtomRef;
  branchId?: string;
}

export interface VizBranchEvent {
  id: string;
  ts: number;
  kind: 'branch';
  op: 'start' | 'end';
  branchId: string;
  parentBranchId?: string;
  index: number;
  total: number;
  aggregationMode: import('../core/types.js').AggregationSpec['mode'];
  label: string;
  actor: VizAtomRef;
}

export type VizEvent =
  | VizLlmEvent
  | VizLlmStartEvent
  | VizRegistryEvent
  | VizToolEvent
  | VizTrustEvent
  | VizSkillEvent
  | VizCacheEvent
  | VizBranchEvent;

export interface VizRunIndexEntry {
  id: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  hasError: boolean;
  /**
   * True when the run technically produced a result but through the
   * parent's fallback path (supervise loop escalated, supervisor took over
   * and produced content itself). Such runs are NOT true successes — the
   * child atom couldn't satisfy the protocol and the deliverable may be a
   * degraded "here's how you would do it" text instead of the real artefact.
   * `hasError` stays false for these; `degraded` is the finer signal the UI
   * and stats should use to distinguish them from full successes.
   */
  degraded?: boolean;
  /**
   * True when the run is STILL EXECUTING — partial-persist snapshots carry
   * this flag so the viz UI can render a "● LIVE" indicator and start
   * polling for updates. The final `endRun()` persist clears the flag
   * (the presence of `endedAt` is also a signal, but inFlight is the
   * explicit one the UI reads).
   */
  inFlight?: boolean;
  /**
   * Timestamp (ms) of the LAST recorded event, on in-flight entries only.
   *
   * `inFlight` alone cannot distinguish "running right now" from "died
   * without its closing stamp" — a hard kill (uncatchable SIGKILL, a crash)
   * leaves the trace with no `endedAt` FOREVER, and the run list, which
   * holds no events, had no way to tell. Measured on the run of
   * 2026-08-08T18:32: silent for 11 hours and still flagged LIVE in the
   * sidebar, which also kept `anyInflight` true so the index re-polled
   * endlessly. Entries written before this field existed fall back to
   * `startedAt`, which is the same fallback `isAbandoned` already uses for
   * an event-less run.
   */
  lastEventAt?: number;
  /**
   * True when the run was terminated by an explicit user signal (Ctrl-C
   * → SIGINT, or programmatic cancellation) BEFORE the L3 produced a
   * result. Set by `endRun({ cancelled: true })`. Distinguishes a
   * deliberate user-initiated stop from a true `hasError` (system
   * fault, timeout, internal exception) so the UI can label runs
   * "✕ cancelled" instead of "● LIVE" once the user has killed them.
   */
  cancelled?: boolean;
  costUsd?: number;
  calls?: number;
}

export interface VizRunTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  perModel: Array<{
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export interface VizRun {
  id: string;
  label: string;
  task: Task;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /**
   * Snapshot of the atom registry at run start — captures pre-existing L1/L2/L3
   * types that may be reused without a `patch`/`branch`/`create` event, so the
   * UI can still display their prompt + metadata.
   */
  initialTypes?: VizRegistrySnapshot[];
  events: VizEvent[];
  result?: {
    summary: string;
    output: unknown;
    producedBy: { tier: Tier; name: string; viaFallback: boolean };
  };
  /**
   * Mirrors `VizRunIndexEntry.degraded`. Computed from
   * `result.producedBy.viaFallback` at persist time so consumers of the
   * full run JSON can surface it without re-walking the events.
   */
  degraded?: boolean;
  /** Mirrors `VizRunIndexEntry.cancelled`. Set by `endRun({ cancelled: true })`. */
  cancelled?: boolean;
  error?: string;
  totals?: VizRunTotals;
}

/**
 * A run's display NAME, derived from its goal.
 *
 * The goal itself always travels whole on `VizRun.task.description`; this is
 * the short form for lists, headers and the picker. It exists as one exported
 * function because a bare `goal.slice(0, n)` ends mid-word and reads as a
 * complete goal — a real trace carried `"…tiles that swap colour w"`, and
 * every surface repeated the lie (2026-08-15).
 */
export function runLabelFromGoal(goal: string, max: number): string {
  return goal.length > max ? `${goal.slice(0, max)}…` : goal;
}

export class TraceRecorder {
  private run: VizRun | null = null;
  readonly runsDir: string;
  /**
   * Trailing-edge throttle for partial persists. Every `record()` call
   * schedules a flush after PERSIST_THROTTLE_MS unless one is already
   * pending. Keeps disk writes bounded when a run fires events faster
   * than the filesystem can accept them, while still giving the live
   * viz polling (1s cadence) plenty of fresh data to render. Cleared
   * by `endRun` so the final synchronous flush wins the race.
   */
  private persistTimer: NodeJS.Timeout | null = null;
  private static readonly PERSIST_THROTTLE_MS = 300;

  constructor(runsDir: string = './runs') {
    this.runsDir = resolve(runsDir);
  }

  beginRun(
    task: Task,
    label?: string,
    opts?: { initialTypes?: readonly AtomType[] }
  ): VizRun {
    const id = `${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('Z', '')}-${randomUUID().slice(0, 8)}`;
    this.run = {
      id,
      label: label ?? runLabelFromGoal(task.description, 140),
      task,
      startedAt: new Date().toISOString(),
      events: [],
    };
    if (opts?.initialTypes && opts.initialTypes.length > 0) {
      this.run.initialTypes = opts.initialTypes.map(snapshotType);
    }
    return this.run;
  }

  get currentRun(): VizRun | null {
    return this.run;
  }

  record(event: VizEvent): void {
    if (!this.run) return;
    this.run.events.push(event);
    this.schedulePartialPersist();
  }

  /**
   * Trailing-edge throttled partial persist. Enables live tailing from
   * the viz UI: while a run is in flight, every ~300ms the latest
   * event list (+ computed totals) is flushed to disk, so the UI
   * polling on `/api/runs/:id` sees incremental progress instead of
   * having to wait for endRun.
   */
  private schedulePartialPersist(): void {
    if (!this.run) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPartial();
    }, TraceRecorder.PERSIST_THROTTLE_MS);
    // Let the event loop exit even if the timer is still pending
    // (the synchronous endRun.persist() path supersedes it anyway).
    if (typeof (this.persistTimer as { unref?: () => void }).unref === 'function') {
      (this.persistTimer as { unref?: () => void }).unref?.();
    }
  }

  endRun(opts: {
    result?: VizRun['result'];
    error?: string;
    /**
     * Caller asserts the run was cancelled by an explicit user signal
     * (Ctrl-C / SIGINT / programmatic stop) — used by build-app.ts's
     * shutdown handler to distinguish "user pressed Ctrl-C mid-run"
     * from "system failure" so the viz can label it accordingly.
     */
    cancelled?: boolean;
  } = {}): VizRun | null {
    if (!this.run) return null;
    // Cancel any pending trailing-edge partial persist so it can't race
    // with (and overwrite) the final synchronous persist below.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const endedAt = new Date().toISOString();
    this.run.endedAt = endedAt;
    this.run.durationMs = Date.parse(endedAt) - Date.parse(this.run.startedAt);
    if (opts.result) this.run.result = opts.result;
    if (opts.error) this.run.error = opts.error;
    if (opts.cancelled) this.run.cancelled = true;
    this.run.totals = computeTotals(this.run.events);
    // A run is "degraded" when the supervise loop escalated and the parent
    // took over via its fallback path. `result.producedBy.viaFallback` is
    // the single source of truth — set by `superviseLoop` when it enters
    // the escalation branch.
    if (this.run.result?.producedBy?.viaFallback === true) {
      this.run.degraded = true;
    }
    this.persist();
    const run = this.run;
    this.run = null;
    return run;
  }

  /** Fire-and-forget safety flush in case the process dies mid-run. */
  flushPartial(): void {
    if (!this.run) return;
    this.run.totals = computeTotals(this.run.events);
    this.persist();
  }

  /**
   * Convenience wrapper so call sites can build the full event from the
   * lighter `TrustFastPathInfo` shape they already have. Keeps the event
   * id generation and timestamp centralised here.
   */
  recordTrust(info: import('../core/types.js').TrustFastPathInfo): void {
    const ev: VizTrustEvent = {
      id: randomUUID(),
      ts: Date.now(),
      kind: 'trust',
      actor: { name: info.supervisorName, tier: info.supervisorTier },
      child: { name: info.childName, tier: info.childTier },
      subject: info.subject,
      successes: info.successes,
      failures: info.failures,
      reasoning: info.reasoning,
      ...(info.branchId !== undefined ? { branchId: info.branchId } : {}),
    };
    this.record(ev);
  }

  /**
   * Convenience wrapper for skill-pipeline events. Mirrors `recordTrust` —
   * call sites in L2Atom emit a typed `SkillEventInfo`, the recorder
   * stamps id+ts and persists the full `VizSkillEvent`.
   */
  recordSkillEvent(info: import('../core/types.js').SkillEventInfo): void {
    const ev: VizSkillEvent = {
      id: randomUUID(),
      ts: Date.now(),
      kind: 'skill',
      op: info.op,
      l1Name: info.l1Name,
      l1AtomId: info.l1AtomId,
      skillId: info.skillId,
      actor: { name: info.actorName, tier: info.actorTier },
      ...(info.reasoning !== undefined ? { reasoning: info.reasoning } : {}),
      ...(info.branchId !== undefined ? { branchId: info.branchId } : {}),
    };
    this.record(ev);
  }

  /**
   * Prefilter decision served from cache — the LLM call that did NOT
   * happen. Same wrapper pattern as recordTrust / recordSkillEvent.
   */
  recordCacheHit(info: import('../core/types.js').CacheHitInfo): void {
    const ev: VizCacheEvent = {
      id: randomUUID(),
      ts: Date.now(),
      kind: 'cache',
      outcome: info.outcome,
      reasoning: info.reasoning,
      model: info.model,
      ...(info.actorName && info.actorTier
        ? { actor: { name: info.actorName, tier: info.actorTier } }
        : {}),
      ...(info.branchId !== undefined ? { branchId: info.branchId } : {}),
    };
    this.record(ev);
  }

  recordBranch(info: import('../core/types.js').BranchEventInfo): void {
    const ev: VizBranchEvent = {
      id: randomUUID(),
      ts: Date.now(),
      kind: 'branch',
      op: info.op,
      branchId: info.branchId,
      ...(info.parentBranchId !== undefined
        ? { parentBranchId: info.parentBranchId }
        : {}),
      index: info.index,
      total: info.total,
      aggregationMode: info.aggregationMode,
      label: info.label,
      actor: { name: info.actorName, tier: info.actorTier },
    };
    this.record(ev);
  }

  private persist(): void {
    if (!this.run) return;
    if (!existsSync(this.runsDir)) mkdirSync(this.runsDir, { recursive: true });
    const file = join(this.runsDir, `${this.run.id}.json`);
    // Atomic-ish persist (#10): a crash mid-write used to leave a TORN
    // JSON on disk, which the viz index skips forever — the run becomes a
    // phantom (cost paid, no trace). Write to a temp sibling then rename;
    // rename is atomic on the same filesystem.
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.run, null, 2));
    renameSync(tmp, file);

    const indexFile = join(this.runsDir, 'index.json');
    let index: VizRunIndexEntry[] = [];
    if (existsSync(indexFile)) {
      try {
        index = JSON.parse(readFileSync(indexFile, 'utf8')) as VizRunIndexEntry[];
      } catch {
        index = [];
      }
    }
    index = index.filter((r) => r.id !== this.run!.id);
    const entry: VizRunIndexEntry = {
      id: this.run.id,
      label: this.run.label,
      startedAt: this.run.startedAt,
      hasError: !!this.run.error,
    };
    if (this.run.endedAt !== undefined) entry.endedAt = this.run.endedAt;
    if (this.run.durationMs !== undefined) entry.durationMs = this.run.durationMs;
    if (this.run.degraded) entry.degraded = true;
    if (this.run.cancelled) entry.cancelled = true;
    // Inflight flag: partial persists during the run carry it; the
    // final endRun persist (which sets endedAt) clears it. `lastEventAt`
    // rides along so a consumer holding only the index can tell a live run
    // from one that died without its closing stamp.
    if (this.run.endedAt === undefined) {
      entry.inFlight = true;
      let last = 0;
      for (const e of this.run.events) if (typeof e.ts === 'number' && e.ts > last) last = e.ts;
      if (last > 0) entry.lastEventAt = last;
    }
    if (this.run.totals) {
      entry.costUsd = this.run.totals.costUsd;
      entry.calls = this.run.totals.calls;
    }
    index.unshift(entry);
    writeFileSync(indexFile, JSON.stringify(index, null, 2));
  }
}

function computeTotals(events: readonly VizEvent[]): VizRunTotals {
  const totals: VizRunTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    perModel: [],
  };
  const byModel = new Map<
    string,
    { model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
  >();
  for (const e of events) {
    if (e.kind !== 'llm') continue;
    totals.calls++;
    totals.inputTokens += e.usage.inputTokens;
    totals.outputTokens += e.usage.outputTokens;
    totals.cacheReadInputTokens += e.usage.cacheReadInputTokens;
    totals.cacheCreationInputTokens += e.usage.cacheCreationInputTokens;
    totals.costUsd += e.costUsd;
    const prev = byModel.get(e.model) ?? {
      model: e.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    byModel.set(e.model, {
      model: e.model,
      calls: prev.calls + 1,
      inputTokens: prev.inputTokens + e.usage.inputTokens,
      outputTokens: prev.outputTokens + e.usage.outputTokens,
      costUsd: prev.costUsd + e.costUsd,
    });
  }
  totals.perModel = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  return totals;
}

export function snapshotType(t: AtomType): VizRegistrySnapshot {
  return {
    tier: t.tier,
    ordinal: t.ordinal,
    name: t.name,
    description: t.description,
    systemPrompt: t.systemPrompt,
    params: t.params as Record<string, unknown>,
    tools: t.tools.map((tool) => tool.name),
    version: t.version,
    successes: t.successes,
    failures: t.failures,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
  };
}
