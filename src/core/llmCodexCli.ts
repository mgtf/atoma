import { completeCodexToolLoop } from './codexToolLoop.js';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from './types.js';
import { CHATGPT_SUBSCRIPTION_MODELS } from '../contracts/runPayers.js';
import {
  acquireLocalCodexHomeLease,
  codexLeaseWrapperNodeArgs,
  PERSONAL_CODEX_PROFILE_ROOT_ENV,
} from './codexHomeLease.js';

const codexJailRoots = new Set<string>();
const leaseWrappedChildren = new WeakSet<ChildProcess>();

/** Remove every ephemeral Codex cwd/instruction root owned by this process. */
export function cleanupCodexJails(): void {
  for (const root of codexJailRoots) rmSync(root, { recursive: true, force: true });
  codexJailRoots.clear();
}

process.on('exit', cleanupCodexJails);

/**
 * LlmClient backed by the LOCAL Codex CLI installation (`codex exec --json`),
 * authenticated by the `codex login` held in the construction snapshot's
 * CODEX_HOME — typically a ChatGPT Plus/Pro subscription. Reached through a
 * tier pin's provider prefix:
 *
 *   ATOMA_MODEL_L3=sub:openai:gpt-5.6-sol
 *
 * WHY A SUBPROCESS AND NOT `@openai/codex-sdk`. The CLI exposes MORE
 * isolation than the SDK's ThreadOptions does — `--ephemeral`,
 * `--ignore-user-config`, `--ignore-rules` have no ThreadOptions
 * counterpart — and it costs ZERO new npm dependencies. That matters here
 * specifically: `@anthropic-ai/claude-agent-sdk` already requires a targeted
 * peer override over the zod3/zod4 split, and a second agent SDK is a second
 * chance to wedge the dependency tree.
 *
 * Tool-bearing L1 calls use a host-side JSON action loop. Each Codex child
 * remains text-only in the same empty read-only jail, with built-ins disabled.
 * Only the caller's declared tools can reach its sandbox executor; the host
 * records results and sends a bounded transcript to the next text completion.
 * No MCP server or native Codex filesystem access is enabled by this bridge.
 *
 * MEASURED on 2026-08-11, codex-cli 0.147.0, ChatGPT subscription auth:
 *   - ZERO parasitic tool turns on a real L3 plan prompt (one
 *     `agent_message`, no shell, no reads) with an empty cwd.
 *   - Output was already `parseTwoJson`-shaped: two JSON objects back to
 *     back, no prose.
 *   - Usage arrives complete on `turn.completed`, INCLUDING cache reads
 *     (74% on the plan prompt) — the "no prompt caching" worry was wrong.
 *   - ~9.7k input tokens of irreducible harness overhead per call (Codex's
 *     own tool declarations, which #6049 is what prevents removing).
 *     `model_instructions_file` removes a further ~3.5k by replacing
 *     Codex's "personality" preamble with the atom's own prompt.
 *   - 13.7s for an L3 plan, comparable to the claude-cli transport.
 */

/** Codex model slugs a ChatGPT subscription actually serves (2026-08-11). */
export const CODEX_MODEL_FRONTIER = CHATGPT_SUBSCRIPTION_MODELS[0];
export const CODEX_MODEL_MID = CHATGPT_SUBSCRIPTION_MODELS[1];
export const CODEX_MODEL_SMALL = CHATGPT_SUBSCRIPTION_MODELS[2];

/**
 * Codex capabilities removed from Atoma's L2/L3 text-completion transport.
 * Keep this explicit: account Apps, plugins, browser/computer controls and
 * delegated agents are separate authorities from the command-network policy.
 * `--strict-config` makes a Codex upgrade with renamed flags fail closed.
 */
export const CODEX_TEXT_ONLY_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'image_generation',
  'view_image',
  'multi_agent',
  'multi_agent_v2',
  'hooks',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'tool_suggest',
  'auth_elicitation',
  'tool_call_mcp_elicitation',
  'sleep_tool',
] as const);

/**
 * INACTIVITY ceiling on a codex call — same contract, and same history, as
 * `cliCallTimeoutMs` on the claude-cli transport: the clock measures
 * SILENCE and is rearmed by every JSONL event, because a long call is not a
 * hung one. A total-duration cap was measured killing healthy work there
 * (a web run still emitting tool calls axed at 10 minutes), while the
 * failure this exists to stop is a subprocess wedged on a dropped
 * connection, which emits nothing at all — the 11-day zombie.
 *
 * Invalid or non-positive `ATOMA_CODEX_CALL_TIMEOUT_MS` falls back to the
 * DEFAULT rather than disabling the guard: a typo must never restore the
 * infinite-hang behaviour.
 */
