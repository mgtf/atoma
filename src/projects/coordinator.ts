import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseRunLog, spawnRun, type RunStats } from '../cli/burnin.js';
import { declaredArtifactManifestSchema } from '../contracts/artifactManifest.js';
import type {
  ArtifactManifest,
  CreateProjectRunInput,
  Project,
  ProjectRun,
  Publication,
} from '../contracts/projects.js';
import { pinForTier, type TierModelPins } from '../contracts/tierModels.js';
import { readTraceTopLevelFields } from '../contracts/traceFields.js';
// TYPE-ONLY, and it must stay that way: `src/viz/server.ts` imports four
// `src/projects` modules, so a value edge back into `src/viz` would close a
// subsystem cycle and put the delivered/failed decision inside the
// visualization subsystem. The import earns its place by pinning the member
// names below against the shape the recorder actually writes.
import type { VizRun } from '../viz/trace.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../run/runner.js';
import {
  acquireRunLease,
  RunLockBusyError,
  type RunLease,
  type RunLeaseAcquirer,
} from '../mcp/runLock.js';
import { repoRoot } from '../mcp/run.js';
import { buildArtifactManifest } from './artifacts.js';
import { ProjectStateConflict, ProjectStore } from './store.js';

const MAX_CONTROL_JSON_BYTES = 512 * 1024;

export interface ProjectRunPublisher {
  publish(input: {
    readonly project: Project;
    readonly run: ProjectRun;
    readonly workspaceRoot: string;
    readonly manifest: ArtifactManifest;
    readonly manifestHash: string;
  }): Promise<void | Publication | null>;
}

export type ProjectRunDriver = typeof spawnRun;

/**
 * Terminal outcome of one project run, emitted exactly once from `finish()`
 * after the state transition is persisted. Consumers (the viz push notifier)
 * are fail-open: a throwing listener is stderr, never a run failure.
 */
export interface ProjectRunFinishedEvent {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  /** The principal who requested the run — the one to notify. */
  readonly principalId: string;
  readonly goal: string;
  readonly status: 'delivered' | 'failed' | 'cancelled';
}

