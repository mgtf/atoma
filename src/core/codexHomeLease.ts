import Database from 'better-sqlite3';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CROSS_PROCESS_LEASE_RETRY_MS = 25;
const CROSS_PROCESS_LEASE_SUFFIX = '.atoma-codex-home-lease.sqlite';
const CROSS_PROCESS_SLOT_PREFIX = '.atoma-codex-process-slot-';
export const PERSONAL_CODEX_PROFILE_ROOT_ENV = 'ATOMA_PERSONAL_CODEX_PROFILE_ROOT';
export const MAX_PERSONAL_CODEX_PROCESSES = 8;
export const CODEX_LEASE_WRAPPER_CAPACITY_EXIT_CODE = 75;
export const CODEX_LEASE_WRAPPER_UNAVAILABLE_EXIT_CODE = 127;

/**
 * Resolve the child-lifetime wrapper in both compiled and source entrypoints.
 * Development commands execute TypeScript directly with tsx, while release
 * entrypoints must remain independent of that development dependency.
 */
export function codexLeaseWrapperNodeArgs(args: readonly string[]): string[] {
  const sourceMode = import.meta.url.endsWith('.ts');
  const wrapper = fileURLToPath(
    new URL(sourceMode ? './codexLeaseWrapper.ts' : './codexLeaseWrapper.js', import.meta.url)
  );
  if (!sourceMode) return [wrapper, ...args];
  return ['--import', import.meta.resolve('tsx'), wrapper, ...args];
}

interface CodexHomeWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | null;
}

interface CodexHomeLock {
  readonly waiters: CodexHomeWaiter[];
}

const codexHomeLocks = new Map<string, CodexHomeLock>();

function cancelledProfileAccess(): Error {
  return new Error('Codex profile access was cancelled');
}

function codexHomeKey(profilePath: string): string {
  const resolved = path.resolve(profilePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function grantNextCodexHomeLease(key: string, lock: CodexHomeLock): void {
  while (lock.waiters.length > 0) {
    const waiter = lock.waiters.shift()!;
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    if (waiter.signal?.aborted) {
      waiter.reject(cancelledProfileAccess());
      continue;
    }
    waiter.resolve(codexHomeRelease(key, lock));
    return;
  }
  if (codexHomeLocks.get(key) === lock) codexHomeLocks.delete(key);
}

function codexHomeRelease(key: string, lock: CodexHomeLock): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    grantNextCodexHomeLease(key, lock);
  };
}

export function acquireLocalCodexHomeLease(
  profilePath: string,
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(cancelledProfileAccess());
  const key = codexHomeKey(profilePath);
  const existing = codexHomeLocks.get(key);
  if (!existing) {
    const lock: CodexHomeLock = { waiters: [] };
    codexHomeLocks.set(key, lock);
    return Promise.resolve(codexHomeRelease(key, lock));
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: CodexHomeWaiter = {
      resolve,
      reject,
      signal,
      onAbort: null,
    };
    if (signal) {
      const onAbort = (): void => {
        const index = existing.waiters.indexOf(waiter);
        if (index >= 0) existing.waiters.splice(index, 1);
        signal.removeEventListener('abort', onAbort);
        reject(cancelledProfileAccess());
      };
      Object.assign(waiter, { onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    existing.waiters.push(waiter);
  });
}

function tryAcquireLocalCodexHomeLease(profilePath: string): (() => void) | null {
  const key = codexHomeKey(profilePath);
  if (codexHomeLocks.has(key)) return null;
  const lock: CodexHomeLock = { waiters: [] };
  codexHomeLocks.set(key, lock);
  return codexHomeRelease(key, lock);
}

/**
 * Prefer a persistent sibling in the profile's private provider directory.
 * Its name remains derivable after the generation is deleted, closing the
 * cleanup/ENOENT race. A missing parent is a hard refusal: silently moving to
 * another lock namespace would let two processes disagree about ownership.
 */
export function codexHomeLeaseDatabasePath(profilePath: string): string {
  const resolved = path.resolve(profilePath);
  let parent: string;
  try {
    parent = realpathSync(path.dirname(resolved));
  } catch {
    throw new Error('Codex profile lease parent is unavailable');
  }
  const stableProfilePath = path.join(parent, path.basename(resolved));
  try {
    const stat = lstatSync(stableProfilePath);
    if (!stat.isDirectory()) throw new Error('Codex profile is not a directory');
    return `${realpathSync(stableProfilePath)}${CROSS_PROCESS_LEASE_SUFFIX}`;
  } catch (error) {
    // Deletion must not change the lock identity: a contender which captured
    // this CODEX_HOME before cleanup still resolves to the same sidecar.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return `${stableProfilePath}${CROSS_PROCESS_LEASE_SUFFIX}`;
    }
    throw new Error('Codex profile lease identity is unavailable');
  }
}

function tryAcquireCrossProcessCodexHomeLease(databasePath: string): (() => void) | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { timeout: 0 });
    db.pragma('busy_timeout = 0');
    if (process.platform !== 'win32') chmodSync(databasePath, 0o600);
    // The transaction itself is the lease. The OS releases it on crash, so
    // there is no stale PID, timestamp or lockfile ABA decision to recover.
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The acquisition already failed.
    }
    if ((error as { code?: unknown }).code === 'SQLITE_BUSY') return null;
    throw new Error('Codex profile lease could not be acquired');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.exec('ROLLBACK');
    } catch {
      // A profile cleanup may already have removed its generation. Closing
      // the handle still releases the kernel lock.
    } finally {
      db.close();
    }
  };
}