export const DEFAULT_CODEX_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export function codexCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ATOMA_CODEX_CALL_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_CODEX_CALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CODEX_CALL_TIMEOUT_MS;
}

// Once-per-process flag for the ATOMA_CODEX_MODEL banner below. ONE line,
// not one per call: the override rewrites EVERY codex call's slug, so the
// warning would otherwise repeat dozens of times per run.
let warnedCodexModelOverride = false;

/** Test seam: lets a suite assert the banner fires exactly once. */
export function resetCodexModelOverrideWarningForTests(): void {
  warnedCodexModelOverride = false;
}

/**
 * Map whatever arrived as `req.model` onto a slug Codex will accept.
 *
 * The same lesson as `resolveCliModel`: a subscription's served versions
 * shift under you, so the mapping exists to keep a tier pin valid across
 * those shifts. It is NOT cosmetic — `gpt-5` is a plausible-looking pin
 * that hard-400s ("The 'gpt-5' model is not supported when using Codex
 * with a ChatGPT account"), measured. A slug that already looks like a
 * Codex model passes through verbatim, so a new release is reachable
 * without a code change.
 *
 * Anthropic tier defaults are mapped by POWER rather than rejected: a user
 * writing `ATOMA_MODEL_L3=codex:claude-opus-5` means "my top tier, over
 * there", and silently 400ing on it would be a worse answer than serving
 * the frontier slug.
 */
export function resolveCodexModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env['ATOMA_CODEX_MODEL'];
  if (override && override.trim().length > 0) {
    // ATOMA_CLAUDE_MODEL gets a runner banner; this override had NONE
    // (review 2026-08-14 §1.13) — it silently rewrote every codex-routed
    // slug, flattening the tier gradient with nothing in the logs to say
    // so. stderr, not stdout: stdout is a parsed surface (burn-in markers,
    // MCP frames).
    if (!warnedCodexModelOverride) {
      warnedCodexModelOverride = true;
      process.stderr.write(
        `⚠ ATOMA_CODEX_MODEL=${override.trim()} overrides EVERY codex-routed call — ` +
          'tier pins are ignored and the cost gradient across codex tiers is flattened ' +
          'onto one model. Debug-only; unset it for real runs.\n'
      );
    }
    return override.trim();
  }
  const m = model.trim();
  if (m.length === 0) return CODEX_MODEL_FRONTIER;
  // Anthropic-shaped pins (the tier defaults) → equivalent power tier.
  if (/opus/i.test(m)) return CODEX_MODEL_FRONTIER;
  if (/sonnet/i.test(m)) return CODEX_MODEL_MID;
  if (/haiku/i.test(m)) return CODEX_MODEL_SMALL;
  // Bare `gpt-5` is NOT served on a ChatGPT account (measured 400).
  if (/^gpt-5$/i.test(m)) return CODEX_MODEL_FRONTIER;
  return m;
}

/** Floor for calls that pin no effort — see `codexEffortFor`. */
export const CODEX_DEFAULT_EFFORT = 'medium' as const;

/**
 * Reasoning effort, with a FLOOR. Codex accepts low|medium|high|xhigh|max
 * (per-model, from ~/.codex/models_cache.json), a superset of atoma's
 * `'low'|'medium'|'high'`, so a pinned effort maps straight across. This is
 * the one real cost lever on this transport — `maxTokens` is advisory-only
 * here, exactly as under claude-cli.
 *
 * WHY AN UNPINNED CALL DOES NOT MEAN "provider default". atoma pins
 * `effort: 'medium'` on L2/L3 `plan` and nowhere else, because on Anthropic
 * an unpinned call inherits the MODEL's default, which is `high` on Opus 5
 * and Sonnet 5 — the pin exists to bring plan calls DOWN. `gpt-5.6-sol`
 * defaults the other way, to `low`. Passing nothing through therefore does
 * not reproduce the Anthropic behaviour, it inverts it: every unpinned path
 * — `selfPlan`/`selfExecute`, the FALLBACK turns the supervise loop reaches
 * only after L1 and L2 have both failed — would run at the weakest setting
 * on the transport, at exactly the moment the run has the least margin. It
 * also makes any cross-vendor measurement a comparison of effort settings
 * rather than of models.
 *
 * The floor is `medium` rather than `high` deliberately: medium is what the
 * house already pins on its own reasoning calls, so this aligns the unpinned
 * paths with the pinned ones instead of inventing a new policy. An explicit
 * `'low'` from a caller is still honoured — the floor covers absence, not
 * intent.
 */
