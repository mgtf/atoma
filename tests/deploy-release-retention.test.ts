import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, existsSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const helper = pathToFileURL(resolve('scripts/prune-deploy-releases.mjs')).href;
const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-retention-')));
  cleanup.push(root);
  const procRoot = join(root, 'proc');
  mkdirSync(join(procRoot, 'self'), { recursive: true });
  writeFileSync(join(procRoot, 'self', 'mountinfo'), '1 0 0:1 / / rw - ext4 /dev/test rw\n');
  const releases = Array.from({ length: 14 }, (_, index) => {
    const name = (index + 1).toString(16).padStart(40, '0');
    const directory = join(root, 'releases', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'REVISION'), `${name}\n`);
    writeFileSync(join(directory, 'artifact'), 'preserve or delete as a unit');
    utimesSync(directory, index + 1, index + 1);
    return directory;
  });
  symlinkSync(releases[0]!, join(root, 'current'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'evidence'), 'must survive');
  const run = (apply = true) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { pruneReleases } from ${JSON.stringify(helper)};
     pruneReleases(${JSON.stringify(root)}, ${JSON.stringify({ procRoot, previous: releases[1]!, apply })});`,
  ], { encoding: 'utf8' });
  return { root, procRoot, releases, run };
}

describe('deployment release retention across a real helper process', () => {
  it('keeps five recent versions, active and previous releases, and state', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    f.releases.forEach((directory, index) => expect(existsSync(directory)).toBe(index < 2 || index >= 9));
    expect(readFileSync(join(f.root, 'state', 'evidence'), 'utf8')).toBe('must survive');
  });

  it('preserves process cwd, executable, arguments, maps and open files, and nested mounts', () => {
    const f = fixture();
    const proc = join(f.procRoot, '123');
    mkdirSync(join(proc, 'fd'), { recursive: true });
    symlinkSync(f.releases[2]!, join(proc, 'cwd'));
    symlinkSync(join(f.releases[3]!, 'artifact'), join(proc, 'exe'));
    writeFileSync(join(proc, 'cmdline'), `node\0${f.releases[4]!}/server.js\0`);
    writeFileSync(join(proc, 'maps'), `0-1 rw-p 0 0:0 0 ${f.releases[5]!}/native.node\n`);
    symlinkSync(join(f.releases[6]!, 'artifact'), join(proc, 'fd', '4'));
    writeFileSync(join(f.procRoot, 'self', 'mountinfo'), `1 0 0:1 / ${f.releases[7]!}/mounted rw - ext4 /dev/test rw\n`);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    f.releases.forEach((directory, index) => expect(existsSync(directory)).toBe(index !== 8));
  });

  it('preserves rollback symlinks and never follows symlinks within deleted releases', () => {
    const f = fixture();
    symlinkSync(f.releases[2]!, join(f.root, 'rollback'));
    symlinkSync(join(f.root, 'state'), join(f.releases[3]!, 'state'));
    utimesSync(f.releases[3]!, 4, 4);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.releases[2]!)).toBe(true);
    expect(existsSync(f.releases[3]!)).toBe(false);
    expect(existsSync(join(f.root, 'state', 'evidence'))).toBe(true);
  });

  it('defaults to preview and changes no files', () => {
    const f = fixture();
    expect(f.run(false).status).toBe(0);
    expect(f.releases.every((directory) => existsSync(directory))).toBe(true);
  });

  it.each(['receipt', 'inventory', 'current'] as const)('fails before any removal on invalid %s', (fault) => {
    const f = fixture();
    if (fault === 'receipt') writeFileSync(join(f.releases[8]!, 'REVISION'), 'wrong');
    if (fault === 'inventory') rmSync(join(f.procRoot, 'self', 'mountinfo'));
    if (fault === 'current') {
      rmSync(join(f.root, 'current'));
      symlinkSync(join(f.root, 'state'), join(f.root, 'current'));
    }
    expect(f.run().status).not.toBe(0);
    expect(f.releases.every((directory) => existsSync(directory))).toBe(true);
  });

  it('runs after health verification and reports helper failure without failing the deployment', () => {
    const script = readFileSync('deploy/host-deploy.sh', 'utf8');
    const start = script.indexOf('if ! node "$(dirname "${BASH_SOURCE[0]}")/atoma-prune-releases.mjs"');
    expect(start).toBeGreaterThan(script.indexOf('fail "new generation failed health verification"'));
    expect(start).toBeGreaterThan(script.lastIndexOf('ACTIVATION_STARTED=0'));
    const end = script.indexOf('\nfi', start) + 3;
    const invocation = script.slice(start, end);
    const result = spawnSync('bash', ['-c', `set -eu; DEPLOY_ROOT=/unused; node() { return 1; }; ${invocation}\nprintf success`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('WARNING: release retention failed');
    expect(result.stdout).toBe('success');
  });
});
