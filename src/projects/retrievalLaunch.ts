import Database from 'better-sqlite3';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openStoreHandle } from '../core/stores.js';
import { roleAtLeast, type OrgRole } from '../auth/store.js';
import { projectRunIdSchema, type ProjectRun } from '../contracts/projects.js';
import { projectRetrievalLaunchSchema, type ProjectRetrievalLaunch } from '../contracts/projectRetrievalLaunch.js';
import { projectRetrievalScopeSchema, type ProjectRetrievalScope } from '../contracts/projectRetrieval.js';
import { canonicalRetrievalManifest, captureProjectDocument, assertRetrievalTime,
  prepareProjectRetrievalCorpus, projectRetrievalHash, retrievalGeneration, retrievalIndexConfig } from './retrievalCorpus.js';
import { ProjectRetrievalIndex } from './retrievalIndex.js';
import { ProjectStore } from './store.js';
import { artifactManifestHash, assertPublishableArtifactPath } from './artifacts.js';
import type { ProjectRetrievalBinding, ProjectRetrievalCallContext, ProjectRetrievalService } from '../tools/projectRetrieval.js';

/** Source receipts are authoritative; derived FTS tables retain their separate disposable lifecycle. */
export const PROJECT_RETRIEVAL_LAUNCH_DDL = `
CREATE TABLE IF NOT EXISTS project_retrieval_launches (
  run_id TEXT PRIMARY KEY REFERENCES project_runs(project_run_id),
  receipt_json TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE TRIGGER IF NOT EXISTS project_retrieval_launch_immutable
BEFORE UPDATE OF run_id, receipt_json ON project_retrieval_launches
BEGIN SELECT RAISE(ABORT, 'retrieval launch identity is immutable'); END;
`;

function sourceRootFor(run: ProjectRun): string {
  return join(dirname(resolve(run.hostPaths.workspacePath)), 'retrieval-source');
}

/** Reads live control-plane state. A persisted receipt is data, never an access grant. */
export class ProjectRetrievalLaunchStore {
  private readonly projects: ProjectStore;
  constructor(private readonly db: Database.Database, options: { initialize?: boolean } = {}) {
    if (options.initialize !== false) db.exec(PROJECT_RETRIEVAL_LAUNCH_DDL);
    this.projects = new ProjectStore(db, { initialize: false });
  }

  static open(dbPath: string): ProjectRetrievalLaunchStore {
    return new ProjectRetrievalLaunchStore(openStoreHandle(dbPath, PROJECT_RETRIEVAL_LAUNCH_DDL));
  }

  private eligibleRun(runId: string): ProjectRun | null {
    const run = this.projects.getProjectRunAnyOrg(projectRunIdSchema.parse(runId));
    if (!run || run.status !== 'running') return null;
    const project = this.projects.getProject(run.orgId, run.projectId);
    if (project?.status !== 'active') return null;
    const member = this.db.prepare(`SELECT role FROM auth_memberships
      WHERE org_id = ? AND principal_id = ?`).get(run.orgId, run.requestedByPrincipalId) as { role: OrgRole } | undefined;
    if (!member || !roleAtLeast(member.role, 'org:member')) return null;
    return run;
  }

  private read(runId: string): ProjectRetrievalLaunch | null {
    const row = this.db.prepare('SELECT receipt_json FROM project_retrieval_launches WHERE run_id = ? AND revoked = 0')
      .get(runId) as { receipt_json: string } | undefined;
    return row ? projectRetrievalLaunchSchema.parse(JSON.parse(row.receipt_json)) : null;
  }

  resolve(runId: string): ProjectRetrievalLaunch | null {
    try {
      return this.db.transaction(() => {
        const run = this.eligibleRun(runId);
        const receipt = run && this.read(runId);
        if (!run || !receipt || receipt.scope.kind !== 'tenant' ||
            receipt.scope.runId !== run.projectRunId || receipt.scope.orgId !== run.orgId ||
            receipt.scope.projectId !== run.projectId || receipt.scope.principalId !== run.requestedByPrincipalId ||
            receipt.sourceRoot !== sourceRootFor(run) ||
            receipt.scope.generation !== retrievalGeneration(canonicalRetrievalManifest(receipt.manifest), retrievalIndexConfig())) return null;
        if (receipt.sourceRunId) {
          const source = this.projects.getProjectRun(run.orgId, receipt.sourceRunId);
          if (!source || source.projectId !== run.projectId || source.status !== 'delivered' ||
              source.artifactManifestHash !== receipt.sourceManifestHash) return null;
        }
        return receipt;
      })();
    } catch { return null; }
  }

  authorize(scope: ProjectRetrievalScope): boolean {
    const current = this.resolve(scope.runId);
    return current !== null && JSON.stringify(current.scope) === JSON.stringify(projectRetrievalScopeSchema.parse(scope));
  }

  /** Revocation is immediate; archives and cache tables remain available for later retention. */
  revoke(runId: string): void {
    this.db.prepare('UPDATE project_retrieval_launches SET revoked = 1 WHERE run_id = ?').run(projectRunIdSchema.parse(runId));
  }