export function codexEffortFor(req: LlmCompletionRequest): 'low' | 'medium' | 'high' {
  return req.params?.effort ?? CODEX_DEFAULT_EFFORT;
}

/**
 * Convert Codex's usage counters to atoma's (Anthropic) convention.
 *
 * THE CONVENTIONS DISAGREE AND THE DIFFERENCE IS BILLABLE. Anthropic's
 * three input counters are DISJOINT (`total = input + cache_read +
 * cache_creation`) and `estimateCostUsd` is built on exactly that. OpenAI
 * counts `cached_input_tokens` INSIDE `input_tokens`. Verified rather than
 * assumed: two identical calls returned `input=9768 cached=6912` both
 * times — under a disjoint convention the warm second call's `input` would
 * have collapsed to the uncached remainder, and it did not move.
 *
 * So the cached (and cache-write) portions are SUBTRACTED out to recover
 * the disjoint shape. Note this is NOT the forbidden subtraction AGENTS.md
 * warns about ("older formulas that subtracted cache_read from inputTokens
 * produced negative costs"): that bug subtracted from counters which were
 * ALREADY disjoint. Here the subtraction is the conversion, and it is
 * clamped at zero so a future counter-semantics change degrades to an
 * under-estimate instead of a negative cost.
 */
export function mapCodexUsage(u: {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}): LlmCompletionResponse['usage'] {
  const total = u.input_tokens ?? 0;
  const cachedRead = u.cached_input_tokens ?? 0;
  const cachedWrite = u.cache_write_input_tokens ?? 0;
  return {
    inputTokens: Math.max(0, total - cachedRead - cachedWrite),
    // Reasoning tokens are billed as output and are NOT included in
    // `output_tokens` (measured: 186 output / 41 reasoning on one plan),
    // so they are added rather than ignored — otherwise a high-effort
    // plan call reads as nearly free.
    outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
    ...(cachedWrite > 0 ? { cacheCreationInputTokens: cachedWrite } : {}),
    ...(cachedRead > 0 ? { cacheReadInputTokens: cachedRead } : {}),
  };
}

/**
 * True when a Codex error is worth one retry: upstream 5xx, or a 429 rate
 * limit (a subscription throttles under a burn-in batch, which is
 * transient by definition). A 4xx that is not 429 is a real request error
 * the caller must see — mirrors `isCliTransportErrorText`'s 5xx-only rule,
 * widened for the subscription throttle this transport can actually hit.
 */