function waitForCrossProcessLease(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledProfileAccess());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancelledProfileAccess());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, CROSS_PROCESS_LEASE_RETRY_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireCrossProcessCodexHomeLease(
  profilePath: string,
  signal?: AbortSignal
): Promise<() => void> {
  const databasePath = codexHomeLeaseDatabasePath(profilePath);
  while (true) {
    if (signal?.aborted) throw cancelledProfileAccess();
    const release = tryAcquireCrossProcessCodexHomeLease(databasePath);
    if (release) return release;
    await waitForCrossProcessLease(signal);
  }
}

/**
 * Serialize CODEX_HOME both within this Node process and against app-server
 * or run children owned by another process. SQLite's transaction is released
 * by the OS after a crash; no stale lockfile recovery is needed.
 */
export async function acquireCodexHomeLease(
  profilePath: string,
  signal?: AbortSignal
): Promise<() => void> {
  const releaseLocal = await acquireLocalCodexHomeLease(profilePath, signal);
  try {
    const releaseCrossProcess = await acquireCrossProcessCodexHomeLease(profilePath, signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCrossProcess();
      releaseLocal();
    };
  } catch (error) {
    releaseLocal();
    throw error;
  }
}

export function tryAcquireCodexHomeLease(profilePath: string): (() => void) | null {
  const releaseLocal = tryAcquireLocalCodexHomeLease(profilePath);
  if (!releaseLocal) return null;
  try {
    const databasePath = codexHomeLeaseDatabasePath(profilePath);
    const releaseCrossProcess = tryAcquireCrossProcessCodexHomeLease(databasePath);
    if (!releaseCrossProcess) {
      releaseLocal();
      return null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCrossProcess();
      releaseLocal();
    };
  } catch (error) {
    releaseLocal();
    throw error;
  }
}

/**
 * Reserve one process seat shared by every Atoma server generation.
 *
 * One SQLite transaction per seat gives us a bounded pool while preserving
 * crash cleanup. The files live in the private account-profile root, so a
 * replacement server observes wrappers that survived its predecessor.
 */
export function tryAcquirePersonalCodexProcessSlot(
  profilesRoot: string
): (() => void) | null {
  let root: string;
  try {
    const resolved = path.resolve(profilesRoot);
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Codex profile root is not a directory');
    }
    root = realpathSync(resolved);
  } catch {
    throw new Error('Codex profile process capacity root is unavailable');
  }
  for (let index = 0; index < MAX_PERSONAL_CODEX_PROCESSES; index++) {
    const release = tryAcquireCrossProcessCodexHomeLease(
      path.join(root, `${CROSS_PROCESS_SLOT_PREFIX}${index}.sqlite`)
    );
    if (release) return release;
  }
  return null;
}
