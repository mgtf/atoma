import { spawn } from 'node:child_process';
import type { ServedModelUsage } from '../contracts/supervisorVerdict.js';

/**
 * ONE HEADLESS SESSION, AND THE PROCESSES AROUND IT.
 *
 * Both supervisor stages drive `claude -p` with a JSON Schema enforced on the
 * output, a spend ceiling and a wall clock, and both read the same wrapper
 * back: the structured object, what the session actually consumed per model,
 * and its cost. This module is that shared shape, plus the two things it
 * needs from the host: a way to run an external command to completion, and
 * a way to name which provider the child session talks to.
 *
 * COMMAND SPECS ARE THE TEST SEAM. `claude`, `gh`, `npm ci`, `npx vitest run`
 * and `npm run check` are resolved from a whitespace-separated string whose
 * first token may be a `.mjs`/`.js` file — then it runs under the current
 * Node. That is how the pipeline tests substitute every external program on
 * every platform without a shell shim. `npm`/`npx` are `.cmd` shims on
 * Windows, which Node refuses to spawn without a shell; only those two
 * constant defaults ever get one, never a user-supplied spec.
 *
 * PROVIDERS ARE READ AS SETS. A model id paired with another stage's base
 * URL would send a Claude id to a GLM endpoint, so the three variables of one
 * stage are read together, the analyst's set is the mender's fallback (same
 * operator-owned subscription, same quota rationale), and the default is the
 * login subscription with a PINNED id — an alias resolves to a different
 * model next month and the recorded cost silently stops meaning what it said.
 */

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export function resolveCommand(spec: string): CommandSpec {
  const tokens = spec.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0];
  if (!head) throw new Error('empty command spec');
  const rest = tokens.slice(1);
  if (/\.(mjs|cjs|js)$/.test(head)) {
    return { command: process.execPath, args: [head, ...rest], shell: false };
  }
  const needsShell = process.platform === 'win32' && /^(npm|npx)$/.test(head);
  return { command: head, args: rest, shell: needsShell };
}

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly input?: string;
  readonly onLog?: (line: string) => void;
}

/**
 * Run to completion with a wall clock, capturing both streams. A non-zero
 * exit is a RESULT the caller reads, not a throw; the promise rejects only
 * when the process cannot start or the timeout fires.
 */