function codexHttpStatus(message: string): number | undefined {
  const jsonStatus = /["']?status(?:_code)?["']?\s*[:=]\s*["']?(\d{3})\b/i.exec(message);
  const proseStatus =
    /\b(?:http(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i.exec(message);
  const raw = jsonStatus?.[1] ?? proseStatus?.[1];
  return raw === undefined ? undefined : Number(raw);
}

export function isCodexTransientError(message: string): boolean {
  const status = codexHttpStatus(message);
  return (
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    /\b(?:429\b.*(?:rate limit|too many requests)|(?:rate limit|too many requests).*\b429)\b/i.test(
      message
    )
  );
}

/** Stable, non-sensitive failure vocabulary allowed to leave this transport. */
export type CodexFailureCode =
  | 'authentication-required'
  | 'rate-limited'
  | 'service-unavailable'
  | 'request-rejected'
  | 'provider-error'
  | 'transport-unavailable'
  | 'empty-response'
  | 'timeout';

const RETRYABLE_CODEX_FAILURES = new Set<CodexFailureCode>([
  'rate-limited',
  'service-unavailable',
]);

function isRetryableCodexFailure(code: CodexFailureCode): boolean {
  return RETRYABLE_CODEX_FAILURES.has(code);
}

/**
 * Reduce provider-owned prose immediately. The raw string is used only to
 * decide retry/auth/status semantics and is never attached as an Error cause,
 * returned from the fold, logged, or persisted by an outer layer.
 */
export function classifyCodexDiagnostic(
  diagnostic: string,
  fallback: CodexFailureCode = 'provider-error'
): CodexFailureCode {
  const status = codexHttpStatus(diagnostic);
  if (status === 429 || /\b(?:rate limit(?:ed)?|too many requests)\b/i.test(diagnostic)) {
    return 'rate-limited';
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return 'service-unavailable';
  }
  if (
    status === 401 ||
    /\b(?:not logged in|login required|authentication required|unauthori[sz]ed|missing credentials?|invalid (?:access |refresh )?token|expired (?:access |refresh )?token)\b/i.test(
      diagnostic
    )
  ) {
    return 'authentication-required';
  }
  if (status !== undefined && status >= 400 && status <= 499) return 'request-rejected';
  return fallback;
}

/** Error type outer layers may persist: its code/message contain no provider prose. */
export class CodexTransportError extends Error {
  readonly code: CodexFailureCode;
  readonly retried: boolean;

  constructor(code: CodexFailureCode, retried = false) {
    super(`codex call failed [${code}]${retried ? ' after 1 retry' : ''}`);
    this.name = 'CodexTransportError';
    this.code = code;
    this.retried = retried;
  }
}

/**
 * Build the `codex exec` argv. Exported because the ISOLATION GUARANTEES
 * live here and nowhere else, so this is what a test can pin.
 *
 * Every flag earns its place:
 *   --json                 JSONL events on stdout (usage + agent message).
 *   --ephemeral            no session files on disk. atoma makes stateless
 *                          one-shot calls, so persisted threads would be
 *                          pure accumulation under ~/.codex/sessions.
 *   --ignore-user-config   the claude-cli `settingSources: []` equivalent:
 *                          the operator's own config.toml must not bleed
 *                          into an atom's prompt or model choice.
 *   --ignore-rules         same, for execpolicy .rules files.
 *   cli_auth_credentials   keeps refreshes in this run's private CODEX_HOME.
 *                          `auto` may otherwise select the service account's
 *                          keyring, which is shared across principals.
 *   default_permissions    selects the inline, fail-closed `atoma-text-only`
 *                          permission profile below. Permission profiles do
 *                          not compose with `--sandbox`, so there is
 *                          deliberately no legacy `-s read-only` flag.
 *   :root=deny             deny all filesystem access by default.
 *   :minimal=read          reopen only the runtime paths common tools need.
 *   :workspace_roots=read reopen the empty jail itself, read-only.
 *   network.enabled=false  model-owned commands get no network.
 *   disabled features      command, Apps, plugin, browser/computer, image,
 *                          skill and delegated-agent capabilities are absent.
 *                          `apply_patch` has no supported complete off switch
 *                          in Codex CLI, so the no-write profile is the
 *                          enforcement boundary for that residual tool.
 *   agents/orchestrator    disabled independently of feature rollout metadata.
 *   -C <empty dir>         a second boundary around residual built-ins. The
 *                          permission profile makes this the sole readable
 *                          workspace. An empty dir outside the
 *                          repo keeps `atoma.db` and `skills/` off the map
 *                          entirely — the same reasoning that moved the
 *                          build workspace out of the repo, and that the
 *                          container executor enforces for L1.
 *   --skip-git-repo-check  that dir is deliberately not a git repo.
 *   -c model_instructions_file  carries the ATOM's system prompt in place
 *                          of Codex's own preamble (measured: -3.5k input
 *                          tokens, and the atom stops being asked to act
 *                          as "Codex, an agent based on GPT-5").
 */
export function buildCodexArgs(opts: {
  model: string;
  cwd: string;
  instructionsFile: string;
  outputSchemaFile?: string;
  effort?: string;
}): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    ...CODEX_TEXT_ONLY_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-C',
    opts.cwd,
    '--skip-git-repo-check',
    '-m',
    opts.model,
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'approval_policy="never"',
    '-c',
    'allow_login_shell=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'agents.enabled=false',
    '-c',
    'orchestrator.mcp.enabled=false',
    '-c',
    'orchestrator.skills.enabled=false',
    '-c',
    'shell_environment_policy.inherit="none"',
    '-c',
    'shell_environment_policy.ignore_default_excludes=false',
    '-c',
    'default_permissions="atoma-text-only"',
    '-c',
    'permissions.atoma-text-only.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}',
    '-c',
    'permissions.atoma-text-only.network.enabled=false',
    '-c',
    `model_instructions_file=${opts.instructionsFile}`,
    ...(opts.effort ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
    ...(opts.outputSchemaFile ? ['--output-schema', opts.outputSchemaFile] : []),
    // Prompt on stdin: an atom's userContent carries whole catalogs and can
    // exceed argv limits, and `-` is the documented way to feed it.
    '-',
  ];
}

/** One parsed JSONL event, reduced to what this client acts on. */
export interface CodexOutcome {
  text: string;
  usage: LlmCompletionResponse['usage'];
  /** Stable classification only — never provider-owned diagnostic prose. */
  error?: CodexFailureCode;
}

/**
 * Fold Codex's JSONL event stream into an outcome. Tolerant by design: an
 * unparseable line is skipped rather than fatal (the CLI is free to add
 * event types, and a cosmetic addition must not take a run down), and the
 * LAST agent message wins so a preamble cannot displace the real payload.
 */
export function foldCodexEvents(lines: readonly string[]): CodexOutcome {
  let text = '';
  let usage: LlmCompletionResponse['usage'] = { inputTokens: 0, outputTokens: 0 };
  let error: CodexFailureCode | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = e['type'];
    if (type === 'item.completed') {
      const item = e['item'] as { type?: string; text?: string; message?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        text = item.text;
      }
      // An `error` ITEM is Codex commentary (e.g. "model metadata not
      // found, defaulting to fallback"), NOT a failed turn — it arrives
      // alongside a perfectly good answer, so it must not become the
      // outcome's error. Only `error` / `turn.failed` events below do.
      continue;
    }
    if (type === 'turn.completed') {
      const u = e['usage'];
      if (u && typeof u === 'object') usage = mapCodexUsage(u);
      continue;
    }
    if (type === 'error') {
      const m = e['message'];
      if (typeof m === 'string') {
        const classified = classifyCodexDiagnostic(m);
        if (error === undefined || isRetryableCodexFailure(classified)) error = classified;
      }
      continue;
    }
    if (type === 'turn.failed') {
      const err = e['error'] as { message?: string } | undefined;
      if (typeof err?.message === 'string') {
        const classified = classifyCodexDiagnostic(err.message);
        if (error === undefined || isRetryableCodexFailure(classified)) error = classified;
      }
    }
  }
  return { text, usage, ...(error !== undefined ? { error } : {}) };
}

