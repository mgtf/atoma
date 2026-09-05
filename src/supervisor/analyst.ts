import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import {
  FINDING_SEVERITY,
  SUPERVISOR_VERDICT_JSON_SCHEMA,
  supervisorVerdictSchema,
  worstFindingKind,
  type FindingKind,
  type StoredVerdict,
  type SupervisorVerdict,
  type VerdictMeta,
} from '../contracts/supervisorVerdict.js';
import { readBoundedJson } from '../sentinel/sources.js';
import type { VizRun, VizRunIndexEntry } from '../viz/trace.js';
import { anyRunActive, finishedRuns } from './activity.js';
import { dispatchMendRequests, mendRequestsFor, type DispatchConfig, type FetchLike } from './dispatch.js';
import { truncate, writeDigest } from './digest.js';
import { ANALYST_HARDENING, ANALYST_PROMPT_VERSION, buildAnalystPrompt } from './analystPrompt.js';
import { safeSink, verdictEvent } from './journal.js';
import {
  runClaudeSession,
  servedMatchesPin,
  type SupervisorProvider,
} from './session.js';

/**
 * STAGE 2 — THE ANALYST. One read-only headless session per finished run,
 * one structured verdict, routed by finding kind.
 *
 * What it must keep true (`docs/supervisor-design.md`):
 *   - NEVER beside a run. Analysis spends the operator's quota and reads a
 *     trace that may still be written; `anyRunActive` is asserted before every
 *     session and a run with no `endedAt` is refused outright.
 *   - READ-ONLY by construction: `Read`, `Glob`, `Grep`, no MCP servers, no
 *     session persistence, a spend ceiling and a wall clock. Verification is
 *     read-only and never replays model-authored commands — that rule applies
 *     to the supervisor itself.
 *   - A `mechanism_candidate` goes to the dated backlog and nowhere else:
 *     COOLING-OFF says a new gate is never designed the day it is found.
 *   - The verdict is validated against the ONE schema in `src/contracts`, the
 *     same schema the session was held to; an invalid one is kept raw and
 *     journaled as nothing.
 *   - Cost is recorded from what was SERVED, never from the requested id.
 */

export const SUPERVISOR_DIRNAME = 'supervisor';

export interface AnalystPaths {
  readonly supervisorDir: string;
  readonly verdictsDir: string;
  readonly workDir: string;
  readonly backlogPath: string;
  readonly alertsPath: string;
}

export function analystPaths(supervisorDir: string): AnalystPaths {
  return {
    supervisorDir,
    verdictsDir: join(supervisorDir, 'verdicts'),
    workDir: join(supervisorDir, 'work'),
    backlogPath: join(supervisorDir, 'backlog.jsonl'),
    alertsPath: join(supervisorDir, 'ALERTS.jsonl'),
  };
}

/** What the analyst needs of `ProjectStore`, and nothing more. */
export interface ProjectFinishedTraceReader {
  listFinishedRunTraces(): readonly {
    readonly projectRunId: string;
    readonly orgId: string;
    readonly projectId: string;
    readonly projectSlug: string;
    readonly endedAt: string;
    readonly file: string | null;
  }[];
}

/** One run to analyse: where its trace is and whom a verdict about it belongs to. */
export interface AnalysisTarget {
  readonly runId: string;
  readonly tracePath: string;
  readonly corpus: 'operator' | 'project';
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly endedAt: string | null;
}

export interface AnalystOptions {
  /** The checkout the session runs in and paths are shown relative to. */
  readonly repoRoot: string;
  readonly runsDir: string;
  /** The tenant corpus, when this store holds one. Operator corpus only without it. */
  readonly projectReader?: ProjectFinishedTraceReader | null;
  /** Hand eligible defects to the mender workflow. Null: keep them in the verdict. */
  readonly dispatch?: DispatchConfig | null;
  readonly fetchImpl?: FetchLike;
  readonly supervisorDir: string;
  readonly leasePath: string;
  readonly provider: SupervisorProvider;
  /** Command spec for the claude binary (the test seam). */
  readonly claudeCommand: string;
  readonly budgetUsd: number;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly journal: PlatformEventSink | null;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

export type AnalyseOutcome =
  | 'analysed'
  | 'already-analysed'
  | 'no-trace'
  | 'refused-live'
  | 'refused-active'
  | 'dry-run'
  | 'session-failed'
  | 'invalid-verdict';

export interface AnalyseResult {
  readonly runId: string;
  readonly outcome: AnalyseOutcome;
  readonly verdictPath: string | null;
  readonly detail?: string;
  /** How many mend requests reached the workflow, when dispatch is configured. */
  readonly dispatched?: number;
}

/** The exact P0 argument shape, measured 2026-08-22 against the real CLI. */
export function analystSessionArgs(prompt: string, provider: SupervisorProvider, budgetUsd: number): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SUPERVISOR_VERDICT_JSON_SCHEMA),
    '--model', provider.model,
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'Read Glob Grep',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd', String(budgetUsd),
    '--append-system-prompt', ANALYST_HARDENING,
    prompt,
  ];
}

