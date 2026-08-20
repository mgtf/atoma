import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';

/**
 * `npm run viz:dev` must not leave a dev server behind on Ctrl-C.
 *
 * Measured 2026-08-18: an interrupted session left Vite listening on 5173
 * with PPID 1, so the next `npm run viz:dev` died with EADDRINUSE and the
 * port had to be reclaimed by hand.
 *
 * The launcher spawned both children `detached: true`, which puts them in
 * their own process groups — outside the terminal's foreground group. Their
 * only exit path was the launcher's own SIGTERM/SIGKILL cleanup, and file
 * logging from an instrumented launcher proved that cleanup never runs:
 * under `npm run` the heartbeat stops dead at Ctrl-C with no signal handler
 * and no `process.on('exit')` line, i.e. npm SIGKILLs the script. Whichever
 * child was slower to notice was orphaned holding its port. Vite happened to
 * survive on the reported machine (it exits by itself when the tty is
 * revoked); here the API server is the one that outlives the terminal.
 *
 * The fix keeps the children in the launcher's process group so the kernel
 * signals them directly. This test reproduces that boundary without a pty:
 * the launcher is spawned as its own group leader (standing in for the
 * terminal's foreground group), the group gets SIGINT exactly as a tty
 * delivers it, and the launcher is SIGKILLed the way npm kills it — so
 * nothing but the children's own signal disposition can free the ports.
 */
const API_PORT = 44_111;
const DEV_PORT = 45_173;

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function waitFor(want: boolean, ports: number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const states = await Promise.all(ports.map(isListening));
    if (states.every((open) => open === want)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('viz:dev — Ctrl-C frees both ports', () => {
  it('leaves no server behind when the launcher is killed the way npm kills it', async () => {
    expect(
      await waitFor(false, [API_PORT, DEV_PORT], 0),
      `ports ${API_PORT}/${DEV_PORT} busy before the test`
    ).toBe(true);

    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/viz-dev.mjs'], {
      // Own process group: this stands in for the terminal's foreground group.
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ATOMA_VIZ_API_PORT: String(API_PORT),
        ATOMA_VIZ_DEV_PORT: String(DEV_PORT),
      },
    });
    const group = child.pid ?? 0;
    expect(group).toBeGreaterThan(1);

    try {
      expect(await waitFor(true, [API_PORT, DEV_PORT], 45_000), 'both servers never came up').toBe(
        true
      );

      // A tty signals the whole foreground group; npm then SIGKILLs the script.
      process.kill(-group, 'SIGINT');
      process.kill(group, 'SIGKILL');

      expect(
        await waitFor(false, [API_PORT, DEV_PORT], 10_000),
        'a child outlived the launcher and kept its port'
      ).toBe(true);
    } finally {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The group is already gone on the passing path.
      }
      // A failing run leaks the very orphans under test; reclaim them so the
      // next run's precondition check is not poisoned by this one.
      for (const port of [API_PORT, DEV_PORT]) if (await isListening(port)) reclaim(port);
    }
  }, 70_000);
});

function reclaim(port: number): void {
  if (process.platform === 'win32') return;
  const found = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  for (const line of (found.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Best effort: the pid may already be gone.
      }
    }
  }
}