/**
 * Variables the Codex harness itself may receive. This is deliberately not a
 * pattern-based denylist: a newly added provider secret remains absent until a
 * maintainer makes an explicit case for it here.
 */
export const CODEX_CHILD_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  PERSONAL_CODEX_PROFILE_ROOT_ENV,
] as const);

/** Build the exact subprocess environment from one caller-owned snapshot. */
export function codexChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of CODEX_CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) child[key] = value;
  }
  const profile = source['CODEX_HOME'];
  if (profile !== undefined) {
    // CODEX_HOME is authoritative for Codex itself. Align the conventional
    // home variables too so an auxiliary library or future fallback can only
    // fail inside this same principal-owned generation, never discover the
    // service account's host profile.
    child['HOME'] = profile;
    child['USERPROFILE'] = profile;
  }
  return child;
}

/** Injectable spawn, so tests drive the transport without a real CLI. */
export type CodexSpawn = (
  args: readonly string[],
  stdin: string,
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string
) => ChildProcess;

export class CodexCliLlmClient implements LlmClient {
  private readonly callTimeoutMs: number;
  private readonly spawnFn: CodexSpawn;
  private readonly modelEnv: NodeJS.ProcessEnv;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly profileHome: string | undefined;
  private jail: { cwd: string; root: string } | undefined;

  constructor(
    opts: { callTimeoutMs?: number; spawnFn?: CodexSpawn; env?: NodeJS.ProcessEnv } = {}
  ) {
    const sourceEnv = { ...(opts.env ?? process.env) };
    this.callTimeoutMs =
      opts.callTimeoutMs && opts.callTimeoutMs > 0
        ? opts.callTimeoutMs
        : codexCallTimeoutMs(sourceEnv);
    this.spawnFn = opts.spawnFn ?? defaultCodexSpawn;
    this.modelEnv = Object.freeze({
      ATOMA_CODEX_MODEL: sourceEnv['ATOMA_CODEX_MODEL'],
    });
    this.childEnv = Object.freeze(codexChildEnvironment(sourceEnv));
    this.profileHome = this.childEnv['CODEX_HOME']?.trim() || undefined;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (req.executor !== undefined || (req.tools?.length ?? 0) > 0) {
      return completeCodexToolLoop(req, (request, schema) => this.completeText(request, schema));
    }

    return this.completeText(req);
  }

