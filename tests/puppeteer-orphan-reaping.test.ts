import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execSync } from 'node:child_process';

const posixIt = it.skipIf(process.platform === 'win32');

/**
 * Headless Chrome must die with its run, on the HARD exit path too.
 *
 * `validateHtmlTool` closed its shared browser through `sandbox.onCleanup`
 * — an async hook that only runs on the orderly path. A hard exit (the
 * burn-in harness group-killing a run at its wall-clock budget, the
 * build-app watchdog, a crash) skips it, and Chrome survives with its
 * whole helper fleet.
 *
 * Measured 2026-08-08: one web run killed at its 900s budget after 46
 * validations left its browser behind; 126 puppeteer processes (42
 * reparented to init, up to 22h old) had piled up, loading the machine
 * enough that the two runs after it blew their own budgets. A leak that
 * cascades into failures, not just waste.
 *
 * The fix registers `browser.process()` with `sandbox.trackChild`, putting
 * it under the same synchronous `process.on('exit')` SIGKILL that every
 * run_shell / server child already gets. This test drives the real thing:
 * a child process launches a browser, prints its pid, then `process.exit`s
 * WITHOUT calling cleanup — exactly the shape that leaked.
 */
describe('validate_html — the browser is reaped on a hard exit', () => {
  posixIt('kills headless Chrome when the run exits without cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-orphan-'));
    const script = join(dir, 'leak.mjs');
    const repo = process.cwd();
    // The child boots the tool the way a run does, forces the browser to
    // launch, prints its pid, and dies abruptly — no sandbox.cleanup().
    writeFileSync(
      script,
      `
import { ToolSandbox } from '${repo}/src/tools/sandbox.ts';
import { validateHtmlTool } from '${repo}/src/tools/builtin.ts';
const sandbox = new ToolSandbox(${JSON.stringify(dir)});
const tool = validateHtmlTool({ sandbox });
// about:blank is enough to force the shared browser to launch.
await tool.execute({ url: 'about:blank', waitMs: 10 }).catch(() => {});
const pids = [];
for (const c of sandbox.trackedChildPids()) pids.push(c);
console.log('PIDS:' + JSON.stringify(pids));
process.exit(0);   // hard exit — the leak's shape
`,
      'utf8'
    );

    const res = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 90_000, cwd: repo });
    const m = /PIDS:(\[.*\])/.exec(res.stdout ?? '');
    expect(m, `child did not report pids. stdout=${res.stdout} stderr=${res.stderr}`).toBeTruthy();
    const pids: number[] = JSON.parse(m![1]!);
    // The browser process must have been TRACKED at all — that is the fix.
    expect(pids.length).toBeGreaterThan(0);

    // …and the exit handler must have killed it. Give the OS a moment.
    const deadline = Date.now() + 5000;
    let alive: number[] = [];
    do {
      alive = pids.filter((pid) => {
        try {
          process.kill(pid, 0); // signal 0 = existence probe
          return true;
        } catch {
          return false;
        }
      });
    } while (alive.length > 0 && Date.now() < deadline);
    expect(alive, `orphaned pids still alive: ${alive}`).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  posixIt('the harness kill shape leaks NOTHING: detached child + group SIGTERM', async () => {
    // The faithful reproduction, and the measured reason the harness now
    // escalates instead of going straight to SIGKILL. Same shape as
    // burnin.ts (spawn detached, signal the whole group), A/B'd by hand:
    //   group SIGKILL  → 9 puppeteer processes leaked   (the old path)
    //   group SIGTERM  → 0                              (this path)
    // Nine is exactly what was left behind after the last web batch.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-sigterm-'));
    const script = join(dir, 'live.mjs');
    const repo = process.cwd();
    writeFileSync(
      script,
      `
import { ToolSandbox } from '${repo}/src/tools/sandbox.ts';
import { validateHtmlTool } from '${repo}/src/tools/builtin.ts';
const sandbox = new ToolSandbox(${JSON.stringify(dir)});
await validateHtmlTool({ sandbox }).execute({ url: 'about:blank', waitMs: 10 }).catch(() => {});
console.log('READY:' + JSON.stringify([...sandbox.trackedChildPids()]));
setInterval(() => {}, 1000);   // idle like a delivered run that started a server
`,
      'utf8'
    );

    const child = spawn('npx', ['tsx', script], {
      cwd: repo,
      detached: true, // exactly how burnin.ts spawns a run
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The browser processes THIS child owns, found by walking the live
    // process tree from its tracked browser PIDs. Not a machine-wide pgrep: under a fully
    // parallel suite the other browser-driving test files inflate and
    // deflate a global count between any two samples (measured 2026-08-31:
    // "leaked" came out at -6 because six unrelated Chromes had exited
    // since the baseline). Not the child's process GROUP either: puppeteer
    // launches Chrome detached into a group of its own, so the reap this
    // test proves travels through the child's exit handler, not through
    // group membership.
    const puppeteerDescendants = (browserRoots: number[]): number[] => {
      const rows = execSync('ps -eo pid=,ppid=,args=', { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' }));
      const owned = new Set(browserRoots);
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of rows) {
          if (owned.has(row.ppid) && !owned.has(row.pid)) {
            owned.add(row.pid);
            grew = true;
          }
        }
      }
      return rows
        .filter((row) => owned.has(row.pid))
        .map((row) => row.pid);
    };
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const upBy = Date.now() + 90_000;
    while (!/READY/.test(out) && Date.now() < upBy) await sleep(200);
    expect(/READY/.test(out), `child never booted a browser. out=${out}`).toBe(true);
    const reported = /READY:(\[.*\])/.exec(out);
    expect(reported, `child did not report browser PIDs: ${out}`).toBeTruthy();
    const browserRoots = JSON.parse(reported![1]!) as number[];
    expect(browserRoots.length).toBeGreaterThan(0);
    const browserPids = puppeteerDescendants(browserRoots);
    expect(browserPids.length).toBeGreaterThan(0); // the browser really is up

    process.kill(-child.pid!, 'SIGTERM'); // the harness's first signal

    const gone = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const deadline = Date.now() + 30_000;
    let leaked: number[] = [];
    do {
      leaked = browserPids.filter((pid) => !gone(pid));
      if (leaked.length === 0) break;
      await sleep(300);
    } while (Date.now() < deadline);
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    expect(leaked, `puppeteer pid(s) survived the graceful kill: ${leaked.join(', ')}`).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  }, 150_000);
});
