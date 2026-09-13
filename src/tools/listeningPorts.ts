import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';

/**
 * WHO HOLDS A LISTENING SOCKET, asked of the operating system.
 *
 * A live process does not prove it still holds the port it once bound: a
 * server can `close()` its listener and stay alive on a timer while a
 * stranger binds the same port (reproduced with a real browser, 2026-09-13).
 * The only witness of current ownership is the kernel's socket table, so this
 * module reads it — `/proc` on Linux, where the worker image has no `lsof`,
 * and `lsof` on darwin, which has no `/proc`. Anywhere else it answers
 * `undefined`, and the caller fails CLOSED: an ownership it cannot prove is an
 * ownership it does not assert.
 *
 * `src/tools` imports nothing outside node builtins and its own siblings;
 * this module keeps that property.
 */

const EXEC_TIMEOUT_MS = 3_000;

function run(cmd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      // lsof exits 1 when nothing matches; that is an empty answer, not a
      // failure of the query. A missing binary or a timeout is a failure.
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(undefined);
      if (err && (err as { killed?: boolean }).killed) return resolve(undefined);
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** Socket inodes in LISTEN state on `port`, from /proc/net/tcp and tcp6. */
function linuxListeningInodes(port: number): Set<string> | undefined {
  const inodes = new Set<string>();
  let sawTable = false;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    sawTable = true;
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      if (cols.length < 10) continue;
      const local = cols[1]!;
      const state = cols[3]!;
      if (state !== '0A') continue;
      const portHex = local.slice(local.lastIndexOf(':') + 1);
      if (parseInt(portHex, 16) !== port) continue;
      inodes.add(cols[9]!);
    }
  }
  return sawTable ? inodes : undefined;
}

function linuxPidsHoldingInodes(inodes: Set<string>): number[] {
  if (inodes.size === 0) return [];
  const wanted = new Set([...inodes].map((i) => `socket:[${i}]`));
  const out: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue; // another user's process, or gone
    }
    for (const fd of fds) {
      try {
        if (wanted.has(readlinkSync(`${fdDir}/${fd}`))) {
          out.push(Number(entry));
          break;
        }
      } catch {
        /* fd closed between readdir and readlink */
      }
    }
  }
  return out;
}

/**
 * Pids that hold a TCP socket in LISTEN state on `port` right now.
 * `undefined` when this platform cannot answer — callers fail closed.
 */
export async function pidsListeningOn(port: number): Promise<number[] | undefined> {
  if (process.platform === 'linux') {
    const inodes = linuxListeningInodes(port);
    return inodes ? linuxPidsHoldingInodes(inodes) : undefined;
  }
  if (process.platform === 'darwin') {
    const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    if (out === undefined) return undefined;
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const m = /^p(\d+)$/.exec(line.trim());
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  }
  return undefined;
}

/** The process group of `pid`, or `undefined` when it cannot be read. */
export async function processGroupOf(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // `pid (comm) state ppid pgrp ...` — comm may contain spaces/parens, so
      // split after the LAST closing paren.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const pgrp = Number(rest[2]);
      return Number.isFinite(pgrp) ? pgrp : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    const out = await run('ps', ['-o', 'pgid=', '-p', String(pid)]);
    if (out === undefined) return undefined;
    const pgid = Number(out.trim());
    return Number.isFinite(pgid) && out.trim().length > 0 ? pgid : undefined;
  }
  return undefined;
}

/**
 * Does `pid`, or a process in the group it leads, hold a LISTEN socket on
 * `port` right now? `false` also when the platform cannot tell.
 */
export async function processHoldsListeningPort(pid: number, port: number): Promise<boolean> {
  const holders = await pidsListeningOn(port);
  if (holders === undefined || holders.length === 0) return false;
  if (holders.includes(pid)) return true;
  // Servers we spawn are detached, so they LEAD their process group
  // (pgid === pid); a worker the server forked holds the socket on its behalf.
  for (const holder of holders) {
    if ((await processGroupOf(holder)) === pid) return true;
  }
  return false;
}