  private async completeText(req: LlmCompletionRequest, outputSchema?: Record<string, unknown>): Promise<LlmCompletionResponse> {
    // Multiple L2/L3 lanes can share one personal generation. Codex may
    // rotate auth.json during either call, so its complete child lifetime is
    // serialized on CODEX_HOME. The project coordinator's machine-global run
    // lease prevents a second run process from sharing that home concurrently.
    let releaseProfile: (() => void) | null = null;
    if (this.profileHome) {
      try {
        releaseProfile = await acquireLocalCodexHomeLease(this.profileHome, req.signal);
      } catch {
        if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
        throw new CodexTransportError('transport-unavailable');
      }
    }
    try {
      // Resolved here as well as in completeOnce (same deterministic result)
      // so the response can report what was ACTUALLY invoked: pricing on the
      // pin billed `codex:claude-opus-5` at the /opus/i row for gpt-5.6-sol
      // tokens (review 2026-08-14 §1.13).
      const served = resolveCodexModel(req.model, this.modelEnv);
      const first = await this.completeOnce(req, outputSchema);
      if (first.error === undefined) return toResponse(first, served);
      if (!isRetryableCodexFailure(first.error)) throw Object.assign(new CodexTransportError(first.error), { partialUsage: first.usage });
      // Transient (5xx / subscription throttle): one retry, then surface it
      // as a real transport error so metrics record an error call instead of
      // a parser crash far from the cause. Only the stable classification
      // crosses this boundary; provider prose was discarded by completeOnce.
      await new Promise((r) => setTimeout(r, 3000));
      const second = await this.completeOnce(req, outputSchema);
      const usage = {
        inputTokens: first.usage.inputTokens + second.usage.inputTokens,
        outputTokens: first.usage.outputTokens + second.usage.outputTokens,
        cacheReadInputTokens: (first.usage.cacheReadInputTokens ?? 0) + (second.usage.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens: (first.usage.cacheCreationInputTokens ?? 0) + (second.usage.cacheCreationInputTokens ?? 0),
      };
      if (second.error === undefined) return toResponse({ ...second, usage }, served);
      throw Object.assign(new CodexTransportError(second.error, true), { partialUsage: usage });
    } finally {
      releaseProfile?.();
    }
  }

  private async completeOnce(req: LlmCompletionRequest, outputSchema?: Record<string, unknown>): Promise<CodexOutcome> {
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');

    const jail = this.ensureJail();
    const instructionsFile = path.join(jail.root, `instructions-${process.hrtime.bigint()}.txt`);
    writeFileSync(instructionsFile, req.systemPrompt, 'utf8');
    const outputSchemaFile = outputSchema ? `${instructionsFile}.schema.json` : undefined;
    if (outputSchemaFile) writeFileSync(outputSchemaFile, JSON.stringify(outputSchema), 'utf8');

    const args = buildCodexArgs({
      model: resolveCodexModel(req.model, this.modelEnv),
      cwd: jail.cwd,
      instructionsFile,
      outputSchemaFile,
      effort: codexEffortFor(req),
    });

    let child: ChildProcess;
    try {
      child = this.spawnFn(args, req.userContent, this.childEnv, jail.cwd);
    } catch {
      rmSync(instructionsFile, { force: true });
      if (outputSchemaFile) rmSync(outputSchemaFile, { force: true });
      return {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: 'transport-unavailable',
      };
    }
    const lines: string[] = [];
    let stdoutBuf = '';
    // Provider-owned and potentially sensitive. It remains process-local only
    // until classifyCodexDiagnostic reduces it to the public failure vocabulary.
    let stderrTail = '';
    let spawnFailed = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set by the Promise executor below. A live child settles ONLY on close:
    // releasing CODEX_HOME after sending SIGKILL but before reap lets another
    // process rotate the same auth.json while the first is still dying. A
    // failed spawn with no pid is the sole safe immediate-settle case.
    let settle: (() => void) | undefined;

    // Rearmed by every event: the deadline measures SILENCE, not duration.
    const bumpDeadline = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        if (child.pid === undefined) settle?.();
      }, this.callTimeoutMs);
    };
    bumpDeadline();

    const onAbort = (): void => {
      killTree(child);
      if (child.pid === undefined) settle?.();
    };

    try {
      await new Promise<void>((resolve) => {
        settle = resolve;
        child.stdout?.on('data', (d: Buffer) => {
          bumpDeadline();
          stdoutBuf += d.toString();
          const parts = stdoutBuf.split('\n');
          stdoutBuf = parts.pop() ?? '';
          for (const p of parts) lines.push(p);
        });
        child.stderr?.on('data', (d: Buffer) => {
          bumpDeadline();
          stderrTail = (stderrTail + d.toString()).slice(-2000);
        });
        child.on('error', () => {
          spawnFailed = true;
          killTree(child);
          if (child.pid === undefined) resolve();
        });
        child.on('close', () => {
          if (stdoutBuf.trim().length > 0) lines.push(stdoutBuf);
          resolve();
        });
        req.signal?.addEventListener('abort', onAbort, { once: true });
        // Close the narrow gap between the entry check and listener install.
        if (req.signal?.aborted) onAbort();
      });
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      rmSync(instructionsFile, { force: true });
      if (outputSchemaFile) rmSync(outputSchemaFile, { force: true });
    }

    if (timedOut || req.signal?.aborted) {
      const failure = timedOut ? new CodexTransportError('timeout') : req.signal?.reason ?? new Error('aborted');
      try { failure.partialUsage = foldCodexEvents(lines).usage; } catch { /* Frozen abort reason. */ }
      throw failure;
    }

    if (spawnFailed) {
      return {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: 'transport-unavailable',
      };
    }

    const outcome = foldCodexEvents(lines);
    // A dead subprocess that emitted neither an answer nor a typed error
    // (missing CLI, auth failure, crash) must not read as an empty answer.
    if (outcome.error === undefined && outcome.text.trim().length === 0) {
      return {
        ...outcome,
        error:
          stderrTail.trim().length > 0
            ? classifyCodexDiagnostic(stderrTail, 'transport-unavailable')
            : 'empty-response',
      };
    }
    return outcome;
  }

  /**
   * Lazily create the empty working directory Codex is confined to, plus a
   * sibling root for instruction files. The instructions live OUTSIDE the
   * cwd so the cwd stays genuinely empty — the guarantee is "nothing to
   * read", and a file in there would weaken it for no benefit.
   */
  private ensureJail(): { cwd: string; root: string } {
    if (this.jail) return this.jail;
    const root = mkdtempSync(path.join(tmpdir(), 'atoma-codex-'));
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    codexJailRoots.add(root);
    this.jail = { cwd, root };
    return this.jail;
  }
}

