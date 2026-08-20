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
import { ARTIFACT_MANIFEST_PATH_ENV } from '../run/runner.js';
import {
  acquireRunLease,
  RunLockBusyError,
  type RunLease,
  type RunLeaseAcquirer,
} from '../mcp/runLock.js';
import { repoRoot } from '../mcp/run.js';
import { buildArtifactManifest } from './artifacts.js';
import { ProjectStore } from './store.js';

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

export interface ProjectCoordinatorOptions {
  readonly store: ProjectStore;
  readonly dbPath: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Host root whose layout is `orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
  readonly projectsRoot?: string;
  readonly driver?: ProjectRunDriver;
  readonly acquireLease?: RunLeaseAcquirer;
  readonly publisher?: ProjectRunPublisher;
  readonly cwd?: string;
  readonly timeoutMs?: number;
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

export function projectRunEnvironment(input: {
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly dbPath: string;
  readonly workspacePath: string;
  readonly runsPath: string;
  readonly skillsPath: string;
  readonly runId: string;
  readonly artifactManifestPath: string;
}): NodeJS.ProcessEnv {
  const selected = input.hostEnv['ATOMA_LLM']?.trim() || 'anthropic';
  if (selected !== 'anthropic') {
    throw new ProjectRunConfigurationError(
      'project runs currently require ATOMA_LLM=anthropic; subscription CLI transports cannot honour per-run credentials'
    );
  }
  const apiKey = input.hostEnv['ANTHROPIC_API_KEY']?.trim();
  const authToken = input.hostEnv['ANTHROPIC_AUTH_TOKEN']?.trim();
  if (Boolean(apiKey) === Boolean(authToken)) {
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
  environment['ATOMA_LLM'] = 'anthropic';
  if (apiKey) environment['ANTHROPIC_API_KEY'] = apiKey;
  if (authToken) environment['ANTHROPIC_AUTH_TOKEN'] = authToken;
  const baseUrl = input.hostEnv['ANTHROPIC_BASE_URL']?.trim();
  if (baseUrl) environment['ANTHROPIC_BASE_URL'] = baseUrl;
  for (const tier of [1, 2, 3] as const) {
    const key = `ATOMA_MODEL_L${tier}`;
    const value = input.hostEnv[key]?.trim();
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
    ATOMA_SKILL_LEARN: '0',
    ATOMA_SKILL_PROMOTE: '0',
    ATOMA_SKILL_DIRECT: '0',
    ATOMA_EVENT_SKILLS: '0',
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

function boundedOwnJson(pathname: string): unknown {
  const stat = lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_JSON_BYTES) {
    throw new Error(`control-plane JSON is not a bounded regular file: ${pathname}`);
  }
  return JSON.parse(readFileSync(pathname, 'utf8')) as unknown;
}

function verifiedTrace(pathname: string, expectedRunId: string): void {
  const raw = boundedOwnJson(pathname);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('run trace is not an object');
  }
  const trace = raw as Record<string, unknown>;
  if (trace['id'] !== expectedRunId) throw new Error('run trace id does not match the project run');
  if (typeof trace['endedAt'] !== 'string' || trace['result'] === null || typeof trace['result'] !== 'object') {
    throw new Error('run trace has no completed result');
  }
  if (trace['error'] || trace['cancelled'] === true || trace['degraded'] === true) {
    throw new Error('failed, cancelled or degraded traces are not publishable');
  }
}

/** First `✖ …` line from a failed runner log, else a bounded outcome label. */
export function runnerFailureDetail(log: string, outcome: string): string {
  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('✖ ')) {
      const detail = trimmed.slice(2).trim();
      if (detail) return detail.slice(0, 2_000);
    }
  }
  return `runner finished with outcome ${outcome}`.slice(0, 2_000);
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
    this.cwd = options.cwd ?? repoRoot();
    this.timeoutMs = options.timeoutMs ?? 15 * 60 * 1_000;
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
      });
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
          '--no-learn-skills',
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
            ...(stats && (stats.outcome === 'cancelled' || stats.outcome === 'error')
              ? { stats }
              : {}),
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
