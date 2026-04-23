import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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
    | 'fallback-plan'
    | 'fallback-execute'
    | 'unknown';
  model: string;
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

export type VizEvent = VizLlmEvent | VizRegistryEvent | VizToolEvent | VizTrustEvent;

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
  error?: string;
  totals?: VizRunTotals;
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
      label: label ?? task.description.slice(0, 140),
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

  private persist(): void {
    if (!this.run) return;
    if (!existsSync(this.runsDir)) mkdirSync(this.runsDir, { recursive: true });
    const file = join(this.runsDir, `${this.run.id}.json`);
    writeFileSync(file, JSON.stringify(this.run, null, 2));

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
    // Inflight flag: partial persists during the run carry it; the
    // final endRun persist (which sets endedAt) clears it.
    if (this.run.endedAt === undefined) entry.inFlight = true;
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