export interface ProjectCoordinatorOptions {
  readonly store: ProjectStore;
  readonly dbPath: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Host root whose layout is `orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
  readonly projectsRoot?: string;
  readonly driver?: ProjectRunDriver;
  readonly acquireLease?: RunLeaseAcquirer;
  readonly publisher?: ProjectRunPublisher;
  readonly onRunFinished?: (event: ProjectRunFinishedEvent) => void | Promise<void>;
  /**
   * The requesting principal's per-tier model pins, when the deployment has
   * accounts (the viz gate supplies `authStore.modelPins`). Fail-open: a
   * throwing resolver falls back to the operator's host pins, because a
   * preference lookup must never be able to block a run.
   */
  readonly tierModelsFor?: (principalId: string) => TierModelPins;
  /**
   * Does this principal hold the instance-wide platform-admin flag? Supplied
   * as a QUESTION, never as an answer: the coordinator asks it itself, so no
   * caller can hand in a pre-decided "yes". Absent or throwing means NO —
   * fail-closed, unlike `tierModelsFor`, because this one gates spending.
   *
   * It is the authority for the subscription-transport door
   * (`projectRunEnvironment`). The platform-admin flag is the right authority
   * because it is never derived from an OAuth claim: only the operator CLI,
   * run against the store on disk, can mint it (`src/cli/auth.ts`).
   */
  readonly platformAdmins?: (principalId: string) => boolean;
  /**
   * Observer, fired when a run is allowed to spend the HOST's subscription
   * instead of a per-run credential. The caller journals it; nothing here
   * writes an audit row, so there is one delivery path as with
   * `onRunFinished`.
   */
  readonly onSubscriptionTransport?: (info: SubscriptionTransportUse) => void;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** One run allowed through the subscription-transport door. */
export interface SubscriptionTransportUse {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  readonly principalId: string;
  /** The `ATOMA_LLM` value the host configured, e.g. `claude-cli`. */
  readonly transport: string;
}

export class ProjectRunBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRunBusy';
  }
}

export class ProjectRunConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRunConfigurationError';
  }
}

interface ActiveRun {
  readonly orgId: string;
  readonly controller: AbortController;
}

const FORWARDED_HOST_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'CI',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * Transports that bind to a machine-local login session rather than to a
 * credential the caller can supply. `claude` is the bare alias
 * `resolveBaseProviderKind` accepts for `claude-cli`; both spellings must be
 * recognised here or the door would have a hole in it.
 */
export function isSubscriptionTransport(value: string | undefined): boolean {
  const kind = (value ?? '').trim().toLowerCase();
  return kind === 'claude-cli' || kind === 'claude';
}

export function projectRunEnvironment(input: {
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly dbPath: string;
  readonly workspacePath: string;
  readonly runsPath: string;
  readonly skillsPath: string;
  readonly runId: string;
  readonly artifactManifestPath: string;
  /**
   * The requesting account's per-tier choices. A pin set here OVERRIDES the
   * operator's host pin for that tier; a null tier inherits it. Values come
   * from the closed list in `contracts/tierModels.ts`, so they cannot carry a
   * provider selector — the `:` refusal below still guards both sources as a
   * last line of defence rather than as the only one.
   */
  readonly tierModels?: TierModelPins;
  /**
   * THE SUBSCRIPTION-TRANSPORT DOOR. Present only when the coordinator has
   * verified that the REQUESTING principal holds the platform-admin flag.
   *
   * What it permits and what it costs, stated plainly because the whole point
   * is that this is not silent: a machine-bound transport such as
   * `claude-cli` binds to the host's own `claude /login` session, so the run
   * spends THAT subscription and cannot honour a per-run credential. For a
   * tenant that would be one account billing another, which is why the
   * default is still refusal. For a platform admin on their own instance the
   * host subscription IS their subscription, so the objection does not apply
   * — and the platform-admin flag is the right authority precisely because it
   * is never derived from an OAuth claim: only the operator CLI, run against
   * the store on disk, can mint it.
   */
  readonly subscriptionTransport?: { readonly principalId: string };
}): NodeJS.ProcessEnv {
  const selected = input.hostEnv['ATOMA_LLM']?.trim() || 'anthropic';
  const subscriptionRequested = isSubscriptionTransport(selected);
  if (subscriptionRequested && !input.subscriptionTransport) {
    throw new ProjectRunConfigurationError(
      `project runs cannot use ATOMA_LLM=${selected}: a subscription CLI transport binds to this ` +
        'machine\'s own login session, so the run would spend the HOST subscription and ignore ' +
        'per-run credentials. Set ATOMA_LLM=anthropic with a per-run credential, or have a ' +
        'platform admin request the run — that is the one identity allowed through this door.'
    );
  }
  if (!subscriptionRequested && selected !== 'anthropic') {
    throw new ProjectRunConfigurationError(
      `project runs do not support ATOMA_LLM=${selected}; use anthropic with a per-run credential`
    );
  }
  const apiKey = input.hostEnv['ANTHROPIC_API_KEY']?.trim();
  const authToken = input.hostEnv['ANTHROPIC_AUTH_TOKEN']?.trim();
  // The credential rule applies to the credentialled transport only. A
  // subscription run has no per-run credential BY DEFINITION, and demanding
  // one here would refuse exactly the case the door just allowed.
  if (!subscriptionRequested && Boolean(apiKey) === Boolean(authToken)) {
    throw new ProjectRunConfigurationError(
      'project runs require exactly one of ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN'
    );
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED_HOST_ENV) {
    const value = input.hostEnv[key];
    if (value !== undefined) environment[key] = value;
  }
  environment['NODE_ENV'] = 'production';
  if (subscriptionRequested) {
    // Canonical spelling, so a run's env says which transport it used even
    // when the host wrote the bare `claude` alias.
    environment['ATOMA_LLM'] = 'claude-cli';
    // NO credential is forwarded. The transport cannot honour one, and a
    // stale exported key reaching the subprocess would only confuse the
    // provider's own precedence rules.
  } else {
    environment['ATOMA_LLM'] = 'anthropic';
    if (apiKey) environment['ANTHROPIC_API_KEY'] = apiKey;
    if (authToken) environment['ANTHROPIC_AUTH_TOKEN'] = authToken;
    const baseUrl = input.hostEnv['ANTHROPIC_BASE_URL']?.trim();
    if (baseUrl) environment['ANTHROPIC_BASE_URL'] = baseUrl;
  }
  for (const tier of [1, 2, 3] as const) {
    const key = `ATOMA_MODEL_L${tier}`;
    const accountPin = input.tierModels ? pinForTier(input.tierModels, tier) : null;
    const value = (accountPin ?? input.hostEnv[key])?.trim();
    if (!value) continue;
    if (value.includes(':')) {
      throw new ProjectRunConfigurationError(
        `${key} cannot route a tenant run to another provider`
      );
    }
    environment[key] = value;
  }
  Object.assign(environment, {
    ATOMA_REQUIRE_ISOLATION: '1',
    ATOMA_CONTAINER: '1',
    ATOMA_EGRESS: '0',
    ATOMA_DB_PATH: path.resolve(input.dbPath),
    ATOMA_LEDGER_DB: path.resolve(input.dbPath),
    ATOMA_BUILD_WORKSPACE: path.resolve(input.workspacePath),
    ATOMA_RUNS_DIR: path.resolve(input.runsPath),
    ATOMA_SKILLS_DIR: path.resolve(input.skillsPath),
    ATOMA_RUN_ID: input.runId,
    [ARTIFACT_MANIFEST_PATH_ENV]: path.resolve(input.artifactManifestPath),
    // SKILL LEARNING IS ON, and it is the point of the platform: a tenant's
    // runs should get cheaper as their project grows. It was off, and two
    // delivered runs measured what that costs — $0.59 spent, `learnedSkills:
    // 0`, nothing carried into the next run.
    //
    // What makes it safe here is `ATOMA_SKILLS_DIR` above: it points at
    // `<projectRoot>/skills`, so what a run learns is partitioned PER PROJECT.
    // Nothing crosses to another project, let alone another organisation, and
    // the cross-tenant question stays where it belongs — a reviewed offer with
    // a human gate (`docs/platform-skill-offer-review-2026-08-23.md`).
    ATOMA_SKILL_LEARN: '1',
    ATOMA_EVENT_SKILLS: '1',
    // PROMOTION AND DETERMINISTIC DISPATCH STAY OFF. A project run is
    // `--seed`ed from the previous delivered workspace, which is itself the
    // maintenance-mode signal that enables promotion by default — so leaving
    // these unset would promote tenant scripts to trusted executables as a
    // side effect of the seeding. Promotion is what turns a learned recipe
    // into something that RUNS without a model reading it, and that needs
    // measurement this product has not done for tenant work.
    ATOMA_SKILL_PROMOTE: '0',
    ATOMA_SKILL_DIRECT: '0',
    // The prefilter cache stays off for a different reason: it is the one
    // lifecycle store that is NOT partitioned per project — it lives in the
    // shared product store, so one tenant's cached planning decisions would be
    // readable to the next. Partitioning it is its own change.
    ATOMA_PREFILTER_CACHE: '0',
  });
  return environment;
}

