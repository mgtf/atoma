import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  runProcessGroupExists,
  signalRunProcessGroup,
  terminateRunProcessGroup,
} from '../src/cli/burnin.js';

describe('detached run process-group termination', () => {
  it('waits for descendants after the group leader has already exited', async () => {
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
         setTimeout(() => process.exit(0), 100);`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    const pgid = leader.pid!;
    await new Promise<void>((resolveExit) => leader.once('exit', () => resolveExit()));
    expect(runProcessGroupExists(pgid)).toBe(true);
    try {
      expect(await terminateRunProcessGroup(pgid, 500, 1000)).toBe(true);
      expect(runProcessGroupExists(pgid)).toBe(false);
    } finally {
      signalRunProcessGroup(pgid, 'SIGKILL');
    }
  });

  it('escalates when the group ignores SIGTERM and confirms ESRCH', async () => {
    const child = spawn(
      process.execPath,
      ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`],
      { detached: true, stdio: 'ignore' }
    );
    const pgid = child.pid!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    try {
      expect(await terminateRunProcessGroup(pgid, 100, 1000)).toBe(true);
      expect(runProcessGroupExists(pgid)).toBe(false);
    } finally {
      signalRunProcessGroup(pgid, 'SIGKILL');
    }
  });
});
