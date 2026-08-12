import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from './types.js';

/**
 * LlmClient backed by the LOCAL Codex CLI installation (`codex exec --json`),
 * authenticated by whatever `codex login` holds — typically a ChatGPT
 * Plus/Pro subscription. Reached through a tier pin's provider prefix:
 *
 *   ATOMA_MODEL_L3=codex:gpt-5.6-sol
 *
 * WHY A SUBPROCESS AND NOT `@openai/codex-sdk`. The CLI exposes MORE
 * isolation than the SDK's ThreadOptions does — `--ephemeral`,
 * `--ignore-user-config`, `--ignore-rules` have no ThreadOptions
 * counterpart — and it costs ZERO new npm dependencies. That matters here
 * specifically: `@anthropic-ai/claude-agent-sdk` already requires a targeted
 * peer override over the zod3/zod4 split, and a second agent SDK is a second
 * chance to wedge the dependency tree.
 *
 * === TIERS 2 AND 3 ONLY — L1 IS REFUSED, AND THE REFUSAL IS STRUCTURAL ===
 *
 * Codex offers no way to disable its OWN built-in tools (shell,
 * apply_patch, plan) while keeping external ones — openai/codex#6049, open
 * since 2025-10, PR #5001 closed, community contributions not accepted. So
 * the trick that makes `ClaudeCliLlmClient` safe for L1 (`tools: []` plus an
 * in-process MCP bridge, hence every side effect routed through
 * `req.executor`) has no equivalent here. Handing this client a toolset
 * would mean the model acting on the filesystem OUTSIDE `ToolSandbox`:
 * no jail, no #8a scope gate, no `record_probe`, no probe manifest, no
 * `VizToolEvent`s in the trace, and none of the 93.5% cache_read the
 * execute path lives on. `complete` therefore THROWS when handed tools or
 * an executor rather than silently degrading — a wrong tier pin must fail
 * loudly at the first call, not produce an unobservable run.
 *
 * That restriction costs nothing architecturally: L2/L3 never pass `tools`
 * or an `executor` (the tier-split invariant), so their calls are pure text
 * completions and this transport serves them unchanged.
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
export const CODEX_MODEL_FRONTIER = 'gpt-5.6-sol';
export const CODEX_MODEL_MID = 'gpt-5.6-terra';
export const CODEX_MODEL_SMALL = 'gpt-5.4-mini';

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

export function codexCallTimeoutMs(): number {
  const raw = process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_CODEX_CALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CODEX_CALL_TIMEOUT_MS;
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
export function resolveCodexModel(model: string): string {
  const override = process.env['ATOMA_CODEX_MODEL'];
  if (override && override.trim().length > 0) return override.trim();
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
export function isCodexTransientError(message: string): boolean {
  return /"status"\s*:\s*(?:429|5\d\d)\b/.test(message) || /\b(?:429|5\d\d)\b.*rate limit/i.test(message);
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
 *   -s read-only           L2/L3 produce TEXT, and a plan call that could
 *                          edit the disk is a plan call that can corrupt the
 *                          workspace it is planning for.
 *   -C <empty dir>         THE LOAD-BEARING ONE. Codex still holds its own
 *                          shell/read tools (#6049), so the cwd bounds what
 *                          it can reach at all. An empty dir outside the
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
  effort?: string;
}): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '-s',
    'read-only',
    '-C',
    opts.cwd,
    '--skip-git-repo-check',
    '-m',
    opts.model,
    '-c',
    `model_instructions_file=${opts.instructionsFile}`,
    ...(opts.effort ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
    // Prompt on stdin: an atom's userContent carries whole catalogs and can
    // exceed argv limits, and `-` is the documented way to feed it.
    '-',
  ];
}

/** One parsed JSONL event, reduced to what this client acts on. */
export interface CodexOutcome {
  text: string;
  usage: LlmCompletionResponse['usage'];
  error?: string;
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
  let error: string | undefined;
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
      if (typeof m === 'string') error = m;
      continue;
    }
    if (type === 'turn.failed') {
      const err = e['error'] as { message?: string } | undefined;
      if (typeof err?.message === 'string') error = err.message;
    }
  }
  return { text, usage, ...(error !== undefined ? { error } : {}) };
}

/** Injectable spawn, so tests drive the transport without a real CLI. */
export type CodexSpawn = (args: readonly string[], stdin: string) => ChildProcess;

export class CodexCliLlmClient implements LlmClient {
  private readonly callTimeoutMs: number;
  private readonly spawnFn: CodexSpawn;
  private jail: { cwd: string; root: string } | undefined;