function previousDeliveredWorkspace(
  store: ProjectStore,
  orgId: string,
  projectId: string
): string | null {
  const runs = store.listProjectRuns(orgId, projectId);
  if (!runs) return null;
  for (const run of runs) {
    if (run.status !== 'delivered') continue;
    try {
      if (lstatSync(run.hostPaths.workspacePath).isDirectory()) {
        return run.hostPaths.workspacePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * ONE caller: `declared-artifacts.json`. That file is small by contract and its
 * CONTENT is model-chosen, so a size bound plus a whole-document parse is the
 * right shape for it.
 *
 * A run trace is the opposite on both axes — a control-plane-owned path whose
 * SIZE is a function of how much work the run did — and bounding the two the
 * same way is what recorded delivered run `2857a579` as failed. Traces go
 * through `readTraceTopLevelFields`; see `src/contracts/traceFields.ts`.
 */
function boundedOwnJson(pathname: string): unknown {
  const stat = lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_JSON_BYTES) {
    throw new Error(`control-plane JSON is not a bounded regular file: ${pathname}`);
  }
  return JSON.parse(readFileSync(pathname, 'utf8')) as unknown;
}

/**
 * The members the delivery decision reads. `satisfies` pins them against the
 * shape the recorder writes, so renaming a field in `VizRun` fails to compile
 * here instead of silently reading `undefined` in production.
 */
const TRACE_VALUE_KEYS = ['id', 'endedAt', 'cancelled', 'degraded'] as const satisfies readonly (keyof VizRun)[];
/**
 * `result` and `error` are the two members a MODEL wrote. They are read as
 * shapes — present, and an object — and never materialised, which is what
 * makes the projection under 400 bytes on a trace of any size.
 */
const TRACE_SHAPE_KEYS = ['result', 'error'] as const satisfies readonly (keyof VizRun)[];

function verifiedTrace(pathname: string, expectedRunId: string): void {
  const trace = readTraceTopLevelFields(pathname, {
    values: TRACE_VALUE_KEYS,
    shapes: TRACE_SHAPE_KEYS,
  });
  if (trace.values['id'] !== expectedRunId) {
    throw new Error('run trace id does not match the project run');
  }
  if (typeof trace.values['endedAt'] !== 'string' || trace.shapes['result'] !== 'object') {
    throw new Error('run trace has no completed result');
  }
  // PRESENCE, not truthiness: `error: ''` now refuses where it used to pass.
  // `endRun` assigns `error` only from a real message, so no writer produces
  // the empty string, and the tightening only ever refuses.
  if (
    trace.shapes['error'] !== undefined ||
    trace.values['cancelled'] === true ||
    trace.values['degraded'] === true
  ) {
    throw new Error('failed, cancelled or degraded traces are not publishable');
  }
}

/** First `✖ …` line from a failed runner log, else a bounded outcome label. */
export function runnerFailureDetail(log: string, outcome: string): string {
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('✖ ')) continue;
    const detail = trimmed.slice(2).trim();
    if (!detail) continue;
    // A runner error is not always one line: a schema failure prints zod's
    // pretty-printed issues array, whose FIRST line is `[`. MEASURED
    // 2026-08-23, project run `d771d166`: the stored error column held the
    // single character `[` while the field that failed and why sat on the
    // eleven indented lines below it. Continuation lines are recognised by
    // SHAPE — indented, or a bare closing bracket — so an unrelated flat log
    // line that happens to follow a one-line error is never swallowed.
    const parts = [detail];
    let budget = 2_000 - detail.length;
    for (let j = i + 1; j < lines.length && budget > 0; j++) {
      const raw = lines[j]!;
      const isContinuation =
        /^\s+\S/.test(raw) || /^[\]}],?$/.test(raw.trim());
      if (!isContinuation) break;
      const piece = raw.trim();
      parts.push(piece);
      budget -= piece.length + 1;
    }
    return parts.join(' ').slice(0, 2_000);
  }
  return `runner finished with outcome ${outcome}`.slice(0, 2_000);
}