  async prepare(runId: string, sourceRunId: string | null, context: ProjectRetrievalCallContext): Promise<ProjectRetrievalLaunch> {
    try {
      assertRetrievalTime(context);
      const run = this.eligibleRun(runId);
      if (!run) throw new Error('denied');
      const source = sourceRunId ? this.projects.getProjectRun(run.orgId, sourceRunId) : null;
      if (sourceRunId && (!source || source.projectId !== run.projectId || source.status !== 'delivered')) throw new Error('invalid source run');
      if (source?.artifactManifest && artifactManifestHash(source.artifactManifest) !== source.artifactManifestHash) throw new Error('invalid source manifest');
      const documents = (source?.artifactManifest?.files ?? [])
        .filter(file => /\.(md|txt)$/.test(file.path) && file.mode === '100644')
        .map(file => {
          assertPublishableArtifactPath(file.path);
          return { path: file.path, sha256: file.sha256, bytes: file.size };
        });
      const manifest = canonicalRetrievalManifest({
        version: 1, corpusId: 'project-docs', snapshotId: run.projectRunId,
        snapshotSha256: projectRetrievalHash(JSON.stringify([run.orgId, run.projectId, sourceRunId, source?.artifactManifestHash ?? null, documents])),
        documents,
      });
      const sourceRoot = sourceRootFor(run);
      await mkdir(dirname(sourceRoot), { recursive: true, mode: 0o700 });
      await mkdir(sourceRoot, { mode: 0o700 }); // reserve a fresh archive; never overwrite evidence
      const originalRoot = source && documents.length ? await realpath(source.hostPaths.workspacePath) : null;
      for (const document of manifest.documents) {
        assertRetrievalTime(context);
        const bytes = await captureProjectDocument(originalRoot!, document, context);
        const target = join(sourceRoot, document.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o400 });
      }
      const corpus = await prepareProjectRetrievalCorpus(sourceRoot, manifest, context);
      const scope = projectRetrievalScopeSchema.parse({ kind: 'tenant', runId,
        orgId: run.orgId, projectId: run.projectId, principalId: run.requestedByPrincipalId,
        corpusId: manifest.corpusId, snapshotId: manifest.snapshotId,
        snapshotSha256: manifest.snapshotSha256, generation: corpus.generation });
      const receipt = projectRetrievalLaunchSchema.parse({ version: 1, scope, manifest, sourceRoot,
        sourceRunId, sourceManifestHash: source?.artifactManifestHash ?? null });
      await new ProjectRetrievalIndex(this.db).build(scope, corpus, context);
      this.db.transaction(() => {
        assertRetrievalTime(context);
        if (!this.eligibleRun(runId)) throw new Error('denied');
        this.db.prepare('INSERT INTO project_retrieval_launches(run_id, receipt_json) VALUES (?, ?)').run(runId, JSON.stringify(receipt));
        if (!this.resolve(runId)) throw new Error('source changed');
      }).immediate();
      return receipt;
    } catch {
      throw new Error(context.signal.aborted ? 'project document preparation cancelled' :
        'project document preparation failed');
    }
  }
}

/** Child host uses a separate read-only handle on the SAME product file; no DDL or worker imports. */
export function openProjectRunRetrieval(input: {
  dbPath: string; runId: string; workspacePath: string; skillsPath: string; runsPath: string;
}): ProjectRetrievalBinding {
  let db: Database.Database | undefined;
  try {
    db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
    const launches = new ProjectRetrievalLaunchStore(db, { initialize: false });
    db.pragma('busy_timeout = 0');
    const receipt = launches.resolve(input.runId);
    if (!receipt) throw new Error('missing or denied receipt');
    const run = new ProjectStore(db, { initialize: false }).getProjectRunAnyOrg(input.runId)!;
    db.pragma('busy_timeout = 0');
    if (resolve(input.workspacePath) !== resolve(run.hostPaths.workspacePath) ||
        resolve(input.runsPath) !== resolve(run.hostPaths.runsPath) ||
        resolve(input.skillsPath) !== join(dirname(dirname(dirname(run.hostPaths.workspacePath))), 'skills')) {
      throw new Error('inconsistent run paths');
    }
    // Preflight must not leave a connection behind if provider/workspace setup later fails.
    db.close(); db = undefined;
    let connection: Database.Database | undefined;
    let active: ProjectRetrievalService | undefined;
    let closed = false;
    const activate = (): ProjectRetrievalService => {
      if (closed) throw new Error('project retrieval closed');
      if (!active) {
        const candidate = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
        try {
          const live = new ProjectRetrievalLaunchStore(candidate, { initialize: false });
          candidate.pragma('busy_timeout = 0');
          active = new ProjectRetrievalIndex(candidate, { initialize: false }).createService(receipt.scope,
            async scope => live.authorize(scope));
          connection = candidate;
        } catch (error) { candidate.close(); throw error; }
      }
      return active;
    };
    const service: ProjectRetrievalService = {
      authorize: async (scope, context) => {
        try { return await activate().authorize(scope, context); } catch { return false; }
      },
      search: async (scope, query, context) => {
        try { return await activate().search(scope, query, context); } catch { return { ok: false, status: 'unavailable' }; }
      },
      dispose: async () => {
        closed = true;
        try { await active?.dispose(); } finally { if (connection?.open) connection.close(); }
      },
    };
    return { scope: receipt.scope, service };
  } catch {
    db?.close();
    throw new Error('project retrieval launch is unavailable or denied');
  }
}