function findingKindCounts(verdict: SupervisorVerdict): Record<FindingKind, number> {
  const counts = Object.fromEntries(Object.keys(FINDING_SEVERITY).map((kind) => [kind, 0])) as Record<FindingKind, number>;
  for (const finding of verdict.findings) counts[finding.kind] += 1;
  return counts;
}

/**
 * Write the verdict, route each finding, journal the fact. Backlog and alert
 * files are the analyst's own outputs under the git-ignored `supervisor/`;
 * the journal row carries kinds and counts, never a title.
 */
export function routeVerdict(
  verdict: SupervisorVerdict,
  meta: VerdictMeta,
  paths: AnalystPaths,
  journal: PlatformEventSink,
  log: (line: string) => void,
  warn: (line: string) => void,
  attribution: { orgId: string | null; projectId: string | null } = { orgId: null, projectId: null }
): string {
  mkdirSync(paths.verdictsDir, { recursive: true });
  const verdictPath = join(paths.verdictsDir, `${verdict.runId}.json`);
  const stored: StoredVerdict = { ...verdict, _meta: meta };
  writeFileSync(verdictPath, JSON.stringify(stored, null, 2));

  for (const finding of verdict.findings) {
    if (finding.kind === 'mechanism_candidate') {
      appendFileSync(
        paths.backlogPath,
        JSON.stringify({
          recordedAt: meta.analysedAt,
          runId: verdict.runId,
          runGrade: verdict.runAssessment.grade,
          title: finding.title,
          detail: finding.detail,
          evidence: finding.evidence,
          confidence: finding.confidence,
          fixDirection: finding.proposedFix ?? null,
          coolingOff: 'design later against the full incident set, never same-day',
        }) + '\n'
      );
    }
    if (finding.kind === 'security_incident') {
      appendFileSync(
        paths.alertsPath,
        JSON.stringify({ recordedAt: meta.analysedAt, runId: verdict.runId, ...finding }) + '\n'
      );
      warn(`SECURITY finding on ${verdict.runId}: ${truncate(finding.title, 120)}`);
    }
  }
  journal(
    verdictEvent({
      runId: verdict.runId,
      orgId: attribution.orgId,
      projectId: attribution.projectId,
      runStatus: verdict.runStatus,
      grade: verdict.runAssessment.grade,
      worstFindingKind: meta.worstFindingKind,
      findingKinds: findingKindCounts(verdict),
      modelRequested: meta.modelRequested,
      modelsServed: meta.modelsServed?.map((entry) => entry.model) ?? [],
      analysisCostUsd: meta.analysisCostUsd,
      verdictPath,
    })
  );
  const worst = meta.worstFindingKind;
  log(
    `assessment ${verdict.runAssessment.grade}${worst ? `, worst finding ${worst}` : ', no actionable findings'} ` +
      `for ${verdict.runId} → ${verdictPath}`
  );
  return verdictPath;
}

export function verdictPathFor(supervisorDir: string, runId: string): string {
  return join(analystPaths(supervisorDir).verdictsDir, `${runId}.json`);
}

/** The operator corpus's target for a run id: `<runsDir>/<runId>.json`. */
export function operatorTarget(runsDir: string, runId: string, endedAt: string | null = null): AnalysisTarget {
  return { runId, tracePath: join(runsDir, `${runId}.json`), corpus: 'operator', orgId: null, projectId: null, endedAt };
}

/** Resolve a run id against both corpora: the operator file, else the tenant store. */
export function resolveTarget(runId: string, options: Pick<AnalystOptions, 'runsDir' | 'projectReader'>): AnalysisTarget {
  const operator = operatorTarget(options.runsDir, runId);
  if (existsSync(operator.tracePath)) return operator;
  const row = options.projectReader?.listFinishedRunTraces().find((r) => r.projectRunId === runId);
  if (row?.file) {
    return { runId, tracePath: row.file, corpus: 'project', orgId: row.orgId, projectId: row.projectId, endedAt: row.endedAt };
  }
  return operator;
}

export async function analyseRun(runId: string, options: AnalystOptions): Promise<AnalyseResult> {
  return analyseTarget(resolveTarget(runId, options), options);
}