/**
 * THE OPERATOR'S BUDGET FOR ONE PROJECT RUN, and the one place it is decided.
 *
 * It used to be unreachable. The coordinator hard-coded 15 minutes, neither
 * construction site passed `timeoutMs`, `projects run` had no flag, and
 * `spawnRun` writes `ATOMA_BUILD_TIMEOUT_MS` AFTER spreading the caller's env —
 * so an operator's exported value was silently overwritten by the default. Run
 * `949ecd5d` died at 900s after 68 tool calls and $0.96, and its own post-mortem
 * advised raising a variable that could not be raised.
 *
 * The DEFAULT IS UNCHANGED at 15 minutes: what a tenant run may spend is a
 * product decision, not a refactor. What changes is that it can be said.
 *
 * Bounded on both ends because the child derives two later deadlines from it:
 * the runner's watchdog fires at budget + 60s and the harness hard-reaps at
 * budget + 180s, so an absurd value moves those too.
 */
export const DEFAULT_PROJECT_RUN_TIMEOUT_MS = 15 * 60 * 1_000;
export const MIN_PROJECT_RUN_TIMEOUT_MS = 60 * 1_000;
export const MAX_PROJECT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const PROJECT_RUN_TIMEOUT_ENV = 'ATOMA_PROJECT_TIMEOUT_MS';