  constructor(opts: { callTimeoutMs?: number; spawnFn?: CodexSpawn } = {}) {
    this.callTimeoutMs =
      opts.callTimeoutMs && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : codexCallTimeoutMs();
    this.spawnFn = opts.spawnFn ?? defaultCodexSpawn;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // See the class docstring: this transport cannot enforce atoma's tool
    // contracts (openai/codex#6049), so it refuses tiers that need them.
    if (req.executor !== undefined || (req.tools?.length ?? 0) > 0) {
      throw new Error(
        'codex provider serves tiers 2 and 3 only: it cannot host a tool loop because Codex ' +
          'offers no way to disable its own built-in tools (openai/codex#6049), so tool calls ' +
          'would bypass ToolSandbox and the #8a scope gate. Pin L1 to a provider with a tool ' +
          'bridge (e.g. ATOMA_MODEL_L1=claude-haiku-4-5-20251001).'
      );
    }

    const first = await this.completeOnce(req);
    if (first.error === undefined) return toResponse(first);
    if (!isCodexTransientError(first.error)) {
      throw new Error(`codex call failed: ${first.error.slice(0, 300)}`);
    }
    // Transient (5xx / subscription throttle): one retry, then surface it
    // as a real transport error so metrics record an error call instead of
    // a parser crash far from the cause.
    await new Promise((r) => setTimeout(r, 3000));
    const second = await this.completeOnce(req);
    if (second.error === undefined) return toResponse(second);
    throw new Error(`codex call failed (after 1 retry): ${second.error.slice(0, 300)}`);
  }

  private async completeOnce(req: LlmCompletionRequest): Promise<CodexOutcome> {
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');

    const jail = this.ensureJail();
    const instructionsFile = path.join(jail.root, `instructions-${process.hrtime.bigint()}.txt`);
    writeFileSync(instructionsFile, req.systemPrompt, 'utf8');

    const args = buildCodexArgs({
      model: resolveCodexModel(req.model),
      cwd: jail.cwd,
      instructionsFile,
      effort: codexEffortFor(req),
    });

    const child = this.spawnFn(args, req.userContent);
    const lines: string[] = [];
    let stdoutBuf = '';
    let stderrTail = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set by the Promise executor below, so the deadline can settle the
    // wait ITSELF rather than trusting the child to close. Killing is not
    // enough: a child whose spawn failed has no pid to signal and will
    // never emit 'close', so a kill-only deadline hangs forever — the very
    // failure mode this guard exists to remove. Found by the wedged-call
    // test, which timed out instead of throwing.
    let settle: (() => void) | undefined;

    // Rearmed by every event: the deadline measures SILENCE, not duration.
    const bumpDeadline = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        settle?.();
      }, this.callTimeoutMs);
    };
    bumpDeadline();

    const onAbort = (): void => {
      killTree(child);
      settle?.();
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
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
        child.on('error', reject);
        child.on('close', () => {
          if (stdoutBuf.trim().length > 0) lines.push(stdoutBuf);
          resolve();
        });
      });
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      rmSync(instructionsFile, { force: true });
    }

    if (timedOut) {
      throw new Error(
        `codex call produced no output for ${this.callTimeoutMs}ms (idle — dropped connection?)`
      );
    }
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');

    const outcome = foldCodexEvents(lines);
    // A dead subprocess that emitted neither an answer nor a typed error
    // (missing CLI, auth failure, crash) must not read as an empty answer.
    if (outcome.error === undefined && outcome.text.trim().length === 0) {
      return {
        ...outcome,
        error: stderrTail.trim().length > 0 ? stderrTail.trim() : 'codex produced no output',
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
    this.jail = { cwd, root };
    return this.jail;
  }
}

function toResponse(o: CodexOutcome): LlmCompletionResponse {
  return { text: o.text, stopReason: 'end_turn', usage: o.usage };
}

/**
 * Spawn the real CLI. DETACHED so the whole process group can be signalled
 * — the #7c lesson from `run_shell`: signalling only the direct child
 * leaves grandchildren orphaned, and this subprocess is an agent harness
 * that spawns its own.
 */
function defaultCodexSpawn(args: readonly string[], stdin: string): ChildProcess {
  const child = spawn('codex', [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    // No API key is dropped here on purpose: OPENAI_API_KEY / CODEX_API_KEY
    // being absent is exactly what makes the SDK reuse the `codex login`
    // subscription credentials, and an operator who HAS exported a key
    // presumably means to bill it.
    env: process.env,
  });
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
