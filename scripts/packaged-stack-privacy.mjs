// Run inside the packaged web host: real receipts, authority and Python BM25.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

export async function verifyCorpusIsolation(projects, runs) {
  const { projectRunHostLayout } = await import('/app/dist/projects/coordinator.js');
  const { buildArtifactManifest } = await import('/app/dist/projects/artifacts.js');
  const { ProjectRetrievalLaunchStore } = await import('/app/dist/projects/retrievalLaunch.js');
  const { openProjectRunHaystack } = await import('/app/dist/projects/retrievalHaystackLaunch.js');
  const { createProjectRetrievalTool } = await import('/app/dist/tools/projectRetrieval.js');
  const { generateHaystackConfig } = await import('/app/dist/cli/haystackConfig.js');
  const config = JSON.parse(await generateHaystackConfig(['--python', '/opt/atoma-python/bin/python']));
  const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 60000 });
  const launches = ProjectRetrievalLaunchStore.open(process.env.ATOMA_DB_PATH);
  const results = [];
  for (const [index, source] of runs.entries()) {
    const stored = projects.getProjectRun(source.orgId, source.runId);
    const manifest = buildArtifactManifest({ workspaceRoot: source.workspacePath, declaredPaths: ['private.txt'] }).manifest;
    projects.saveArtifactManifest(source.orgId, source.runId, manifest);
    const runId = randomUUID();
    const paths = projectRunHostLayout(process.env.ATOMA_PROJECTS_ROOT, source.orgId, source.projectId, runId,
      process.env.ATOMA_LAUNCHER_WORKSPACE_ROOT);
    mkdirSync(paths.runsPath, { recursive: true });
    mkdirSync(paths.workspacePath, { recursive: true });
    writeFileSync(paths.logPath, 'Synthetic corpus acceptance run; no model execution.\n');
    projects.createProjectRun({ orgId: source.orgId, projectId: source.projectId,
      principalId: stored.requestedByPrincipalId, projectRunId: runId,
      request: { idempotencyKey: runId, goal: 'Packaged corpus isolation acceptance' },
      hostPaths: { workspacePath: paths.workspacePath, runsPath: paths.runsPath,
        logPath: paths.logPath, skillsPath: process.env.ATOMA_SKILLS_DIR } });
    projects.transitionProjectRun({ orgId: source.orgId, projectRunId: runId, from: 'queued', to: 'running' });
    await assert.rejects(launches.prepare(runId, runs[1-index].runId, context()), /preparation failed/);
    await launches.prepare(runId, source.runId, context());
    const prepared = openProjectRunHaystack({ dbPath: process.env.ATOMA_DB_PATH, runId,
      workspacePath: paths.workspacePath, runsPath: paths.runsPath, skillsPath: process.env.ATOMA_SKILLS_DIR }, config);
    const tool = createProjectRetrievalTool(prepared.binding, context());
    try {
      await prepared.prepare(context());
      const own = await tool.execute({ query: 'private annual price' });
      assert.equal(own.ok, true, JSON.stringify(own));
      assert(own.passages.length > 0, 'Positive control: own corpus must be searchable');
      const ownMarker = index === 0 ? 'ASTERFALL_731' : 'BOREALIS_942';
      const foreignMarker = index === 0 ? 'BOREALIS_942' : 'ASTERFALL_731';
      assert(JSON.stringify(own).includes(ownMarker));
      assert(!JSON.stringify(own).includes(foreignMarker));
      const foreign = await tool.execute({ query: foreignMarker });
      assert.equal(foreign.ok, true, JSON.stringify(foreign));
      assert(!JSON.stringify(foreign).includes(foreignMarker));
      assert.equal(await prepared.binding.service.authorize({ ...prepared.binding.scope,
        orgId: runs[1-index].orgId, projectId: runs[1-index].projectId }, context()), false);
      assert.equal((await tool.execute({ query: 'private', orgId: runs[1-index].orgId })).status, 'invalid_request');
      launches.revoke(runId);
      assert.equal((await tool.execute({ query: 'private annual price' })).status, 'denied');
      results.push({ orgId: source.orgId, ownPassages: own.passages.length,
        foreignSource: 'denied', foreignMarker: 'absent', forgedScope: 'denied', revocation: 'denied' });
    } finally {
      await tool.close();
      projects.transitionProjectRun({ orgId: source.orgId, projectRunId: runId, from: 'running', to: 'cancelled' });
    }
  }
  return { engine: 'packaged-python-bm25', organisations: results };
}
