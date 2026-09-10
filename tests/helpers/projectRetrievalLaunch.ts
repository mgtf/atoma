import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AuthStore } from '../../src/auth/store.js';
import { ProjectStore } from '../../src/projects/store.js';
import { projectRunHostLayout } from '../../src/projects/coordinator.js';
import { buildArtifactManifest } from '../../src/projects/artifacts.js';
import { parseRunLog } from '../../src/cli/burnin.js';

export function projectRetrievalFixture(root: string, options: { subject?: string; slug?: string } = {}) {
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin({ provider: 'github', subject: options.subject ?? 'owner', displayName: 'Owner', email: null, emailVerified: false }, null)!;
  const viewer = login.viewer;
  const projects = ProjectStore.open(dbPath);
  const project = projects.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
    project: { name: 'Docs', slug: options.slug ?? 'docs', repositoryTarget: { installationId: '123', owner: 'owner', name: options.slug ?? 'docs', visibility: 'private' } } });
  const makeRun = (files?: Record<string, string | Buffer>) => {
    const runId = randomUUID();
    const layout = projectRunHostLayout(root, viewer.orgId, project.projectId, runId);
    const created = projects.createProjectRun({ orgId: viewer.orgId, projectId: project.projectId,
      principalId: viewer.principalId, request: { idempotencyKey: runId, goal: 'Consult project documents' }, projectRunId: runId,
      hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath } })!;
    projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: runId, from: 'queued', to: 'running' });
    if (files) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(layout.workspacePath, path)), { recursive: true });
        writeFileSync(join(layout.workspacePath, path), text);
      }
      const manifest = buildArtifactManifest({ workspaceRoot: layout.workspacePath, declaredPaths: Object.keys(files) }).manifest;
      projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: runId, from: 'running', to: 'delivered', traceId: runId,
        stats: parseRunLog('✓ build finished') });
      projects.saveArtifactManifest(viewer.orgId, runId, manifest);
    }
    return { run: projects.getProjectRun(viewer.orgId, created.run.projectRunId)!, layout };
  };
  return { root, dbPath, auth, viewer, projects, project, makeRun };
}
