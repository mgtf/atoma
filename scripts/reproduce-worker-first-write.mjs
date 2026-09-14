/** Offline diagnostic: real compiled executor, pinned worker, no LLM calls. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [executorFile, image, parent = tmpdir()] = process.argv.slice(2);
if (process.platform !== 'linux' || !executorFile || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) {
  throw new Error('Usage on Linux/WSL: node scripts/reproduce-worker-first-write.mjs <compiled containerExecutor.js> <sha256:image-id> [existing scratch parent]');
}
const { ContainerToolExecutor } = await import(pathToFileURL(resolve(executorFile)).href);
const scratchParent = resolve(parent);
const root = mkdtempSync(join(scratchParent, 'atoma-first-write-'));
const report = { image, node: process.version, uid: process.getuid(), gid: process.getgid(), parent: scratchParent, cases: [] };
try {
  for (const initialState of ['absent', 'empty']) {
    const workspace = join(root, initialState, 'workspace');
    if (initialState === 'empty') mkdirSync(workspace, { recursive: true });
    const before = existsSync(workspace) ? readdirSync(workspace) : null;
    assert.deepEqual(before, initialState === 'empty' ? [] : null);
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace, image, forwardWorkerLogs: false, callTimeoutMs: 15000 });
    const result = { initialState, before, firstWrite: null, shellWrite: null, identity: null, drained: false };
    report.cases.push(result);
    try {
      // Deliberately the FIRST tool call: no shell, chmod or probe before it.
      try {
        await executor.execute('write_file', { path: 'first.txt', content: 'first-tool-write\n' });
        assert.equal(readFileSync(join(workspace, 'first.txt'), 'utf8'), 'first-tool-write\n');
        result.firstWrite = { ok: true };
      } catch (error) { result.firstWrite = { ok: false, error: String(error) }; }
      // Compare a real shell redirection without changing ownership or mode.
      const shell = await executor.execute('run_shell', { command: 'bash', args: ['-c', 'printf "shell-write\\n" > shell.txt'] });
      result.shellWrite = { exitCode: shell.exitCode, stdout: shell.stdout, stderr: shell.stderr };
      if (shell.exitCode === 0) assert.equal(readFileSync(join(workspace, 'shell.txt'), 'utf8'), 'shell-write\n');
      const identity = await executor.execute('run_shell', { command: 'node', args: ['-e',
        "const fs=require('node:fs'),c=require('node:crypto');const s=fs.statSync('/workspace');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),workspace:{uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8)},hashes:Object.fromEntries(['worker','builtin','sandbox'].map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/dist/tools/'+n+'.js')).digest('hex')]))}));",
      ] });
      assert.equal(identity.exitCode, 0);
      result.identity = JSON.parse(identity.stdout.trim());
      const host = statSync(workspace);
      result.hostWorkspace = { uid: host.uid, gid: host.gid, mode: (host.mode & 0o777).toString(8) };
    } finally {
      await executor.drain();
      result.drained = true;
    }
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  // Only our mkdtemp child can be removed, never the caller's parent.
  assert.equal(dirname(root), scratchParent);
  if (report.cases.every((c) => c.drained)) rmSync(root, { recursive: true, force: true });
}
assert.equal(report.cases.length, 2);
assert.ok(report.cases.every((c) => c.firstWrite?.ok && c.shellWrite?.exitCode === 0 && c.drained), 'First write or shell comparison failed; see JSON evidence');
