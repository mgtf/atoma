import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseModelSelector } from '../contracts/modelSelector.js';
import { parseRunStatsEpilogue } from '../contracts/runStats.js';
import { readTraceTopLevelFields } from '../contracts/traceFields.js';
import {
  retrievalCampaignResultSchema, type RetrievalCampaignResult,
  type RetrievalRegistration, type RetrievalScheduleEntry,
} from '../contracts/retrievalCampaign.js';
import { acquireRunLeaseWithoutRecovery, type RunLease } from '../mcp/runLock.js';
import { spawnRun, withUnkillableBackstop, DEFAULT_HARD_KILL_MARGIN_MS, UNKILLABLE_BACKSTOP_EXTRA_MS } from './burnin.js';
import {
  loadRetrievalDataset, prepareRetrievalWorkspace, readRetrievalFile, questionFor,
  type RetrievalDataset,
} from './retrievalDataset.js';
import { prepareRetrievalProjectAttempt } from './retrievalProjectAttempt.js';
import { retrievalObservations } from './retrievalObservations.js';
import { inspectHaystackRuntime } from '../projects/retrievalHaystackRuntime.js';
import { pairedRetrievalDecision } from './retrievalComparison.js';
import { scoreRetrievalWorkspace } from './retrievalScorer.js';
import {
  archiveRetrievalSource, assertRetrievalExecutionIdentity, assertRetrievalCampaignExecutable, validateRetrievalRegistration,
} from './retrievalRegistration.js';

type CampaignDeps = {
  spawn: typeof spawnRun;
  acquire: (id: string) => RunLease;
  verify: typeof assertRetrievalExecutionIdentity;
  archiveSource: typeof archiveRetrievalSource;
  preflight: typeof inspectRetrievalHost;
};

/** No ambient model overrides, runtime stores or learning state enter a pair. */
export function retrievalChildEnvironment(
  registration: RetrievalRegistration, entry: RetrievalScheduleEntry,
  attemptRoot: string, runId: string, host: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...host };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ATOMA_') || /^(ANTHROPIC|OPENAI|ZAI|OLLAMA)_/.test(key) ||
        key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  const s = registration.spec;
  return {
    ...env, TZ: 'UTC',
    ATOMA_MODEL_L1: s.models.l1, ATOMA_MODEL_L2: s.models.l2, ATOMA_MODEL_L3: s.models.l3,
    ATOMA_BASELINE_MODEL: s.models.frontier,
    ATOMA_BASELINE: entry.arm === 'frontier-direct' ? '1' : '0',
    ATOMA_BUILD_WORKSPACE: join(attemptRoot, 'workspace'),
    ATOMA_DB_PATH: join(attemptRoot, 'state/store.db'),
    ATOMA_LEDGER_DB: join(attemptRoot, 'state/store.db'),
    ATOMA_SKILLS_DIR: join(attemptRoot, 'state/skills'),
    ATOMA_RUNS_DIR: join(attemptRoot, 'traces'), ATOMA_RUN_ID: runId,
    ATOMA_REQUIRE_ISOLATION: '1', ATOMA_CONTAINER: '1', ATOMA_EGRESS: '0',
    ATOMA_PREFILTER_CACHE: '0', ATOMA_EVENT_SKILLS: '0', ATOMA_SKILL_LEARN: '0',
    ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '0',
    ATOMA_TRUST_THRESHOLD: String(s.thresholds.trust),
    ATOMA_PROMOTE_THRESHOLD: String(s.thresholds.promote),
    ATOMA_DEMOTE_AFTER: String(s.thresholds.demote),
    ATOMA_BUILD_TIMEOUT_MS: String(s.timeoutMs),
    ATOMA_CLI_CALL_TIMEOUT_MS: String(s.timeoutMs), ATOMA_CODEX_CALL_TIMEOUT_MS: String(s.timeoutMs),
  };
}

