import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { menderContainerEnv, runIsolatedMenderCommand } from '../src/supervisor/menderIsolation.js';
import { runCodexSupervisor } from '../src/supervisor/codexSession.js';
import { writeCodexStub } from './supervisorCodexFixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('passes inference credentials only, without publisher tokens or host config', () => {
  expect(menderContainerEnv({ GH_TOKEN: 'publisher', GITHUB_TOKEN: 'publisher', HOME: '/host',
    GIT_CONFIG_COUNT: '1', ANTHROPIC_API_KEY: 'inference' })).toEqual({ ANTHROPIC_API_KEY: 'inference' });
});

describe.skipIf(process.env['ATOMA_MENDER_CONTAINER_TESTS'] !== '1')('mender container boundary', () => {
  it('installs then runs the production browser and HOME regressions in a fresh offline container', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-mender-runtime-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const work = join(root, 'work');
    execFileSync('git', ['clone', '--no-local', process.cwd(), repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', work, 'HEAD'], { stdio: 'pipe' });
    const install = await runIsolatedMenderCommand('npm ci', [], { cwd: work, timeoutMs: 300_000 });
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const checked = await runIsolatedMenderCommand('npx vitest run', [
      'tests/smoke-message-legibility.test.ts',
      'tests/validate-html-bounds.test.ts',
      'tests/puppeteer-orphan-reaping.test.ts',
      'tests/backup.test.ts',
    ], { cwd: work, timeoutMs: 180_000, network: 'none' });
    expect(checked.code, checked.stdout + checked.stderr).toBe(0);
  }, 600_000);

  it('executes proposed code without publisher credentials, host files or host processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-mender-isolation-'));
    roots.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-b', 'main', 'repo');
    const repo = join(root, 'repo');
    const work = join(root, 'work');
    git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--allow-empty', '-m', 'base');
    git('-C', repo, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: sentinel-publisher');
    git('-C', repo, 'worktree', 'add', work, '-b', 'proposal');
    const original = readFileSync(join(work, '.git'), 'utf8');
    const secretPath = join(root, 'publisher-secret');
    writeFileSync(secretPath, 'sentinel-publisher');
    const result = await runIsolatedMenderCommand('node', ['-e', `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(10);
      if (process.env.VITEST_MAX_WORKERS !== '1') process.exit(21);
      if (fs.existsSync('/sys/fs/cgroup/memory.max') && fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() !== '2147483648') process.exit(22);
      if (fs.existsSync('/sys/fs/cgroup/memory.swap.max') && fs.readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim() !== '0') process.exit(23);
      if (fs.existsSync(${JSON.stringify(secretPath)})) process.exit(11);
      if (fs.existsSync('/var/run/docker.sock')) process.exit(12);
      if (cp.execFileSync('git', ['config', '--list'], {encoding:'utf8'}).includes('sentinel-publisher')) process.exit(13);
      for (const pid of fs.readdirSync('/proc').filter(x => /^\\d+$/.test(x))) {
        try { if (fs.readFileSync('/proc/' + pid + '/environ').includes('sentinel-publisher')) process.exit(14); } catch {}
      }
      cp.execFileSync('git', ['diff', '--stat']);
      cp.execFileSync('git', ['status', '--short']);
      fs.writeFileSync('result.txt', 'isolated');
    `], { cwd: work, timeoutMs: 60_000, env: { ...process.env, GH_TOKEN: 'sentinel-publisher' } });
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(work, 'result.txt'), 'utf8')).toBe('isolated');
    expect(readFileSync(join(work, '.git'), 'utf8')).toBe(original);
    // Installation and verification are separate disposable containers. Both
    // must find a browser without downloading one, even with networking off.
    writeFileSync(join(work, 'browser.html'), '<html><body>mender-browser-proof</body></html>');
    for (let phase = 0; phase < 2; phase++) {
      const runtime = await runIsolatedMenderCommand('node', ['-e', `
        const assert = require('node:assert/strict');
        const os = require('node:os');
        const cp = require('node:child_process');
        delete process.env.HOME;
        assert.equal(os.homedir(), '/tmp');
        assert.equal(os.userInfo().uid, process.getuid());
        assert.equal(os.userInfo().gid, process.getgid());
        assert.ok(require('node:v8').getHeapStatistics().heap_size_limit > 1500 * 1024 * 1024);
        assert.equal(process.env.PUPPETEER_SKIP_DOWNLOAD, '1');
        const html = cp.execFileSync(process.env.PUPPETEER_EXECUTABLE_PATH, [
          '--headless', '--no-sandbox', '--disable-dev-shm-usage',
          '--dump-dom', 'file:///work/browser.html',
        ], { encoding: 'utf8', timeout: 30000 });
        assert.ok(html.includes('mender-browser-proof'));
      `], { cwd: work, timeoutMs: 60_000, network: 'none' });
      expect(runtime.code, runtime.stderr).toBe(0);
      expect(readFileSync(join(work, '.git'), 'utf8')).toBe(original);
    }
    const auth = join(root, 'auth'); mkdirSync(auth);
    writeFileSync(join(auth, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'credential-sentinel' } }));
    const command = `
      const fs = require('node:fs');
      if (process.env.CODEX_HOME || process.env.OPENAI_API_KEY || process.env.GH_TOKEN) process.exit(15);
      if (fs.existsSync(${JSON.stringify(auth)})) process.exit(19);
      if (fs.existsSync('/codex-home/auth.json')) process.exit(20);
      fs.writeFileSync('/work/codex-proof.txt', 'sandboxed');
      const socket = require('node:net').connect(443, '1.1.1.1');
      socket.on('connect', () => process.exit(16));
      socket.on('error', error => process.exit(['EPERM','EACCES','ENETUNREACH'].includes(error.code) ? 0 : 17));
      setTimeout(() => process.exit(18), 5000);
    `;
    const stub = join(root, 'codex.mjs');
    const log = join(root, 'codex.jsonl');
    writeCodexStub(stub, { log, report: {}, command: `node -e '${command.replaceAll("'", "'\\''")}'` });
    const sandboxed = await runCodexSupervisor({ command: stub, cwd: work,
      provider: { selector: 'sub:openai:gpt-5.6-sol', transport: 'codex', codexHome: auth, model: 'gpt-5.6-sol', source: 'mender', baseUrl: null, authToken: null },
      prompt: 'exercise the isolated worktree command', hardening: '', schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: runIsolatedMenderCommand, timeoutMs: 60_000,
    });
    expect(sandboxed.code, sandboxed.stderr).toBe(0);
    const reply = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.id === 12);
    expect(reply.result, 'dynamic command must succeed inside the real Docker boundary').toMatchObject({ success: true });
    expect(readFileSync(join(work, 'codex-proof.txt'), 'utf8')).toBe('sandboxed');
    await expect(runIsolatedMenderCommand('node', ['-e', `
      const {spawn} = require('node:child_process');
      spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('/work/late-write', 'survived'), 3000)"], {stdio:'ignore'});
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
    `], { cwd: work, timeoutMs: 500 })).rejects.toThrow('timeout');
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_100));
    expect(() => readFileSync(join(work, 'late-write'))).toThrow();
    expect(readFileSync(join(work, '.git'), 'utf8')).toBe(original);
  }, 180_000);
});