export function runCommand(
  spec: string,
  extraArgs: readonly string[],
  options: RunCommandOptions
): Promise<CommandResult> {
  const resolved = resolveCommand(spec);
  const args = [...resolved.args, ...extraArgs];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(resolved.command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: resolved.shell,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.onLog?.(`command exceeded ${options.timeoutMs}ms; terminating: ${resolved.command}`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      rejectRun(new Error(`timeout after ${options.timeoutMs}ms: ${resolved.command} ${args.slice(0, 3).join(' ')}`));
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => (stderr += String(chunk)));
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
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/* ────────────────────────────── providers ────────────────────────────── */

export type ProviderSource = 'mender' | 'analyst' | 'default';

export interface SupervisorProvider {
  readonly model: string;
  readonly baseUrl: string | null;
  readonly authToken: string | null;
  readonly source: ProviderSource;
}

/** Pinned because an alias drifts under the measurement (see module doc). */
export const DEFAULT_SUPERVISOR_MODEL = 'claude-sonnet-5';

const ANALYST_VARS = ['ATOMA_ANALYST_MODEL', 'ATOMA_ANALYST_BASE_URL', 'ATOMA_ANALYST_AUTH_TOKEN'] as const;
const MENDER_VARS = ['ATOMA_MENDER_MODEL', 'ATOMA_MENDER_BASE_URL', 'ATOMA_MENDER_AUTH_TOKEN'] as const;

function providerSet(
  env: NodeJS.ProcessEnv,
  names: readonly [string, string, string],
  source: ProviderSource
): SupervisorProvider | null {
  if (!names.some((name) => env[name] !== undefined)) return null;
  return {
    model: env[names[0]] ?? DEFAULT_SUPERVISOR_MODEL,
    baseUrl: env[names[1]] ?? null,
    authToken: env[names[2]] ?? null,
    source,
  };
}

const DEFAULT_PROVIDER: SupervisorProvider = {
  model: DEFAULT_SUPERVISOR_MODEL,
  baseUrl: null,
  authToken: null,
  source: 'default',
};

export function analystProvider(env: NodeJS.ProcessEnv = process.env): SupervisorProvider {
  return providerSet(env, ANALYST_VARS, 'analyst') ?? DEFAULT_PROVIDER;
}

/** The mender's own set, else the analyst's set, else the default — never a mix. */
export function menderProvider(env: NodeJS.ProcessEnv = process.env): SupervisorProvider {
  return providerSet(env, MENDER_VARS, 'mender') ?? providerSet(env, ANALYST_VARS, 'analyst') ?? DEFAULT_PROVIDER;
}

/**
 * The child session's environment. A provider override is scoped HERE and
 * never exported at platform launch: raw `ANTHROPIC_*` in the process env
 * would reroute the runs' claude-cli transport along with the supervisor.
 */
export function providerChildEnv(
  provider: SupervisorProvider,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  if (provider.baseUrl) child['ANTHROPIC_BASE_URL'] = provider.baseUrl;
  if (provider.authToken) {
    child['ANTHROPIC_AUTH_TOKEN'] = provider.authToken;
    // A stale ANTHROPIC_API_KEY left in the child can shadow the token at the
    // gateway. Dropped from the child only.
    delete child['ANTHROPIC_API_KEY'];
  }
  return child;
}

/** The CLI's own alias vocabulary; a non-Claude id behind a base URL is a pin too. */
export const MODEL_ALIASES: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku', 'fable', 'default']);

export function looksPinned(model: string): boolean {
  return !MODEL_ALIASES.has(model);
}

/* ─────────────────────────── the session wrapper ─────────────────────────── */

export function parseLooseJson(text: string): unknown {
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The structured object out of a `claude -p --output-format json` wrapper. */
export function extractStructured(wrapper: unknown): unknown {
  const row = asRecord(wrapper);
  if (!row) return null;
  if (asRecord(row['structured_output'])) return row['structured_output'];
  if (asRecord(row['structuredOutput'])) return row['structuredOutput'];
  if (typeof row['result'] === 'string') return parseLooseJson(row['result']);
  if (asRecord(row['result'])) return row['result'];
  return null;
}

/**
 * What the session ACTUALLY consumed, per model. `claude -p` reports a
 * `modelUsage` map and it is never one model: the main loop's model plus the
 * harness's auxiliary calls, all inside `total_cost_usd`.
 */
export function servedModels(wrapper: unknown): ServedModelUsage[] | null {
  const usage = asRecord(asRecord(wrapper)?.['modelUsage']);
  if (!usage) return null;
  const entries = Object.entries(usage).map(([model, raw]) => {
    const u = asRecord(raw) ?? {};
    const num = (key: string): number => (typeof u[key] === 'number' ? (u[key]) : 0);
    return {
      model,
      costUsd: typeof u['costUSD'] === 'number' ? (u['costUSD']) : null,
      inputTokens: num('inputTokens'),
      outputTokens: num('outputTokens'),
      cacheReadInputTokens: num('cacheReadInputTokens'),
      cacheCreationInputTokens: num('cacheCreationInputTokens'),
    };
  });
  entries.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  return entries.length > 0 ? entries : null;
}

export interface SessionUsage {
  readonly served: ServedModelUsage[] | null;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly turns: number | null;
  readonly sessionId: string | null;
}

export function sessionUsage(wrapper: unknown): SessionUsage {
  const row = asRecord(wrapper) ?? {};
  return {
    served: servedModels(wrapper),
    costUsd: typeof row['total_cost_usd'] === 'number' ? (row['total_cost_usd']) : null,
    durationMs: typeof row['duration_ms'] === 'number' ? (row['duration_ms']) : null,
    turns: typeof row['num_turns'] === 'number' ? (row['num_turns']) : null,
    sessionId: typeof row['session_id'] === 'string' ? (row['session_id']) : null,
  };
}

export interface ClaudeSessionOptions {
  /** Command spec for the claude binary; the test seam. */
  readonly claudeCommand: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly provider: SupervisorProvider;
  readonly timeoutMs: number;
  readonly onLog?: (line: string) => void;
}

export interface ClaudeSessionResult extends CommandResult {
  readonly wrapper: unknown;
  readonly structured: unknown;
  readonly usage: SessionUsage;
}

export async function runClaudeSession(options: ClaudeSessionOptions): Promise<ClaudeSessionResult> {
  const result = await runCommand(options.claudeCommand, options.args, {
    cwd: options.cwd,
    env: providerChildEnv(options.provider),
    timeoutMs: options.timeoutMs,
    ...(options.onLog ? { onLog: options.onLog } : {}),
  });
  const wrapper = result.code === 0 ? parseLooseJson(result.stdout) : null;
  return { ...result, wrapper, structured: extractStructured(wrapper), usage: sessionUsage(wrapper) };
}

/**
 * A pin that does not appear in what was served means the request was
 * reinterpreted, and two measurements under that pin are not one experiment.
 */
export function servedMatchesPin(provider: SupervisorProvider, usage: SessionUsage): boolean {
  if (!looksPinned(provider.model) || !usage.served) return true;
  return usage.served.some((entry) => entry.model === provider.model);
}