function toResponse(o: CodexOutcome, servedModel: string): LlmCompletionResponse {
  return { text: o.text, stopReason: 'end_turn', usage: o.usage, servedModel };
}

/**
 * Spawn the real CLI. DETACHED so the whole process group can be signalled
 * — the #7c lesson from `run_shell`: signalling only the direct child
 * leaves grandchildren orphaned, and this subprocess is an agent harness
 * that spawns its own.
 */
function defaultCodexSpawn(
  args: readonly string[],
  stdin: string,
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string
): ChildProcess {
  const personalProfilesRoot = env[PERSONAL_CODEX_PROFILE_ROOT_ENV]?.trim();
  const child = personalProfilesRoot
    ? spawn(process.execPath, codexLeaseWrapperNodeArgs(args), {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        cwd,
        env,
      })
    : spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        cwd,
        env,
      });
  if (personalProfilesRoot) leaseWrappedChildren.add(child);
  child.stdin?.end(stdin);
  return child;
}

/**
 * Group-kill, falling back to the direct child. The group signal comes
 * first because this subprocess is an agent harness that spawns its own
 * children (#7c: signalling only the direct child orphans grandchildren).
 *
 * The fallback must run when there is NO pid too, not only when the group
 * signal throws — a failed spawn leaves `pid` undefined, and the first
 * version's `if (pid !== undefined)` inside the try meant that case killed
 * nothing at all and raised no error to reach the catch.
 */
function killTree(child: ChildProcess): void {
  if (leaseWrappedChildren.has(child)) {
    try {
      // The wrapper owns descendant termination and keeps the SQLite lease
      // until the real Codex process tree has been reaped.
      child.kill('SIGTERM');
    } catch {
      // It was already reaped.
    }
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // not a group leader, or already reaped — fall through
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}
