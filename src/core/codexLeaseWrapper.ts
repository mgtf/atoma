/**
 * Child-lifetime holder for a CODEX_HOME lease.
 *
 * The Atoma process spawns this wrapper as a detached process-group leader;
 * the real Codex CLI stays in that group. If Atoma crashes, this process and
 * its SQLite transaction survive with Codex, so a replacement server cannot
 * start another child on the same auth.json. Normal timeout/cancel kills the
 * whole group and releases the lease only after Codex closes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  acquireCodexHomeLease,
  CODEX_LEASE_WRAPPER_CAPACITY_EXIT_CODE,
  CODEX_LEASE_WRAPPER_UNAVAILABLE_EXIT_CODE,
  PERSONAL_CODEX_PROFILE_ROOT_ENV,
  tryAcquirePersonalCodexProcessSlot,
} from './codexHomeLease.js';

const forwardedSignals = ['SIGINT', 'SIGTERM'] as const;
const FORCE_KILL_AFTER_MS = 1_000;

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have failed before becoming its own group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // It was already reaped.
  }
}

async function run(): Promise<void> {
  const profile = process.env['CODEX_HOME']?.trim();
  if (!profile) throw new Error('CODEX_HOME is required');
  const profilesRoot = process.env[PERSONAL_CODEX_PROFILE_ROOT_ENV]?.trim();
  if (!profilesRoot) throw new Error('personal Codex profile root is required');

  const acquisition = new AbortController();
  let child: ChildProcess | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const forward = (signal: NodeJS.Signals): void => {
    acquisition.abort();
    if (!child) return;
    signalChildTree(child, signal);
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      if (child) signalChildTree(child, 'SIGKILL');
    }, FORCE_KILL_AFTER_MS);
    forceKillTimer.unref?.();
  };
  for (const signal of forwardedSignals) {
    const handler = (): void => forward(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const release = await acquireCodexHomeLease(profile, acquisition.signal);
  let releaseProcessSlot: (() => void) | null = null;
  try {
    if (acquisition.signal.aborted) return;
    releaseProcessSlot = tryAcquirePersonalCodexProcessSlot(profilesRoot);
    if (!releaseProcessSlot) {
      process.stderr.write('[atoma codex lease] Personal Codex process capacity is exhausted\n');
      process.exitCode = CODEX_LEASE_WRAPPER_CAPACITY_EXIT_CODE;
      return;
    }
    const childEnv = { ...process.env };
    delete childEnv[PERSONAL_CODEX_PROFILE_ROOT_ENV];
    const spawned = spawn('codex', process.argv.slice(2), {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
      // Codex gets its own group. Atoma signals only this wrapper; the wrapper
      // then terminates and reaps Codex's whole tree before releasing SQLite.
      detached: process.platform !== 'win32',
    });
    child = spawned;
    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      unavailable: boolean;
    }>(
      (resolve) => {
        spawned.once('error', (error) => {
          // ENOENT has no live process and may not produce a useful close in
          // test doubles. A spawned process keeps the lease until real close.
          if (spawned.pid === undefined) {
            resolve({
              code: 1,
              signal: null,
              unavailable: (error as NodeJS.ErrnoException).code === 'ENOENT',
            });
          }
        });
        spawned.once('close', (code, signal) =>
          resolve({ code, signal, unavailable: false })
        );
      }
    );
    if (outcome.unavailable) {
      process.stderr.write('[atoma codex lease] Codex CLI is unavailable\n');
      process.exitCode = CODEX_LEASE_WRAPPER_UNAVAILABLE_EXIT_CODE;
    } else {
      process.exitCode = outcome.code ?? (outcome.signal ? 1 : 0);
    }
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    releaseProcessSlot?.();
    release();
    for (const signal of forwardedSignals) {
      const handler = handlers.get(signal);
      if (handler) process.off(signal, handler);
    }
  }
}

void run().catch(() => {
  // Stable wrapper-owned text only. Provider/spawn diagnostics may contain a
  // home path, proxy URL or account detail and must not enter parent traces.
  process.stderr.write('[atoma codex lease] Codex transport could not start\n');
  process.exitCode = 1;
});