export async function analyseTarget(target: AnalysisTarget, options: AnalystOptions): Promise<AnalyseResult> {
  const { runId } = target;
  const paths = analystPaths(options.supervisorDir);
  const journal = safeSink(options.journal, options.warn);
  const verdictPath = join(paths.verdictsDir, `${runId}.json`);
  if (existsSync(verdictPath) && !options.force) {
    options.log(`verdict already exists for ${runId} (use --force to redo); skipping`);
    return { runId, outcome: 'already-analysed', verdictPath };
  }
  const runFile = target.tracePath;
  const run = readBoundedJson<VizRun>(runFile);
  if (!run) return { runId, outcome: 'no-trace', verdictPath: null, detail: `no readable trace at ${runFile}` };

  const { digest, paths: digestPaths } = writeDigest(paths.workDir, run);
  if (digest.status === 'unknown') {
    options.warn(`${runId} has no endedAt; refusing to analyse a possibly-live run`);
    return { runId, outcome: 'refused-live', verdictPath: null };
  }
  const rel = (path: string): string => relative(options.repoRoot, path).split('\\').join('/');
  const prompt = buildAnalystPrompt({
    runId,
    runStatus: digest.status,
    runLabel: truncate(String(digest.label ?? '').replace(/\s+/g, ' '), 300),
    costUsd: String(digest.totals?.costUsd ?? 'unknown'),
    durationS: String(Math.round((digest.durationMs ?? 0) / 1000)),
    eventCount: String(digest.eventCount),
    digestPath: rel(digestPaths.digestPath),
    eventsPath: rel(digestPaths.eventsPath),
    runFile: rel(runFile),
  });
  const args = analystSessionArgs(prompt, options.provider, options.budgetUsd);
  options.log(
    `analysing ${runId} (${digest.status}, $${digest.totals?.costUsd ?? '?'}, ${digest.eventCount} events) with ${options.provider.model}`
  );
  if (options.dryRun) {
    options.log(`dry-run: digest at ${rel(digestPaths.digestPath)}`);
    options.log(`dry-run: would spawn ${options.claudeCommand} ${args.slice(0, -1).join(' ')}`);
    options.log(`dry-run: prompt is ${prompt.length} chars`);
    return { runId, outcome: 'dry-run', verdictPath: null };
  }
  if (anyRunActive({ runsDir: options.runsDir, leasePath: options.leasePath })) {
    options.warn('a run is active right now; refusing to spend analyst quota beside it');
    return { runId, outcome: 'refused-active', verdictPath: null };
  }

  const startedAt = Date.now();
  const session = await runClaudeSession({
    claudeCommand: options.claudeCommand,
    args,
    cwd: options.repoRoot,
    provider: options.provider,
    timeoutMs: options.timeoutMs,
    onLog: options.warn,
  });
  if (session.code !== 0) {
    const detail = truncate(session.stderr.trim() || session.stdout.trim(), 2000);
    options.warn(`claude exited ${session.code} for ${runId}: ${detail}`);
    return { runId, outcome: 'session-failed', verdictPath: null, detail };
  }
  const parsed = supervisorVerdictSchema.safeParse(session.structured);
  if (!parsed.success) {
    mkdirSync(paths.verdictsDir, { recursive: true });
    const rawPath = join(paths.verdictsDir, `${runId}.raw.txt`);
    writeFileSync(rawPath, session.stdout);
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    options.warn(`invalid verdict for ${runId} (${problems}); raw kept at ${rawPath}`);
    return { runId, outcome: 'invalid-verdict', verdictPath: null, detail: problems };
  }
  if (!servedMatchesPin(options.provider, session.usage)) {
    options.warn(
      `requested ${options.provider.model} but served ${session.usage.served?.map((m) => m.model).join(' + ')} — ` +
        'this verdict is not comparable to one recorded under the pin'
    );
  }
  // Never trust even the run id to echo correctly.
  const verdict: SupervisorVerdict = { ...parsed.data, runId };
  const meta: VerdictMeta = {
    analysedAt: new Date().toISOString(),
    promptVersion: ANALYST_PROMPT_VERSION,
    modelRequested: options.provider.model,
    providerBaseUrl: options.provider.baseUrl,
    modelsServed: session.usage.served,
    worstFindingKind: worstFindingKind(verdict.findings),
    analysisCostUsd: session.usage.costUsd,
    analysisDurationMs: session.usage.durationMs ?? Date.now() - startedAt,
    analysisTurns: session.usage.turns,
    sessionId: session.usage.sessionId,
  };
  const written = routeVerdict(verdict, meta, paths, journal, options.log, options.warn, {
    orgId: target.orgId,
    projectId: target.projectId,
  });
  let dispatched = 0;
  if (options.dispatch) {
    const requests = mendRequestsFor(verdict, options.dispatch);
    if (requests.length > 0) {
      const outcomes = await dispatchMendRequests({
        requests,
        config: options.dispatch,
        journal,
        orgId: target.orgId,
        projectId: target.projectId,
        warn: options.warn,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      dispatched = outcomes.filter((outcome) => outcome.ok).length;
      options.log(`dispatched ${dispatched}/${requests.length} mend request(s) to ${options.dispatch.repo}`);
    }
  }
  return { runId, outcome: 'analysed', verdictPath: written, dispatched };
}

/* ─────────────────────────────── the loop ─────────────────────────────── */

export const ANALYST_DEFAULT_QUIET_MS = 120_000;
export const ANALYST_DEFAULT_POLL_MS = 15_000;

export interface AnalystLoopOptions {
  readonly analyst: AnalystOptions;
  readonly signal: AbortSignal;
  /** A run must have been finished this long before it is analysed. */
  readonly quietMs?: number;
  readonly pollMs?: number;
  /** Re-queue this many already-finished, un-analysed runs at start. */
  readonly backfill?: number;
  readonly onResult?: (result: AnalyseResult) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true }
    );
  });
}

