#!/usr/bin/env node
/**
 * Quota-free deployment drain.
 *
 * A deployment may replace code and the mutable worker tag only after every
 * run and preview has stopped. In hold mode this process also occupies the
 * machine-global run lease, so no run can enter after the check and before
 * systemd stops the old server.
 */
import Database from 'better-sqlite3';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeDbPath } from '../core/stores.js';
import {
  acquireRunLeaseWithoutRecovery,
  mcpRunLockPath,
  peekRunLease,
  type RunLease,
} from '../mcp/runLock.js';

export interface DeploymentPreflightOptions {
  readonly dbPath?: string;
  readonly runLockPath?: string;
  /** The caller already owns the lease, so do not report that row as a blocker. */
  readonly ignoreRunLease?: boolean;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table)
  );
}

/** Read-only facts that make replacing the running generation unsafe. */
export function deploymentBlockers(options: DeploymentPreflightOptions = {}): string[] {
  const blockers: string[] = [];
  const lockPath = resolve(options.runLockPath ?? mcpRunLockPath());
  if (!options.ignoreRunLease) {
    const owner = peekRunLease(lockPath);
    if (owner) {
      blockers.push(
        `run lease ${owner.runId} is held by pid ${owner.ownerPid} since ${owner.acquiredAt}`
      );
    }
  }

  const dbPath = resolve(options.dbPath ?? storeDbPath());
  if (!existsSync(dbPath)) return blockers;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (tableExists(db, 'project_runs')) {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM project_runs WHERE status IN ('queued','running')")
        .get() as { count: number };
      if (row.count > 0) blockers.push(`${row.count} project run(s) are queued or running`);
    }
    if (tableExists(db, 'project_run_preview_instances')) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM project_run_preview_instances
           WHERE state IN ('starting','ready','stopping')`
        )
        .get() as { count: number };
      if (row.count > 0) blockers.push(`${row.count} result preview(s) still own runtime`);
    }
  } finally {
    db.close();
  }
  return blockers;
}

interface CliOptions extends DeploymentPreflightOptions {
  readonly help: boolean;
  readonly hold: boolean;
  readonly parentPid?: number;
  readonly readyFile?: string;
  readonly releaseFile?: string;
  readonly admissionMarker?: string;
}

const USAGE = `atoma deploy preflight — refuse activation while runtime work is live

usage:
  npm run deploy:preflight
  npm run deploy:preflight -- --hold --parent-pid <pid> --ready-file <path> --release-file <path> --admission-marker <path>
  npm run deploy:preflight -- --db <path> --run-lock <path>

--hold claims the existing machine-global run slot without stale recovery,
then waits until the release file appears or the parent process exits.
`;

function parseArgs(argv: readonly string[]): CliOptions {
  let dbPath: string | undefined;
  let runLockPath: string | undefined;
  let parentPid: number | undefined;
  let readyFile: string | undefined;
  let releaseFile: string | undefined;
  let admissionMarker: string | undefined;
  let hold = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const take = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--hold') hold = true;
    else if (arg === '--db') dbPath = take();
    else if (arg === '--run-lock') runLockPath = take();
    else if (arg === '--parent-pid') {
      const raw = take();
      if (!/^\d+$/.test(raw) || Number(raw) <= 1) throw new Error('--parent-pid must be an integer above 1');
      parentPid = Number(raw);
    } else if (arg === '--ready-file') readyFile = take();
    else if (arg === '--release-file') releaseFile = take();
    else if (arg === '--admission-marker') admissionMarker = take();
    else throw new Error(`unknown deploy preflight argument: ${arg}`);
  }
  if (admissionMarker && !hold) {
    throw new Error('--admission-marker requires --hold');
  }
  return {
    help,
    hold,
    ...(dbPath ? { dbPath } : {}),
    ...(runLockPath ? { runLockPath } : {}),
    ...(parentPid ? { parentPid } : {}),
    ...(readyFile ? { readyFile } : {}),
    ...(releaseFile ? { releaseFile } : {}),
    ...(admissionMarker ? { admissionMarker } : {}),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EPERM'
    );
  }
}

async function waitForRelease(parentPid: number, releaseFile: string): Promise<void> {
  await new Promise<void>((resolveWait) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolveWait();
    };
    const timer = setInterval(() => {
      if (existsSync(releaseFile) || !processExists(parentPid)) finish();
    }, 250);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  let lease: RunLease | undefined;
  try {
    if (options.hold) {
      if (
        !options.parentPid ||
        !options.readyFile ||
        !options.releaseFile ||
        !options.admissionMarker
      ) {
        throw new Error(
          '--hold requires --parent-pid, --ready-file, --release-file and --admission-marker'
        );
      }
      lease = acquireRunLeaseWithoutRecovery(
        `deployment:${process.pid}`,
        resolve(options.runLockPath ?? mcpRunLockPath())
      );
    }
    const blockers = deploymentBlockers({ ...options, ignoreRunLease: options.hold });
    if (blockers.length > 0) {
      for (const blocker of blockers) process.stderr.write(`deployment blocked: ${blocker}\n`);
      process.exitCode = 75;
      return;
    }
    if (!options.hold) {
      process.stdout.write('deployment preflight clear\n');
      return;
    }

    writeFileSync(resolve(options.readyFile!), 'ready\n', { flag: 'wx' });
    process.stdout.write('deployment lease acquired\n');
    await waitForRelease(options.parentPid!, resolve(options.releaseFile!));
  } catch (error) {
    process.stderr.write(`deployment preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 75;
  } finally {
    lease?.release();
    if (options.hold && options.admissionMarker) {
      try {
        rmSync(resolve(options.admissionMarker), { force: true });
      } catch (error) {
        process.stderr.write(
          `deployment marker cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) await main();
