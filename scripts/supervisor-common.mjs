// Shared plumbing for the out-of-product supervisor stages (docs/supervisor-design.md):
// the analyst (scripts/analyst-watch.mjs) and the mender (scripts/mender.mjs).
//
// What lives here is what BOTH stages must agree on, or they drift apart on
// the one question that matters for quota and for the machine-dedication rule:
// "is a run active right now?". One predicate, two callers.
//
// Everything here is Node-only and has no TypeScript project; the eslint
// config treats scripts/**/*.mjs as plain-Node analysis code.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Mirrors the viz's ABANDONED_AFTER_MS: a run silent this long is not live. */
export const LIVE_WINDOW_MS = 12 * 60 * 1000;

/**
 * Same convention as the repo's operator source launchers (src/cli/loadDotenv):
 * checkout `.env` FILLS UNSET KEYS ONLY — the shell environment always wins, so
 * an operator export overrides the file and a deployed service that injects
 * real env vars never reads it. Keeps provider tokens out of shell history
 * locally without inventing a second precedence rule.
 */
export function fillEnvFromDotenv(root = repoRoot) {
  let text;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = /^(['"]).*\1$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
    process.env[key] = value;
  }
}

export function makeLogger(tag) {
  return {
    log: (message) => console.log(`[${tag} ${new Date().toISOString()}] ${message}`),
    warn: (message) => console.warn(`[${tag} ${new Date().toISOString()}] WARN ${message}`),
  };
}

// --- bounded text ---------------------------------------------------------------

export function truncate(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const head = Math.ceil(max * 0.75);
  const tail = Math.floor(max * 0.25);
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)} …[truncated ${dropped} chars]… ${text.slice(text.length - tail)}`;
}

export function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) attempts.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* next attempt */
    }
  }
  return null;
}

/** The structured object out of a `claude -p --output-format json` wrapper. */
export function extractStructured(wrapper) {
  if (wrapper && typeof wrapper === 'object') {
    if (wrapper.structured_output && typeof wrapper.structured_output === 'object') {
      return wrapper.structured_output;
    }
    if (wrapper.structuredOutput && typeof wrapper.structuredOutput === 'object') {
      return wrapper.structuredOutput;
    }
    if (typeof wrapper.result === 'string') return parseLooseJson(wrapper.result);
    if (wrapper.result && typeof wrapper.result === 'object') return wrapper.result;
  }
  return null;
}

/**
 * What the session actually consumed, per model, in the same shape the run
 * traces already use for `totals.perModel`. `claude -p` reports a `modelUsage`
 * map and it is never one model: the main loop's model plus the harness's
 * auxiliary calls. Recording the requested alias instead would name one model
 * and price another — the lie `servedModel` exists to prevent in the traces.
 */
export function servedModels(wrapper) {
  const usage = wrapper?.modelUsage;
  if (!usage || typeof usage !== 'object') return null;
  const entries = Object.entries(usage).map(([model, u]) => ({
    model,
    costUsd: typeof u?.costUSD === 'number' ? u.costUSD : null,
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: u?.cacheCreationInputTokens ?? 0,
  }));
  entries.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  return entries.length > 0 ? entries : null;
}

/**
 * An explicit model id, as opposed to a moving alias like `sonnet`. Non-Claude
 * ids (glm-5.3, …) reached through a base-URL override are pins too — the
 * alias set is the CLI's own resolution vocabulary, not a vendor test.
 */
export const MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'default']);
export function looksPinned(model) {
  return !MODEL_ALIASES.has(model);
}

// --- activity detection: is a run executing right now? ---------------------------

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** `runs/index.json` as an array, `[]` when absent, `null` on a torn read. */
export function readRunIndex(runsDir) {
  const indexPath = join(runsDir, 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // torn mid-write read; the next poll will see a whole file
    return null;
  }
}

export function isEntryLive(entry, now, runsDir) {
  if (entry.endedAt) return false;
  const activity = Math.max(
    Date.parse(entry.startedAt) || 0,
    typeof entry.lastEventAt === 'number' ? entry.lastEventAt : 0,
    mtimeMs(join(runsDir, `${entry.id}.json`))
  );
  return now - activity <= LIVE_WINDOW_MS;
}

export function defaultLeaseDbPath() {
  return process.env['ATOMA_MCP_RUN_LOCK'] ?? join(homedir(), '.atoma', 'mcp-run-lock.db');
}

/** true / false, or null when the lease file exists but cannot be read. */
export async function leaseHeld(leaseDbPath, warn = () => {}) {
  if (!existsSync(leaseDbPath)) return false;
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(leaseDbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT owner_pid FROM mcp_run_lease').all();
      return rows.some((row) => processAlive(Number(row.owner_pid)));
    } finally {
      db.close();
    }
  } catch (error) {
    warn(`lease read failed (${error?.message ?? error}); treating as unknown`);
    return null; // unknown — the index check remains the primary signal
  }
}

/**
 * THE ONE IDLE PREDICATE both stages gate on. Activity = a live entry in the
 * operator index (same window as the viz) OR a held MCP run lease. A torn
 * index read counts as active: a run is writing it.
 */
export async function anyRunActive({ runsDir, leaseDbPath, warn }) {
  const entries = readRunIndex(runsDir);
  if (entries === null) return true;
  const now = Date.now();
  if (entries.some((entry) => isEntryLive(entry, now, runsDir))) return true;
  return (await leaseHeld(leaseDbPath, warn)) === true;
}

// --- one headless claude session ---------------------------------------------------

/**
 * A command spec: a whitespace-separated string whose first token is the
 * executable. A first token ending in `.mjs`/`.js` runs under the current
 * Node — that is how the pipeline tests substitute every external command
 * (claude, gh, npm) without a shell shim, on every platform. `npm`/`npx` are
 * `.cmd` shims on Windows, which Node refuses to spawn without a shell; only
 * those two constant defaults ever get one.
 */
export function resolveCommand(spec) {
  const tokens = String(spec).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('empty command spec');
  const [head, ...rest] = tokens;
  if (/\.(mjs|cjs|js)$/.test(head)) {
    return { command: process.execPath, args: [head, ...rest], shell: false };
  }
  const needsShell = process.platform === 'win32' && /^(npm|npx)$/.test(head);
  return { command: head, args: rest, shell: needsShell };
}

/**
 * Run a command to completion with a wall-clock timeout, capturing both
 * streams. Never throws on a non-zero exit — the caller reads `code`; it
 * throws only when the process cannot be started or the timeout fires.
 */
export function runCommand(spec, extraArgs, { cwd, env, timeoutMs, input, onLog }) {
  const resolved = resolveCommand(spec);
  const args = [...resolved.args, ...extraArgs];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(resolved.command, args, {
      cwd,
      env: env ?? process.env,
      shell: resolved.shell,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onLog?.(`command exceeded ${timeoutMs}ms; terminating: ${resolved.command} ${args[0] ?? ''}`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      rejectRun(new Error(`timeout after ${timeoutMs}ms: ${resolved.command} ${args.slice(0, 3).join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/**
 * The child claude session's environment. A provider override is scoped HERE,
 * never exported globally: raw ANTHROPIC_* at platform launch would reroute
 * the runs' claude-cli transport along with the supervisor stage.
 */
export function providerChildEnv({ baseUrl, authToken }) {
  const env = { ...process.env };
  if (baseUrl) env['ANTHROPIC_BASE_URL'] = baseUrl;
  if (authToken) {
    env['ANTHROPIC_AUTH_TOKEN'] = authToken;
    // A dead ANTHROPIC_API_KEY left in the child env can shadow the token at
    // the gateway. Dropped from the child only.
    delete env['ANTHROPIC_API_KEY'];
  }
  return env;
}