function isAnalysed(supervisorDir: string, runId: string): boolean {
  return existsSync(verdictPathFor(supervisorDir, runId));
}

/** Finished operator runs not yet analysed, oldest first; the newest `limit` of them when bounded. */
export function pendingRuns(options: Pick<AnalystOptions, 'runsDir' | 'supervisorDir'>, limit?: number): VizRunIndexEntry[] {
  const pending = finishedRuns(options.runsDir).filter((entry) => !isAnalysed(options.supervisorDir, entry.id));
  return limit !== undefined && limit >= 0 ? pending.slice(-limit) : pending;
}

/** Every finished run of BOTH corpora, oldest first; a project run without a trace on disk is left out. */
export function finishedTargets(options: Pick<AnalystOptions, 'runsDir' | 'projectReader'>): AnalysisTarget[] {
  const operator = finishedRuns(options.runsDir).map((entry) =>
    operatorTarget(options.runsDir, entry.id, typeof entry.endedAt === 'string' ? entry.endedAt : null)
  );
  const project: AnalysisTarget[] = [];
  for (const row of options.projectReader?.listFinishedRunTraces() ?? []) {
    if (row.file === null) continue;
    project.push({
      runId: row.projectRunId,
      tracePath: row.file,
      corpus: 'project',
      orgId: row.orgId,
      projectId: row.projectId,
      endedAt: row.endedAt,
    });
  }
  return [...operator, ...project].sort((a, b) => String(a.endedAt ?? '').localeCompare(String(b.endedAt ?? '')));
}

/** Finished runs of both corpora not yet analysed, oldest first; the newest `limit` when bounded. */
export function pendingTargets(
  options: Pick<AnalystOptions, 'runsDir' | 'supervisorDir' | 'projectReader'>,
  limit?: number
): AnalysisTarget[] {
  const pending = finishedTargets(options).filter((target) => !isAnalysed(options.supervisorDir, target.runId));
  return limit !== undefined && limit >= 0 ? pending.slice(-limit) : pending;
}

/**
 * Watch the operator index; analyse each newly finished run once it has been
 * quiet for `quietMs` and no run is active. One attempt per run in watch mode;
 * `--run` redoes. The quiet period is what coalesces a burn-in batch to its
 * end: the machine belongs to the batch while it runs.
 */
export async function runAnalystLoop(loop: AnalystLoopOptions): Promise<void> {
  const { analyst, signal } = loop;
  const quietMs = loop.quietMs ?? ANALYST_DEFAULT_QUIET_MS;
  const pollMs = loop.pollMs ?? ANALYST_DEFAULT_POLL_MS;
  const baseline = new Set(finishedTargets(analyst).map((target) => target.runId));
  if (loop.backfill && loop.backfill > 0) {
    for (const target of pendingTargets(analyst, loop.backfill)) baseline.delete(target.runId);
  }
  while (!signal.aborted) {
    const ready = finishedTargets(analyst).filter(
      (target) =>
        !baseline.has(target.runId) &&
        !isAnalysed(analyst.supervisorDir, target.runId) &&
        Date.now() - Date.parse(String(target.endedAt ?? '')) >= quietMs
    );
    if (ready.length > 0 && !anyRunActive({ runsDir: analyst.runsDir, leasePath: analyst.leasePath })) {
      for (const target of ready) {
        if (signal.aborted) break;
        try {
          loop.onResult?.(await analyseTarget(target, analyst));
        } catch (error) {
          analyst.warn(`analysis of ${target.runId} failed: ${String(error)}`);
        } finally {
          baseline.add(target.runId);
        }
        if (anyRunActive({ runsDir: analyst.runsDir, leasePath: analyst.leasePath })) break;
      }
    }
    if (signal.aborted) break;
    await sleep(pollMs, signal);
  }
}
