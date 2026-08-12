/**
 * Cross-process lease for the MCP run slot.
 *
 * `src/mcp/run.ts` also keeps an in-memory `inFlight` record for status and
 * cancellation. That record cannot coordinate two MCP server processes, so
 * the filesystem lease is the machine-wide authority. The default path lives
 * beside the shared build workspace under ~/.atoma.
 *
 * Acquisition is a hard-link of a fully-written temporary file. `open(...,
 * 'wx')` would expose an empty lock between create and write, letting a second
 * process misclassify an in-progress acquisition as corrupt. Linking complete
 * bytes makes the publication atomic without a dependency.
 */

import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RUN_KILL_GRACE_MS, signalRunProcessGroup } from '../cli/burnin.js';

interface RunLockOwner {
  readonly version: 1;
  readonly token: string;
  readonly runId: string;
  readonly ownerPid: number;
  readonly acquiredAt: string;
  readonly childPid?: number;
}

export interface RunLease {
  readonly path: string;
  /** Best-effort crash-recovery metadata; never throws into the run path. */
  attachChild(pid: number): void;
  /** Token-checked: an old owner can never delete a successor's lease. */
  release(): void;
}

export type RunLeaseAcquirer = (runId: string) => RunLease;

export class RunLockBusyError extends Error {
  constructor(
    message: string,
    readonly owner?: RunLockOwner
  ) {
    super(message);
    this.name = 'RunLockBusyError';
  }
}

export function mcpRunLockPath(): string {
  return resolve(
    process.env['ATOMA_MCP_RUN_LOCK'] ?? join(homedir(), '.atoma', 'mcp-run.lock')
  );
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function readOwner(path: string): RunLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunLockOwner>;
    if (
      value.version !== 1 ||
      typeof value.token !== 'string' ||
      typeof value.runId !== 'string' ||
      typeof value.ownerPid !== 'number' ||
      typeof value.acquiredAt !== 'string' ||
      (value.childPid !== undefined && typeof value.childPid !== 'number')
    ) {
      return undefined;
    }
    return value as RunLockOwner;
  } catch {
    return undefined;
  }
}

function processExists(pid: number, group = false): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but this process cannot signal it.
    return errorCode(err) === 'EPERM';
  }
}

function writeTemp(path: string, owner: RunLockOwner): string {
  const temp = `${path}.${process.pid}.${owner.token}.tmp`;
  writeFileSync(temp, JSON.stringify(owner), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return temp;
}

function removeIfOwned(path: string, token: string): void {
  const current = readOwner(path);
  if (!current || current.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function publishNew(path: string, owner: RunLockOwner): void {
  const temp = writeTemp(path, owner);
  try {
    linkSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
}

function replaceOwned(path: string, owner: RunLockOwner): void {
  const current = readOwner(path);
  if (!current || current.token !== owner.token) return;
  const temp = writeTemp(path, owner);
  try {
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* rename consumed it */
    }
  }
}

/**
 * A previous MCP server died while its detached run survived. Start the same
 * SIGTERM → grace → SIGKILL sequence a live owner would have used, keep the
 * lease occupied during the grace window, and make the caller retry.
 */
function beginOrphanCleanup(path: string, owner: RunLockOwner): void {
  if (owner.childPid === undefined) return;
  signalRunProcessGroup(owner.childPid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (processExists(owner.childPid!, true)) {
      signalRunProcessGroup(owner.childPid!, 'SIGKILL');
    }
    removeIfOwned(path, owner.token);
  }, RUN_KILL_GRACE_MS);
  timer.unref();
}

export function acquireRunLease(runId: string, path = mcpRunLockPath()): RunLease {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    const owner: RunLockOwner = {
      version: 1,
      token: randomUUID(),
      runId,
      ownerPid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      publishNew(path, owner);
      let current = owner;
      return {
        path,
        attachChild(pid) {
          current = { ...current, childPid: pid };
          try {
            replaceOwned(path, current);
          } catch (err) {
            process.stderr.write(
              `[atoma-mcp] could not attach child ${pid} to run lease: ${
                err instanceof Error ? err.message : String(err)
              }\n`
            );
          }
        },
        release() {
          removeIfOwned(path, current.token);
        },
      };
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
    }

    const existing = readOwner(path);
    if (!existing) {
      throw new RunLockBusyError(
        `run lock ${path} is unreadable; confirm no run is active, then remove it manually`
      );
    }
    if (processExists(existing.ownerPid)) {
      throw new RunLockBusyError(
        `another MCP server owns the run slot (${existing.runId}, pid ${existing.ownerPid}, since ${existing.acquiredAt})`,
        existing
      );
    }
    if (existing.childPid !== undefined && processExists(existing.childPid, true)) {
      beginOrphanCleanup(path, existing);
      throw new RunLockBusyError(
        `the previous MCP server died while run ${existing.runId} survived (process group ${existing.childPid}); cleanup started, retry after ${RUN_KILL_GRACE_MS}ms`,
        existing
      );
    }

    // Dead owner and no live child: token-check before removing, then retry
    // the atomic publication. A concurrent recovery may win; the next loop
    // observes its complete owner record.
    removeIfOwned(path, existing.token);
  }

  throw new RunLockBusyError(`could not acquire run lock ${path} after stale-owner recovery`);
}