/**
 * Resolve the budget: an explicit argument wins over the host environment,
 * which wins over the default. A malformed or out-of-range value is a REFUSAL,
 * never a silent fallback — a run that quietly gets 15 minutes when the
 * operator asked for 40 is the defect this replaces, wearing a different hat.
 *
 * Deliberately NOT named `ATOMA_BUILD_TIMEOUT_MS`: that variable belongs to the
 * child, is written by `spawnRun` from this value, and two names for one number
 * on either side of a process boundary is how the first version got confusing.
 */
export function projectRunTimeoutMs(
  hostEnv: NodeJS.ProcessEnv = process.env,
  explicitMs?: number
): number {
  const raw = explicitMs ?? hostEnv[PROJECT_RUN_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_PROJECT_RUN_TIMEOUT_MS;
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new ProjectRunConfigurationError(
      `invalid project run timeout "${String(raw)}" (expected an integer in milliseconds)`
    );
  }
  if (parsed < MIN_PROJECT_RUN_TIMEOUT_MS || parsed > MAX_PROJECT_RUN_TIMEOUT_MS) {
    throw new ProjectRunConfigurationError(
      `project run timeout ${parsed}ms is outside ${MIN_PROJECT_RUN_TIMEOUT_MS}..${MAX_PROJECT_RUN_TIMEOUT_MS}ms`
    );
  }
  return parsed;
}

/** Default host root: `~/.atoma/orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
export const DEFAULT_PROJECTS_ROOT = path.join(homedir(), '.atoma');

/**
 * One run, one directory. The runner's `ATOMA_RUNS_DIR` is the `traces/`
 * child so `{runId}.json` never lands in a shared instance corpus.
 */
export function projectRunHostLayout(
  root: string,
  orgId: string,
  projectId: string,
  runId: string
) {
  const projectRoot = path.join(path.resolve(root), 'orgs', orgId, 'projects', projectId);
  const runRoot = path.join(projectRoot, 'runs', runId);
  return {
    projectRoot,
    runRoot,
    workspacePath: path.join(runRoot, 'workspace'),
    runsPath: path.join(runRoot, 'traces'),
    logPath: path.join(runRoot, 'run.log'),
    skillsPath: path.join(projectRoot, 'skills'),
    artifactManifestPath: path.join(runRoot, 'declared-artifacts.json'),
  };
}

