// Piped to node inside the packaged web image by launcher-container-smoke.mjs.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const { RemoteWorkerExecutor } = await import('/app/dist/launcher/remoteWorker.js');
const { SocketLauncher } = await import('/app/dist/launcher/client.js');
const root = process.env.ATOMA_TEST_ROOT;
const endpoint = process.env.ATOMA_LAUNCHER_SOCKET;
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try { const client = await SocketLauncher.connect(endpoint); client.close(); ready = true; break; }
  catch { await delay(500); }
}
assert(ready, 'Packaged launcher did not become ready');
const pathFor = orgId => `${root}/workspaces/projects/${orgId}/project/run/workspace`;
const executeAs = async (orgId, action) => {
  const executor = new RemoteWorkerExecutor({ endpoint, image: process.env.ATOMA_WORKER_IMAGE,
    project: { orgId, projectId: 'project', runId: 'run' }, workspaceHostPath: pathFor(orgId),
    forwardWorkerLogs: false, callTimeoutMs: 10_000 });
  try { await executor.start(); await action(executor); }
  finally { await executor.drain(); }
};
await executeAs('org-a', async worker => {
  if (process.env.ATOMA_TEST_PHASE === 'initial') {
    await worker.execute('write_file', { path: 'private.txt', content: 'ORG_A_PRIVATE_BYTES' });
  }
  assert(JSON.stringify(await worker.execute('read_file', { path: 'private.txt' })).includes('ORG_A_PRIVATE_BYTES'));
});
await executeAs('org-b', async worker => {
  await worker.execute('write_file', { path: 'own.txt', content: 'ORG_B_DELIVERY' });
  const probe = await worker.execute('run_shell', { command: 'node', args: ['-e',
    `const fs=require('node:fs'); const paths=${JSON.stringify([
      `${pathFor('org-a')}/private.txt`, endpoint, '/var/run/docker.sock', '/srv/atoma/product/atoma.db',
    ])}; for(const p of paths){try{fs.readFileSync(p);process.exit(9)}catch(e){if(!['ENOENT','EACCES','ENOTDIR'].includes(e.code))throw e}} console.log('FOREIGN_PATHS_BLOCKED');`,
  ] });
  assert.equal(probe.exitCode, 0, JSON.stringify(probe));
  assert(probe.stdout.includes('FOREIGN_PATHS_BLOCKED'));
  assert(JSON.stringify(await worker.execute('read_file', { path: 'own.txt' })).includes('ORG_B_DELIVERY'));
});
console.log(`packaged launcher ${process.env.ATOMA_TEST_PHASE}: two isolated worker workspaces passed`);
