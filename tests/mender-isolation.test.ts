import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { menderContainerEnv, runIsolatedMenderCommand } from '../src/supervisor/menderIsolation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('passes inference credentials only, without publisher tokens or host config', () => {
  expect(menderContainerEnv({ GH_TOKEN: 'publisher', GITHUB_TOKEN: 'publisher', HOME: '/host',
    GIT_CONFIG_COUNT: '1', ANTHROPIC_API_KEY: 'inference' })).toEqual({ ANTHROPIC_API_KEY: 'inference' });
});

describe.skipIf(process.env['ATOMA_MENDER_CONTAINER_TESTS'] !== '1')('mender container boundary', () => {
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
      if (fs.existsSync(${JSON.stringify(secretPath)})) process.exit(11);
      if (fs.existsSync('/var/run/docker.sock')) process.exit(12);
      if (cp.execFileSync('git', ['config', '--list'], {encoding:'utf8'}).includes('sentinel-publisher')) process.exit(13);
      for (const pid of fs.readdirSync('/proc').filter(x => /^\\d+$/.test(x))) {
        try { if (fs.readFileSync('/proc/' + pid + '/environ').includes('sentinel-publisher')) process.exit(14); } catch {}
      }
      fs.writeFileSync('result.txt', 'isolated');
    `], { cwd: work, timeoutMs: 60_000, env: { ...process.env, GH_TOKEN: 'sentinel-publisher' } });
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(work, 'result.txt'), 'utf8')).toBe('isolated');
    expect(readFileSync(join(work, '.git'), 'utf8')).toBe(original);
  }, 90_000);
});
