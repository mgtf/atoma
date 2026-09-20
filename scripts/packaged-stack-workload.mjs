// Deterministic Element fixture inside the real web container. No model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
const { openDb } = await import('/app/dist/registry/db.js');
const { ProjectStore } = await import('/app/dist/projects/store.js');
const { projectRunHostLayout } = await import('/app/dist/projects/coordinator.js');
const { RemoteWorkerExecutor } = await import('/app/dist/launcher/remoteWorker.js');
const { SocketLauncher } = await import('/app/dist/launcher/client.js');
const { startPreview, teardownPreview } = await import('/app/dist/preview/runtime.js');
const { parseRunLog } = await import('/app/dist/cli/burnin.js');
const { runBackup } = await import('/app/dist/cli/backup.js');
const state = '/srv/atoma/product';
const authority = JSON.parse(readFileSync(`${state}/smoke-authority.json`, 'utf8'));
const db = openDb(process.env.ATOMA_DB_PATH);
const projects = new ProjectStore(db);
const runs = [];
const endpoint = process.env.ATOMA_LAUNCHER_SOCKET;
let launcher;
const ownerId = randomUUID();
try {
  for (const [key, viewer] of Object.entries(authority)) {
    const orgId = viewer.activeOrganisation.id;
    const principalId = viewer.principalId;
    const project = projects.createProject({ orgId, principalId, project: {
      name: `Stack ${key}`, slug: `stack-${key}`, repositoryTarget: {
        installationId: '123', owner: 'fixture', name: `stack-${key}`, visibility: 'private',
      },
    } });
    const projectId = project.projectId;
    const runId = randomUUID();
    const paths = projectRunHostLayout(process.env.ATOMA_PROJECTS_ROOT, orgId, projectId, runId,
      process.env.ATOMA_LAUNCHER_WORKSPACE_ROOT);
    mkdirSync(paths.runsPath, { recursive: true });
    projects.createProjectRun({ orgId, projectId, principalId, projectRunId: runId,
      request: { idempotencyKey: runId, goal: 'Deterministic packaged Element acceptance' },
      hostPaths: { workspacePath: paths.workspacePath, runsPath: paths.runsPath, logPath: paths.logPath } });
    projects.transitionProjectRun({ orgId, projectRunId: runId, from: 'queued', to: 'running' });
    const worker = new RemoteWorkerExecutor({ endpoint, image: process.env.ATOMA_WORKER_IMAGE,
      project: { orgId, projectId, runId }, workspaceHostPath: paths.workspacePath,
      proxiedEgress: true, forwardWorkerLogs: false });
    try {
      await worker.start();
      await worker.execute('write_file', { path: 'private.txt', content: `PRIVATE_${key}` });
      const deniedPaths = ['/var/run/docker.sock', endpoint, process.env.ATOMA_DB_PATH,
        ...runs.flatMap(run => [run.workspacePath+'/private.txt', run.tracePath])];
      const filesystem = await worker.execute('run_shell', { command: 'node', args: ['-e',
        `const fs=require('node:fs');for(const p of ${JSON.stringify(deniedPaths)}){try{fs.readFileSync(p);process.exit(9)}catch(e){if(!['ENOENT','EACCES','ENOTDIR'].includes(e.code))throw e}}console.log('BLOCKED');`] });
      assert.equal(filesystem.exitCode, 0, JSON.stringify(filesystem));
      assert(filesystem.stdout.includes('BLOCKED'));
      const allowed = await worker.execute('fetch_url', { url: 'https://registry.npmjs.org/left-pad', timeout_ms: 15000 });
      assert.equal(allowed.status, 200);
      const denied = await worker.execute('fetch_url', { url: 'http://127.0.0.1:4111/auth/whoami', timeout_ms: 3000 });
      assert(!denied.ok, 'Worker reached the control plane');
      await worker.execute('write_file', { path: 'server.mjs', content: `import http from 'node:http';
const server=http.createServer(async(req,res)=>{if(req.url==='/probe'){let rootDenied=false,networkDenied=false;try{const fs=await import('node:fs');fs.writeFileSync('/root-write','x')}catch{rootDenied=true}try{await fetch('http://127.0.0.1:4111/auth/whoami',{signal:AbortSignal.timeout(2000)})}catch{networkDenied=true}res.end(JSON.stringify({rootDenied,networkDenied}));return}res.end('DELIVERED_${key}')});server.listen(Number(process.env.PORT),'0.0.0.0',()=>console.log('LISTENING_ON_PORT='+server.address().port));` });
    } finally { await worker.drain(); }
    const tracePath = `${paths.runsPath}/${runId}.json`;
    writeFileSync(tracePath, JSON.stringify({ id: runId, events: [], metadata: { fixture: true } }));
    writeFileSync(paths.logPath, 'Deterministic Element acceptance completed\n');
    projects.transitionProjectRun({ orgId, projectRunId: runId, from: 'running', to: 'delivered',
      traceId: runId, stats: parseRunLog('✓ build finished') });
    runs.push({ orgId, projectId, runId, workspacePath: paths.workspacePath, tracePath });
  }
  assert.equal(projects.getProjectRun(runs[1].orgId, runs[0].runId), null);
  launcher = await SocketLauncher.connect(endpoint);
  const preview = await startPreview({ launcher, runtime: 'runsc', imageDigest: process.env.ATOMA_PREVIEW_IMAGE,
    copyOwnership: launcher.previewOwnership(), probe: async port => (await fetch(`http://127.0.0.1:${port}/`)).ok },
  { ownerId, sourceWorkspace: runs[0].workspacePath, entry: 'server.mjs' });
  assert.equal(await (await fetch(`http://127.0.0.1:${preview.hostPort}/`)).text(), 'DELIVERED_a');
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${preview.hostPort}/probe`)).json(), { rootDenied: true, networkDenied: true });
  console.log(JSON.stringify({ inspectPreview: launcher.unitName('preview-app', ownerId) }));
  await once(process.stdin, 'data'); // Driver checks the actual engine runtime before cleanup.
  await teardownPreview({ launcher }, ownerId, {});
  launcher.close();
  launcher = undefined;
  for (const folder of ['skills','runs','supervisor']) mkdirSync(`${state}/${folder}`, { recursive: true });
  const backup = await runBackup({ dest: `${state}/smoke-backups`, keep: 1, optionalTiers: ['archive'], log: () => {} });
  assert.deepEqual(backup.skipped, []);
  const restored = spawnSync('python3', [`${state}/smoke-restore.py`, backup.snapshotDir, '--dest', `${state}/smoke-restored`],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  writeFileSync(`${state}/smoke-workload.json`, JSON.stringify({ runs, preview: 'runsc', restore: JSON.parse(restored.stdout).status }));
  console.log('real worker delivery, scoped files, egress, gVisor preview and isolated restore passed');
} finally {
  launcher?.close();
  db.close();
}
