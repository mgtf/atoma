import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forceKillTestProcessTree } from './helpers.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processExists)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

describe('test process cleanup guard', () => {
  it('kills only the known test-owned process tree on Windows and POSIX', async () => {
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
           stdio: 'ignore'
         });
         console.log(child.pid);
         setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (!leader.pid) throw new Error('test process leader pid unavailable');
    let descendantPid: number | undefined;
    try {
      descendantPid = await new Promise<number>((resolvePid, rejectPid) => {
        const timer = setTimeout(() => rejectPid(new Error('test descendant pid unavailable')), 5_000);
        leader.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          const pid = Number(chunk.toString().trim());
          if (!Number.isSafeInteger(pid) || pid <= 1) rejectPid(new Error('invalid descendant pid'));
          else resolvePid(pid);
        });
        leader.once('error', rejectPid);
      });
      expect(processExists(leader.pid)).toBe(true);
      expect(processExists(descendantPid)).toBe(true);

      forceKillTestProcessTree(leader.pid);
      expect(await waitUntilGone([leader.pid, descendantPid], 5_000)).toBe(true);
    } finally {
      forceKillTestProcessTree(descendantPid);
      forceKillTestProcessTree(leader.pid);
    }
  }, 15_000);

  it('refuses magic and invalid process identifiers', () => {
    expect(() => forceKillTestProcessTree(undefined)).not.toThrow();
    expect(() => forceKillTestProcessTree(-1)).not.toThrow();
    expect(() => forceKillTestProcessTree(0)).not.toThrow();
    expect(() => forceKillTestProcessTree(1)).not.toThrow();
  });

  it('requires every detached-process test to declare its Windows guard', () => {
    const unguarded = readdirSync('tests')
      .filter((name) => name.endsWith('.test.ts'))
      .filter((name) => {
        const source = readFileSync(`tests/${name}`, 'utf8');
        if (!source.includes('detached: true')) return false;
        return (
          !source.includes('forceKillTestProcessTree') &&
          !source.includes("it.skipIf(process.platform === 'win32')")
        );
      });
    expect(unguarded).toEqual([]);
  });
});
