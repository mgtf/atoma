import {
  MODEL_SELECTOR_GRAMMAR,
  ModelSelectorError,
  parseModelSelector,
  ZAI_DEFAULT_BASE_URL,
} from '../contracts/modelSelector.js';
import { terminateRunProcessGroup } from '../cli/burnin.js';
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
  /** JSONL duplex protocol; callbacks run in the trusted harness. */
  readonly onLine?: (line: string, send: (message: unknown) => void, end: () => void) => void;
  /** Model-authored mender commands run without networking. */
  readonly network?: 'none';
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
  if (process.platform === 'win32') return Promise.reject(new Error('supervisor commands require POSIX process groups; use WSL2'));
  const resolved = resolveCommand(spec);
  const args = [...resolved.args, ...extraArgs];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(resolved.command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: resolved.shell,
      detached: process.platform !== 'win32',
      stdio: [options.input === undefined && !options.onLine ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let closed = false;
    let reaped = false;
    const finishTimeout = () => {
      if (!closed || !reaped || settled) return;
      settled = true;
      rejectRun(new Error(`timeout after ${options.timeoutMs}ms: ${resolved.command} ${args.slice(0, 3).join(' ')}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      options.onLog?.(`command exceeded ${options.timeoutMs}ms; terminating: ${resolved.command}`);
      // The existing run-group primitive confirms disappearance, including
      // grandchildren whose parent already exited. A surviving group keeps
      // the caller (and hence the mender lock/worktree) occupied.
      void (async () => {
        while (child.pid && !(await terminateRunProcessGroup(child.pid, 1_000, 1_000))) {
          options.onLog?.('command process group still exists; retaining ownership');
        }
        reaped = true;
        finishTimeout();
      })();
    }, options.timeoutMs);
    let lines = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (!options.onLine) return;
      lines += chunk;
      let newline: number;
      while ((newline = lines.indexOf('\n')) !== -1) {
        const line = lines.slice(0, newline);
        lines = lines.slice(newline + 1);
        options.onLine(line, (message) => { child.stdin?.write(`${JSON.stringify(message)}\n`); }, () => { child.stdin?.end(); });
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => (stderr += String(chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code) => {
      closed = true;
      if (timedOut) { finishTimeout(); return; }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin?.on('error', () => { /* close/error owns the result */ });
    if (options.input !== undefined) {
      if (options.onLine) child.stdin?.write(options.input);
      else child.stdin?.end(options.input);
    }
  });
}

/* ────────────────────────────── providers ────────────────────────────── */

export type ProviderSource = 'mender' | 'analyst';

/**
 * WHICH SESSION THE SUPERVISOR STAGE RUNS, resolved from ONE selector per
 * stage: `ATOMA_ANALYST_MODEL` and `ATOMA_MENDER_MODEL` hold a full
 * `<api|sub>:<vendor>:<model>` (`contracts/modelSelector.ts`), the same
 * grammar as the run tiers, and there is no default — a stage that is enabled
 * without its selector refuses to start, naming the variable.
 *
 * The supervisor drives a headless CLI, not an `LlmClient`, so the selector
 * maps onto a SESSION rather than a transport client:
 *   sub:anthropic:<alias>  → Claude Code on the machine's own login
 *   api:anthropic:<model>  → Claude Code with ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL)
 *   api:zai:<model>        → Claude Code pointed at Z.ai with ZAI_API_KEY / ZAI_BASE_URL
 *   sub:openai:<model>     → Codex on a ChatGPT login (`<PREFIX>_CODEX_HOME` picks the profile)
 * `api:openai` is refused: the Codex supervisor session requires a ChatGPT
 * login and rejects API-key profiles by design (`codexSession.ts`). `own:` and
 * `api:ollama` have no CLI to run and are refused too. The pre-2026-09-07
 * variables (`_TRANSPORT`, `_BASE_URL`, `_AUTH_TOKEN`) are refused by name so
 * a stale unit file fails loudly instead of silently changing payer.
 */
export interface SupervisorProvider {
  /** The selector as configured — the requested identity records carry. */
  readonly selector: string;
  readonly transport: 'claude' | 'codex';
  readonly codexHome?: string;
  /** The bare model id or alias the CLI receives. */
  readonly model: string;
  readonly baseUrl: string | null;
  readonly authToken: string | null;
  readonly source: ProviderSource;
}

/** A CI runner hands an unset repository variable over as an EMPTY string; that is "unset". */
function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const RETIRED_SUFFIXES = ['_TRANSPORT', '_BASE_URL', '_AUTH_TOKEN'] as const;

function providerSet(env: NodeJS.ProcessEnv, source: ProviderSource): SupervisorProvider | null {
  const prefix = source === 'mender' ? 'ATOMA_MENDER' : 'ATOMA_ANALYST';
  for (const suffix of RETIRED_SUFFIXES) {
    if (present(env[`${prefix}${suffix}`])) {
      throw new ModelSelectorError(
        `${prefix}${suffix} was retired on 2026-09-07: ${prefix}_MODEL now carries the whole selector ` +
          `(${MODEL_SELECTOR_GRAMMAR}) and credentials come from ANTHROPIC_API_KEY / ZAI_API_KEY`
      );
    }
  }
  const variable = `${prefix}_MODEL`;
  const raw = present(env[variable]);
  if (!raw) return null;
  const selector = parseModelSelector(raw, variable);
  const codexHome = present(env[`${prefix}_CODEX_HOME`]);
  if (selector.mode === 'own') {
    throw new ModelSelectorError(`${variable}=${raw}: a supervisor stage runs on the host, so own: has no login to bind to; use sub: or api:`);
  }
  if (selector.mode === 'sub') {
    if (selector.vendor === 'anthropic') {
      return { selector: raw, transport: 'claude', model: selector.model, baseUrl: null, authToken: null, source };
    }
    return {
      selector: raw, transport: 'codex', model: selector.model, baseUrl: null, authToken: null, source,
      ...(codexHome ? { codexHome } : {}),
    };
  }
  switch (selector.vendor) {
    case 'anthropic': {
      const key = present(env['ANTHROPIC_API_KEY']);
      if (!key) throw new ModelSelectorError(`${variable}=${raw} needs ANTHROPIC_API_KEY`);
      return { selector: raw, transport: 'claude', model: selector.model, baseUrl: present(env['ANTHROPIC_BASE_URL']), authToken: key, source };
    }
    case 'zai': {
      const key = present(env['ZAI_API_KEY']);
      if (!key) throw new ModelSelectorError(`${variable}=${raw} needs ZAI_API_KEY`);
      return { selector: raw, transport: 'claude', model: selector.model, baseUrl: present(env['ZAI_BASE_URL']) ?? ZAI_DEFAULT_BASE_URL, authToken: key, source };
    }
    case 'openai':
      throw new ModelSelectorError(
        `${variable}=${raw}: the Codex supervisor session requires a ChatGPT login and rejects API keys; use sub:openai:${selector.model}`
      );
    case 'ollama':
      throw new ModelSelectorError(`${variable}=${raw}: no supervisor CLI can run against Ollama; use sub:anthropic, api:anthropic, api:zai or sub:openai`);
  }
}

export function analystProvider(env: NodeJS.ProcessEnv = process.env): SupervisorProvider {
  const provider = providerSet(env, 'analyst');
  if (!provider) {
    throw new ModelSelectorError(`ATOMA_ANALYST_MODEL is not set; the analyst names its session as ${MODEL_SELECTOR_GRAMMAR} and has no default`);
  }
  return provider;
}

/** The mender's own selector, else the analyst's — never a mix, never a default. */
export function menderProvider(env: NodeJS.ProcessEnv = process.env): SupervisorProvider {
  const provider = providerSet(env, 'mender') ?? providerSet(env, 'analyst');
  if (!provider) {
    throw new ModelSelectorError(`ATOMA_MENDER_MODEL (or ATOMA_ANALYST_MODEL) is not set; the mender names its session as ${MODEL_SELECTOR_GRAMMAR} and has no default`);
  }
  return provider;
}

/**
 * The child session's environment. The stage's credential is scoped HERE and
 * never exported at platform launch: raw `ANTHROPIC_*` in the process env
 * would reroute the runs' own Claude transport along with the supervisor. The
 * host's `ANTHROPIC_*` / Bedrock / Vertex variables are stripped first, then
 * exactly what the selector needs is set.
 */
export function providerChildEnv(
  provider: SupervisorProvider,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(child)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')) delete child[key];
  }
  if (provider.baseUrl) child['ANTHROPIC_BASE_URL'] = provider.baseUrl;
  if (provider.authToken) {
    // An Anthropic API key (`sk-ant-…`) travels as the API key the CLI reads
    // natively; anything else is a gateway bearer (Z.ai, a proxy). Either way
    // only ONE of the two variables is set, so nothing stale can shadow it.
    if (/^sk-ant-/.test(provider.authToken)) child['ANTHROPIC_API_KEY'] = provider.authToken;
    else child['ANTHROPIC_AUTH_TOKEN'] = provider.authToken;
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
  /** A host-owned executor; the mender supplies its container boundary. */
  readonly execute?: typeof runCommand;
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
  const result = await (options.execute ?? runCommand)(options.claudeCommand, options.args, {
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