/** Read-only, quota-free checks. Never download or rebuild an image here. */
export function inspectRetrievalHost(registration: RetrievalRegistration): Record<string, string> {
  const versions: Record<string, string> = {};
  const image = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', registration.spec.workerImage], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16_000,
  }).trim();
  if (image !== registration.spec.workerImage) throw new Error('registered worker image is unavailable');
  versions['workerImage'] = image;
  for (const vendor of new Set(Object.values(registration.spec.models).map(m => parseModelSelector(m).vendor))) {
    const binary = vendor === 'openai' ? 'codex' : 'claude';
    versions[binary] = execFileSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 16_000,
    }).trim();
  }
  if (registration.spec.treatment?.backend === 'haystack') {
    const runtime = inspectHaystackRuntime(registration.spec.treatment.launch.python);
    if (runtime.sha256 !== registration.spec.treatment.launch.runtimeSha256) throw new Error('registered Haystack runtime changed');
    versions['haystackRuntimeSha256'] = runtime.sha256;
  }
  return versions;
}

/** Copy only registered inputs, not arbitrary neighbouring files or symlinks. */
function archiveDataset(dataset: RetrievalDataset, target: string): RetrievalDataset {
  mkdirSync(target);
  const files = new Set(['corpus.json', 'questions.json', 'instruments.lock.json']);
  for (const s of dataset.corpus.snapshots) {
    for (const file of [...s.documents, ...s.assets]) files.add(`${s.root}/${file.path}`);
  }
  for (const q of dataset.questions) if (q.maintenance) files.add(q.maintenance.referencePath);
  for (const path of files) {
    const bytes = readRetrievalFile(dataset.root, path, 2_000_000);
    const to = join(target, path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes, { flag: 'wx', mode: 0o600 });
  }
  return loadRetrievalDataset(target);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function traceMatches(path: string, runId: string): boolean {
  try {
    const trace = readTraceTopLevelFields(path, { values: ['id', 'endedAt'], shapes: [] });
    return trace.values['id'] === runId && typeof trace.values['endedAt'] === 'string';
  } catch { return false; }
}

export function summarizeRetrievalCampaign(
  registration: RetrievalRegistration, rows: readonly RetrievalCampaignResult[], reason: string
) {
  const comparison = pairedRetrievalDecision(registration, rows);
  if (comparison && reason !== 'completed') comparison.decision = 'inconclusive';
  return {
    campaignId: registration.spec.id, kind: registration.spec.kind, reason,
    planned: registration.schedule.length, attempted: rows.length,
    // Subscription equivalents are reported through the runner's ONE price authority.
    apiSpendUsd: 0,
    subscriptionPriceEquivalentUsd: rows.every(r => r.runner?.costUsd !== null && r.runner?.costUsd !== undefined)
      ? rows.reduce((sum, r) => sum + r.runner!.costUsd!, 0) : null,
    arms: [...new Set(registration.schedule.map(entry => entry.arm))].map(arm => {
      const selected = rows.filter(r => r.entry.arm === arm);
      return {
        arm, planned: registration.schedule.filter(e => e.arm === arm).length,
        attempted: selected.length, full: selected.filter(r => r.full).length,
        infrastructureFailures: selected.filter(r => r.infrastructureFailure).length,
        elapsedMs: selected.reduce((sum, r) => sum + r.elapsedMs, 0),
        llmCalls: selected.every(r => r.runner?.llmCalls !== null && r.runner?.llmCalls !== undefined)
          ? selected.reduce((sum, r) => sum + r.runner!.llmCalls!, 0) : null,
      };
    }),
    comparison,
    claim: registration.spec.kind === 'agentic-characterization' ? 'characterization only; no retrieval treatment or improvement claim' :
      'development screening only; correlated synthetic tasks do not establish production benefit',
  };
}

/** A campaign driver over spawnRun, never another agent/supervision loop. */
export async function runRetrievalCampaign(
  input: unknown, dataset: RetrievalDataset,
  options: { repo: string; out: string; signal?: AbortSignal; hostEnv?: NodeJS.ProcessEnv },
  overrides: Partial<CampaignDeps> = {}
): Promise<ReturnType<typeof summarizeRetrievalCampaign>> {
  const deps: CampaignDeps = {
    spawn: spawnRun, acquire: acquireRunLeaseWithoutRecovery,
    verify: assertRetrievalExecutionIdentity, archiveSource: archiveRetrievalSource,
    preflight: inspectRetrievalHost, ...overrides,
  };
  const registration = validateRetrievalRegistration(input, dataset);
  assertRetrievalCampaignExecutable(registration.spec);
  deps.verify(registration, options.repo);
  if (options.signal?.aborted) throw new Error('campaign cancelled before launch');
  const host = { ...(options.hostEnv ?? process.env) };
  const versions = deps.preflight(registration);
  const lease = deps.acquire(`retrieval:${registration.spec.id}`);
  const out = resolve(options.out);
  let reserved = false;
  let childSettled = true;
  const rows: RetrievalCampaignResult[] = [];
  let reason = 'completed';
  try {
    mkdirSync(out); // Never overwrite or resume a campaign archive.
    reserved = true;
    writeJson(join(out, 'registration.json'), registration);
    writeJson(join(out, 'host.json'), { observedAt: new Date().toISOString(), versions, runtime: registration.runtime });
    deps.archiveSource(options.repo, registration, out);
    const frozen = archiveDataset(dataset, join(out, 'dataset'));
    validateRetrievalRegistration(registration, frozen);
    const rowsPath = join(out, 'results.jsonl');
    writeFileSync(rowsPath, '', { flag: 'wx', mode: 0o600 });
    mkdirSync(join(out, 'attempts'));
    const started = Date.now();
    const utcDay = new Date(started).toISOString().slice(0, 10);
    const budgetSignal = AbortSignal.timeout(registration.spec.maxWallMs);
    const signal = options.signal ? AbortSignal.any([options.signal, budgetSignal]) : budgetSignal;
    let consecutiveInfrastructureFailures = 0;
    for (const entry of registration.schedule) {
      if (signal.aborted) { reason = options.signal?.aborted ? 'cancelled' : 'wall-budget'; break; }
      if (new Date().toISOString().slice(0, 10) !== utcDay) { reason = 'utc-day-boundary'; break; }
      deps.verify(registration, options.repo);
      if (!isDeepStrictEqual(deps.preflight(registration), versions)) throw new Error('worker or CLI version changed during campaign');
      if (Date.now() - started >= registration.spec.maxWallMs || signal.aborted) {
        reason = options.signal?.aborted ? 'cancelled' : 'wall-budget'; break;
      }
      const id = `${String(entry.ordinal).padStart(4, '0')}-${entry.arm}-${entry.questionId}`;
      const attempt = join(out, 'attempts', id);
      mkdirSync(attempt);
      for (const dir of ['state/skills', 'traces']) mkdirSync(join(attempt, dir), { recursive: true });
      const prepared = prepareRetrievalWorkspace(frozen, entry.questionId, join(attempt, 'seed'));
      const runId = registration.spec.kind !== 'agentic-characterization' ? randomUUID() : `retrieval-${randomUUID()}`;
      let env = retrievalChildEnvironment(registration, entry, attempt, runId, host);
      const start = Date.now();
      const project = registration.spec.kind !== 'agentic-characterization' ? await prepareRetrievalProjectAttempt({
        registration, entry, dataset: frozen, attempt, seed: prepared.workspace, runId, env, signal,
        deadlineAt: Math.min(start + registration.spec.timeoutMs, started + registration.spec.maxWallMs),
      }) : null;
      if (project) env = project.env;
      const remainingMs = Math.max(1, registration.spec.timeoutMs - (Date.now() - start));
      env['ATOMA_BUILD_TIMEOUT_MS'] = String(remainingMs);
      try {
        writeJson(join(attempt, 'start.json'), {
          entry, runId, goal: prepared.goal, initialState: project ?
            'synthetic project authorities; empty registry before bootstrap; empty skills; see start.db' :
            'empty store before runner bootstrap; empty skills',
          executionEnv: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('ATOMA_'))),
        });
        childSettled = false;
        const pending = Promise.resolve().then(() => deps.spawn({
          cwd: options.repo, npmScript: 'run:build:dev', goal: prepared.goal,
          timeoutMs: remainingMs, logPath: join(attempt, 'run.log'),
          env, signal, onSpawn: pid => lease.attachChild(pid),
          extraArgs: [
            entry.arm === 'frontier-direct' ? '--baseline' : '--no-baseline',
            '--container', '--no-egress', '--worker-image', registration.spec.workerImage,
            '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', '--seed', prepared.workspace,
          ],
        }));
        const log = await withUnkillableBackstop(pending.finally(() => { childSettled = true; }),
          registration.spec.timeoutMs + DEFAULT_HARD_KILL_MARGIN_MS + UNKILLABLE_BACKSTOP_EXTRA_MS, id);
        // Keep the archive write mandatory even though spawnRun's best-effort log
        // write cannot reject a run that already completed.
        writeFileSync(join(attempt, 'run.log'), log, { mode: 0o600 });
        const runner = parseRunStatsEpilogue(log);
        const tracePath = join(env['ATOMA_RUNS_DIR']!, `${runId}.json`);
        const traceValid = traceMatches(tracePath, runId);
        const score = scoreRetrievalWorkspace(frozen, entry.questionId, env['ATOMA_BUILD_WORKSPACE']!);
        const infrastructureFailure = runner === null || runner.outcome === 'error' || !traceValid;
        const row = retrievalCampaignResultSchema.parse({
          entry, runId, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start,
          runner, infrastructureFailure, score,
          full: runner?.outcome === 'delivered' && !infrastructureFailure && score.full,
          tracePath: traceValid ? relative(out, tracePath) : null,
        });
        writeJson(join(attempt, 'retrieval-observations.json'), retrievalObservations(tracePath, frozen, questionFor(frozen, entry.questionId)));
        writeJson(join(attempt, 'result.json'), row);
        appendFileSync(rowsPath, JSON.stringify(row) + '\n');
        rows.push(row);
        // Completion persistence must never erase a stopped attempt or its spend.
        await project?.finish(runner);
        deps.verify(registration, options.repo);
        if (!isDeepStrictEqual(deps.preflight(registration), versions)) throw new Error('worker or CLI version changed during campaign');
        process.stderr.write(`retrieval ${entry.ordinal}/${registration.schedule.length} ${entry.arm} ${entry.questionId}: ${row.full ? 'pass' : 'fail'}\n`);
        consecutiveInfrastructureFailures = infrastructureFailure ? consecutiveInfrastructureFailures + 1 : 0;
        if (consecutiveInfrastructureFailures >= registration.spec.stopAfterConsecutiveInfrastructureFailures) {
          reason = 'infrastructure-stop'; break;
        }
      } finally { project?.close(); }
    }
    if (reason === 'completed' && options.signal?.aborted) reason = 'cancelled';
    else if (reason === 'completed' && budgetSignal.aborted) reason = 'wall-budget';
    else if (reason === 'completed' && new Date().toISOString().slice(0, 10) !== utcDay) reason = 'utc-day-boundary';
    const report = summarizeRetrievalCampaign(registration, rows, reason);
    writeJson(join(out, 'report.json'), report);
    return report;
  } catch (error) {
    if (reserved) writeJson(join(out, 'aborted.json'), {
      ...summarizeRetrievalCampaign(registration, rows, 'aborted'),
      error: error instanceof Error ? error.message : 'campaign failed',
    });
    throw error;
  } finally {
    // A wedged child keeps its recorded PGID and lease for the existing recovery
    // path. Never release the global slot while a run may still be alive.
    if (childSettled) lease.release();
  }
}
