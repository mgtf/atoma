import { describe, it, expect } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runLedger(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', 'src/cli/ledger.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('ledger CLI argument contract', () => {
  it('accepts --db before or after the command', () => {
    const missingDb = join(tmpdir(), `atoma-ledger-missing-${process.pid}-${Date.now()}.db`);
    const flagFirst = runLedger(['--db', missingDb, 'check']);
    const commandFirst = runLedger(['check', '--db', missingDb]);

    expect(flagFirst.status, flagFirst.stderr).toBe(0);
    expect(commandFirst.status, commandFirst.stderr).toBe(0);
    expect(flagFirst.stdout).toBe(commandFirst.stdout);
    expect(flagFirst.stdout).toContain(`no store at ${missingDb}`);
  });

  it('keeps unknown commands loud', () => {
    const child = runLedger(['unknown-command']);
    expect(child.status).toBe(1);
    expect(child.stdout).toMatch(/usage: ledger/);
  });

  it('is safe to import as a module', () => {
    const child = spawnSync(
      'npx',
      [
        'tsx',
        '-e',
        "import('./src/cli/ledger.ts').then(() => process.stdout.write('IMPORTED'))",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      }
    );

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('IMPORTED');
    expect(child.stderr).toBe('');
  });
});