export class ProjectRunCoordinator {
  private readonly store: ProjectStore;
  private readonly dbPath: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly root: string;
  private readonly driver: ProjectRunDriver;
  private readonly acquireLease: RunLeaseAcquirer;
  private readonly publisher?: ProjectRunPublisher;
  private readonly onRunFinished?: (event: ProjectRunFinishedEvent) => void | Promise<void>;
  private readonly tierModelsFor?: (principalId: string) => TierModelPins;
  private readonly platformAdmins?: (principalId: string) => boolean;
  private readonly onSubscriptionTransport?: (info: SubscriptionTransportUse) => void;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: ProjectCoordinatorOptions) {
    this.store = options.store;
    this.dbPath = path.resolve(options.dbPath);
    this.hostEnv = { ...(options.hostEnv ?? process.env) };
    this.root = path.resolve(options.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
    this.driver = options.driver ?? spawnRun;
    this.acquireLease = options.acquireLease ?? acquireRunLease;
    this.publisher = options.publisher;
    if (options.onRunFinished) this.onRunFinished = options.onRunFinished;
    if (options.tierModelsFor) this.tierModelsFor = options.tierModelsFor;
    if (options.platformAdmins) this.platformAdmins = options.platformAdmins;
    if (options.onSubscriptionTransport) {
      this.onSubscriptionTransport = options.onSubscriptionTransport;
    }
    this.cwd = options.cwd ?? repoRoot();
    this.timeoutMs = projectRunTimeoutMs(this.hostEnv, options.timeoutMs);
  }

  /**
   * Boot-time crash recovery: fail every run/publication a dead process left
   * in flight (see `ProjectStore.reconcileInterrupted`). Refuses to run while
   * anything is active in-memory — those rows have live drivers.
   */
  reconcileInterrupted(): { runs: number; publications: number } {
    if (this.active.size > 0) {
      throw new Error('reconcileInterrupted is a boot-time operation; runs are active');
    }
    return this.store.reconcileInterrupted('interrupted by server restart');
  }

  /**
   * The requesting account's tier pins, or none. Fail-open by design: a
   * preferences lookup that throws leaves the operator's host pins in force
   * instead of failing the run the viewer just asked for.
   */
  private resolveTierModels(principalId: string): TierModelPins | undefined {
    if (!this.tierModelsFor) return undefined;
    try {
      return this.tierModelsFor(principalId);
    } catch (error) {
      process.stderr.write(
        `[atoma projects] tier model preferences unavailable for ${principalId}: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * The subscription-transport grant for this requester, or none.
   *
   * FAIL-CLOSED, and deliberately the opposite of `resolveTierModels`: a
   * preferences lookup that throws must not block a run, but an authority
   * lookup that throws must never be read as permission to spend. No
   * resolver wired (a deployment without accounts) is also NO — the
   * ungated developer path uses the CLI runner directly and never comes
   * through here.
   */
  private resolveSubscriptionGrant(principalId: string): { principalId: string } | undefined {
    if (!this.platformAdmins) return undefined;
    try {
      return this.platformAdmins(principalId) ? { principalId } : undefined;
    } catch (error) {
      process.stderr.write(
        `[atoma projects] platform-admin lookup failed for ${principalId}; refusing the subscription transport: ${String(error)}\n`
      );
      return undefined;
    }
  }

  async start(input: {
    readonly orgId: string;
    readonly principalId: string;
    readonly projectId: string;
    readonly request: CreateProjectRunInput;
  }): Promise<ProjectRun> {
    const candidateRunId = randomUUID();
    const candidatePaths = projectRunHostLayout(
      this.root,
      input.orgId,
      input.projectId,
      candidateRunId
    );
    let lease: RunLease;
    try {
      lease = await this.acquireLease(`project:${candidateRunId}`);
    } catch (error) {
      if (error instanceof RunLockBusyError) throw new ProjectRunBusy(error.message);
      throw error;
    }
    let reservation: { readonly run: ProjectRun; readonly created: boolean } | null;
    try {
      reservation = this.store.createProjectRun({
        orgId: input.orgId,
        projectId: input.projectId,
        principalId: input.principalId,
        request: input.request,
        projectRunId: candidateRunId,
        hostPaths: {
          workspacePath: candidatePaths.workspacePath,
          runsPath: candidatePaths.runsPath,
          logPath: candidatePaths.logPath,
        },
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    if (!reservation) {
      lease.release();
      throw new Error('project not found');
    }
    const run = reservation.run;
    if (
      run.projectRunId !== candidateRunId ||
      run.status !== 'queued' ||
      this.active.has(run.projectRunId)
    ) {
      lease.release();
      return run;
    }
    const project = this.store.getProject(input.orgId, input.projectId);
    if (!project) {
      lease.release();
      throw new Error('project not found');
    }
    const layout = projectRunHostLayout(
      this.root,
      input.orgId,
      input.projectId,
      run.projectRunId
    );
    const paths = {
      ...run.hostPaths,
      skillsPath: layout.skillsPath,
      artifactManifestPath: layout.artifactManifestPath,
    };
    const subscriptionGrant = this.resolveSubscriptionGrant(input.principalId);
    let environment: NodeJS.ProcessEnv;
    try {
      environment = projectRunEnvironment({
        hostEnv: this.hostEnv,
        dbPath: this.dbPath,
        workspacePath: paths.workspacePath,
        runsPath: paths.runsPath,
        skillsPath: paths.skillsPath,
        runId: run.projectRunId,
        artifactManifestPath: paths.artifactManifestPath,
        tierModels: this.resolveTierModels(input.principalId),
        ...(subscriptionGrant ? { subscriptionTransport: subscriptionGrant } : {}),
      });
      if (subscriptionGrant && isSubscriptionTransport(this.hostEnv['ATOMA_LLM'])) {
        this.onSubscriptionTransport?.({
          orgId: input.orgId,
          projectId: input.projectId,
          projectRunId: run.projectRunId,
          principalId: input.principalId,
          transport: (this.hostEnv['ATOMA_LLM'] ?? '').trim(),
        });
      }
      this.store.transitionProjectRun({
        orgId: input.orgId,
        projectRunId: run.projectRunId,
        from: 'queued',
        to: 'running',
      });
    } catch (error) {
      try {
        this.store.transitionProjectRun({
          orgId: input.orgId,
          projectRunId: run.projectRunId,
          from: 'queued',
          to: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        });
      } catch (transitionError) {
        process.stderr.write(
          `[atoma projects] failed to persist configuration error for ${run.projectRunId}: ${String(transitionError)}\n`
        );
      }
      lease.release();
      throw error;
    }
    const controller = new AbortController();
    this.active.set(run.projectRunId, { orgId: input.orgId, controller });

    const seedFrom = previousDeliveredWorkspace(this.store, input.orgId, input.projectId);
    let driven: Promise<string>;
    try {
      driven = this.driver({
        goal: run.goal,
        timeoutMs: this.timeoutMs,
        logPath: paths.logPath,
        cwd: this.cwd,
        npmScript: 'run:build',
        signal: controller.signal,
        cleanWorkspace: true,
        extraArgs: [
          '--container',
          // `--no-learn-skills` is gone; the two vetoes below remain, and they
          // are the FINAL word over both the environment and the seed
          // (`src/skills/AGENTS.md`). Without them a seeded workspace would
          // re-enable promotion underneath the env above.
          '--no-promote-skills',
          '--no-direct-skills',
          ...(seedFrom ? ['--seed', seedFrom] : []),
        ],
        env: environment,
        onSpawn: (pid) => lease.attachChild(pid),
      });
    } catch (error) {
      driven = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void this.finish(project, run, paths.artifactManifestPath, driven, lease, controller.signal);
    return this.store.getProjectRun(input.orgId, run.projectRunId)!;
  }

  private async finish(
    project: Project,
    reservedRun: ProjectRun,
    artifactManifestPath: string,
    driven: Promise<string>,
    lease: RunLease,
    signal: AbortSignal
  ): Promise<void> {
    let stats: RunStats | null = null;
    try {
      const log = await driven;
      stats = parseRunLog(log);
      if (signal.aborted || stats.outcome === 'cancelled') {
        this.store.transitionProjectRun({
          orgId: reservedRun.orgId,
          projectRunId: reservedRun.projectRunId,
          from: 'running',
          to: 'cancelled',
          ...(stats.outcome === 'cancelled' || stats.outcome === 'error' ? { stats } : {}),
        });
        return;
      }
      if (stats.outcome !== 'delivered') {
        throw new Error(runnerFailureDetail(log, stats.outcome));
      }
      const tracePath = path.join(reservedRun.hostPaths.runsPath, `${reservedRun.projectRunId}.json`);
      verifiedTrace(tracePath, reservedRun.projectRunId);
      const declarations = declaredArtifactManifestSchema.parse(
        boundedOwnJson(artifactManifestPath)
      );
      if (declarations.runId !== reservedRun.projectRunId) {
        throw new Error('declared artifact manifest belongs to another run');
      }
      const built = buildArtifactManifest({
        workspaceRoot: reservedRun.hostPaths.workspacePath,
        declaredPaths: declarations.outputs,
      });
      let completed = this.store.transitionProjectRun({
        orgId: reservedRun.orgId,
        projectRunId: reservedRun.projectRunId,
        from: 'running',
        to: 'delivered',
        traceId: reservedRun.projectRunId,
        stats,
      });
      if (!completed) throw new Error('project run disappeared before completion');
      completed = this.store.saveArtifactManifest(
        reservedRun.orgId,
        reservedRun.projectRunId,
        built.manifest
      );
      if (!completed) throw new Error('project run disappeared before artifact persistence');
      if (this.publisher) {
        await this.publisher.publish({
          project,
          run: completed,
          workspaceRoot: reservedRun.hostPaths.workspacePath,
          manifest: built.manifest,
          manifestHash: built.hash,
        });
      }
    } catch (error) {
      try {
        const current = this.store.getProjectRun(reservedRun.orgId, reservedRun.projectRunId);
        if (current?.status === 'running') {
          const tracePath = path.join(
            reservedRun.hostPaths.runsPath,
            `${reservedRun.projectRunId}.json`
          );
          this.store.transitionProjectRun({
            orgId: reservedRun.orgId,
            projectRunId: reservedRun.projectRunId,
            from: 'running',
            to: signal.aborted ? 'cancelled' : 'failed',
            ...(existsSync(tracePath) ? { traceId: reservedRun.projectRunId } : {}),
            // WHAT THE FAILURE COST. The outcome vocabulary is
            // delivered | failed | error | cancelled, and this condition
            // enumerated two of the three non-delivered values — so the most
            // ordinary failure, `outcome: 'failed'`, had its stats dropped and
            // the row recorded no cost at all. Measured: a tenant run that
            // burned $1.10 over 41 calls persisted `stats_json = NULL`, which
            // on a platform that bills is not a rounding error. `delivered` is
            // the only outcome that cannot ride a failure, and the store
            // refuses the remaining contradictions itself.
            ...(stats && stats.outcome !== 'delivered' ? { stats } : {}),
            ...(signal.aborted
              ? {}
              : {
                  error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
                }),
          });
        }
      } catch (transitionError) {
        process.stderr.write(
          `[atoma projects] failed to persist completion for ${reservedRun.projectRunId}: ${String(transitionError)}\n`
        );
      }
    } finally {
      // Terminal-outcome hook, AFTER the state transition above persisted and
      // read back from the store so listeners see exactly what the run table
      // says. Fire-and-forget: notification latency or failure must never
      // delay the lease release below or fail the run.
      try {
        const settled = this.onRunFinished
          ? this.store.getProjectRun(reservedRun.orgId, reservedRun.projectRunId)
          : null;
        if (
          this.onRunFinished &&
          settled &&
          (settled.status === 'delivered' ||
            settled.status === 'failed' ||
            settled.status === 'cancelled')
        ) {
          const emit = this.onRunFinished;
          void Promise.resolve(
            emit({
              orgId: settled.orgId,
              projectId: settled.projectId,
              projectRunId: settled.projectRunId,
              principalId: settled.requestedByPrincipalId,
              goal: settled.goal,
              status: settled.status,
            })
          ).catch((error: unknown) => {
            process.stderr.write(
              `[atoma projects] run-finished listener failed for ${reservedRun.projectRunId}: ${String(error)}\n`
            );
          });
        }
      } catch (error) {
        process.stderr.write(
          `[atoma projects] run-finished listener failed for ${reservedRun.projectRunId}: ${String(error)}\n`
        );
      }
      try {
        lease.release();
      } catch (error) {
        process.stderr.write(
          `[atoma projects] failed to release run lease for ${reservedRun.projectRunId}: ${String(error)}\n`
        );
      }
      this.active.delete(reservedRun.projectRunId);
      if (this.active.size === 0) {
        for (const resolveIdle of this.idleWaiters) resolveIdle();
        this.idleWaiters.clear();
      }
    }
  }

  /**
   * Re-drive the publisher for a delivered run whose publication never made
   * it to GitHub — the missing caller behind the 'a retry never creates a
   * second repo' contract. The publication row stays the idempotency
   * boundary: 'published' returns as-is, a concurrent 'publishing' is left
   * alone, and only pending/failed rows are (re)driven. The publisher
   * revalidates the manifest byte-for-byte against the workspace before any
   * upload, so a workspace that changed since delivery is a refusal.
   */
  async retryPublication(orgId: string, projectRunId: string): Promise<ProjectRun | null> {
    if (!this.publisher) {
      throw new ProjectRunConfigurationError('GitHub App is not configured on this deployment');
    }
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run) return null;
    if (run.status !== 'delivered' || !run.artifactManifest || !run.artifactManifestHash) {
      throw new ProjectStateConflict('publication retry requires a delivered run with artifacts');
    }
    const project = this.store.getProject(orgId, run.projectId);
    if (!project) return null;
    await this.publisher.publish({
      project,
      run,
      workspaceRoot: run.hostPaths.workspacePath,
      manifest: run.artifactManifest,
      manifestHash: run.artifactManifestHash,
    });
    return run;
  }

  cancel(orgId: string, projectRunId: string): ProjectRun | null {
    const current = this.store.getProjectRun(orgId, projectRunId);
    if (!current) return null;
    const active = this.active.get(projectRunId);
    if (active?.orgId === orgId) active.controller.abort(new Error('project run cancelled'));
    return current;
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((resolveIdle) => this.idleWaiters.add(resolveIdle));
  }
}
