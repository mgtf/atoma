import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The two supervisor hosts follow the CLI conventions (`src/cli/AGENTS.md`):
 * `--help` exits zero, an unknown flag is loud and exits non-zero, and the
 * module is safe to import.
 */

function run(entry: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', entry, ...args], { cwd: process.cwd(), encoding: 'utf8', shell: process.platform === 'win32' });
}

describe.each(['src/cli/analyst.ts', 'src/cli/mender.ts'])('%s', (entry) => {
  it('prints help and exits zero', () => {
    const child = run(entry, ['--help']);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/usage:/);
    expect(child.stdout).toMatch(/what it (does NOT do|never does)/);
  }, 60_000);

  it('keeps an unknown flag loud', () => {
    const child = run(entry, ['--bogus', '--dry-run']);
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/unknown flag: --bogus/);
  }, 60_000);
});
