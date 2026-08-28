import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { truncateToolResultContent, DEFAULT_MAX_TOOL_ITERATIONS } from './llm.js';
import { modelSupportsEffort } from './models.js';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
  ToolInvocationInfo,
} from './types.js';

/**
 * LlmClient backed by the LOCAL Claude Code installation via the Claude
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`). Activate with
 * `ATOMA_LLM=claude-cli`.
 *
 * Auth: whatever the user's `claude` CLI is logged in with — typically a
 * Claude subscription (`claude /login`). NO ANTHROPIC_API_KEY needed; in
 * fact the subprocess env deliberately DROPS an exported
 * ANTHROPIC_API_KEY so a stale key can't shadow the CLI's own OAuth
 * credentials (Claude Code prefers the env key when present).
 *
 * Implementation notes (mirrors the OllamaLlmClient provider contract):
 *   - `req.model` is mapped to the CLI's model ALIASES by tier —
 *     /haiku/→'haiku', /sonnet/→'sonnet', /opus/→'opus' — because the
 *     models a subscription serves shift over time while the aliases
 *     stay valid. The cost-discipline call-graph shape holds; the exact
 *     model versions are whatever the user's Claude Code resolves.
 *     Override everything with ATOMA_CLAUDE_MODEL=<alias-or-id>.
 *   - Tools: atoma's declared tools are exposed through an IN-PROCESS
 *     MCP server whose handlers call `req.executor` directly — the
 *     sandbox, scope, truncation, and `onToolInvocation` contracts are
 *     preserved. Built-in Claude Code tools are fully disabled
 *     (`tools: []`), so the model can ONLY use atoma's declared tools —
 *     the #8a scope gate enforced at the harness level. `toolAliases`
 *     maps bare names (write_file) onto the MCP names
 *     (mcp__atoma__write_file) so prompts written for the Anthropic
 *     provider keep working.
 *   - `settingSources: []` keeps the subprocess in SDK isolation mode:
 *     no CLAUDE.md, no project/user settings bleed into atom prompts.
 *   - `systemPrompt` is the atom's own prompt (replaces the Claude Code
 *     preset entirely — no harness prompt overhead).
 *   - Sampling params (`temperature`/`topP`) are not exposed by the CLI
 *     and are ignored, like the Ollama path. `maxTokens` is likewise
 *     advisory-only here.
 *   - Usage comes from the result message's Anthropic-shaped `usage`
 *     counters, so metrics/viz keep working. Costs shown by
 *     `estimateCostUsd` are what the tokens WOULD cost at API prices —
 *     on a subscription nothing is billed per token.
 */
/**
 * Effort pass-through gate for the CLI transport. `maxTokens` cannot be
 * enforced through the Agent SDK (documented above), which means adaptive
 * thinking runs at its default `'high'` — measured on the rehearsal runs:
 * a single `compileSkillToScript` call emitted ~20k output tokens and ran
 * ~7 minutes through the subprocess, long enough to get killed by the run
 * deadline twice in a row. `effort` IS exposed by the SDK, so a caller-
 * pinned effort is the one real lever this transport has. Same gate rule
 * as `AnthropicLlmClient`: only when the caller pinned it AND the declared
 * model (the tier pin, before alias resolution) supports the param.
 */
export function cliEffortFor(req: LlmCompletionRequest): 'low' | 'medium' | 'high' | undefined {
  if (req.params?.effort === undefined) return undefined;
  // Gate on the RESOLVED alias, exactly like cliThinkingFor below — NOT on
  // the raw pin. modelSupportsEffort is anchored on /^claude-/, so a
  // provider-agnostic tier pin like ATOMA_MODEL_L3=sonnet failed the check
  // and silently dropped the effort pin — the ONE cost lever this
  // transport has (its maxTokens is advisory-only). Measured incident
  // class: a compile at default effort ran ~7 minutes / ~20k thinking
  // tokens and was killed by the run deadline. 'sonnet'/'opus' aliases
  // take the pin; 'haiku' never carries one (atoma never sends it there);
  // anything else falls back to the id-based capability check.
  const alias = resolveCliModel(req.model);
  if (alias === 'sonnet' || alias === 'opus') return req.params.effort;
  if (alias === 'haiku') return undefined;
  if (!modelSupportsEffort(req.model)) return undefined;
  return req.params.effort;
}

/**
 * Thinking parity with the direct-API semantics. On the API, Haiku 4.5
 * thinks ONLY when a caller explicitly requests it — and atoma never does:
 * prefilters are 256-token routing decisions, verdicts are small JSON.
 * Under the Claude Code CLI, adaptive thinking defaults ON and `maxTokens`
 * is advisory-only, so those same calls ran UNBOUNDED reasoning. Measured
 * on a warm e2e run: the L3 prefilter emitted 3,017 tokens over 35.6s for
 * a decision capped at 256 tokens on the API path; five Haiku prefilters
 * ate 87s — 35% of the whole run. Disabling thinking when the call
 * resolves to the haiku alias restores the reference behaviour (the gate
 * is the RESOLVED alias, so an ATOMA_CLAUDE_MODEL override to a thinking
 * tier keeps that tier's API-default semantics). Sonnet/Opus keep the
 * CLI's adaptive default — that matches the API too, and their plan calls
 * are already bounded by the `effort` pin.
 */
export function cliThinkingFor(req: LlmCompletionRequest): { type: 'disabled' } | undefined {
  return resolveCliModel(req.model) === 'haiku' ? { type: 'disabled' } : undefined;
}


/**
 * True when a CLI "assistant text" is actually an upstream transport
 * error passed through verbatim (5xx family — transient; 4xx are real
 * request errors the caller must see).
 */
export function isCliTransportErrorText(text: string): boolean {
  return /^\s*API Error: 5\d\d\b/.test(text);
}

/**
 * INACTIVITY ceiling on a claude-cli call — the clock measures SILENCE,
 * not total duration, and every stream message or tool invocation resets
 * it. A hang is the absence of progress; a long call is not.
 *
 * It started life as a total-duration cap and that was wrong, measured:
 * a web run doing 12 headless validations (28s each, plus thinking
 * between rounds) was killed at 10 minutes while it was STILL emitting
 * tool calls — the last one 2 minutes before the axe. The guard built to
 * stop an 11-day zombie had started killing healthy work, which is the
 * one thing a hang detector must never do. Under the inactivity clock
 * the zombie (no result, no messages, forever) still dies on schedule
 * while a 24-iteration Puppeteer loop runs as long as it keeps moving.
 *
 * Override with ATOMA_CLI_CALL_TIMEOUT_MS; invalid or non-positive
 * values fall back to the default rather than disabling the guard (a
 * typo must not restore the infinite-hang behaviour).
 */
export const DEFAULT_CLI_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export function cliCallTimeoutMs(): number {
  const raw = process.env['ATOMA_CLI_CALL_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_CLI_CALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLI_CALL_TIMEOUT_MS;
}

export class ClaudeCliLlmClient implements LlmClient {
  private readonly maxIter: number;
  private readonly callTimeoutMs: number;

  constructor(opts: { maxToolIterations?: number; callTimeoutMs?: number } = {}) {
    this.maxIter = Math.max(1, opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS);
    this.callTimeoutMs =
      opts.callTimeoutMs && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : cliCallTimeoutMs();
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // TRANSIENT-OVERLOAD GUARD. The CLI subprocess surfaces upstream 5xx
    // ("API Error: 529 Overloaded") as the assistant TEXT of an otherwise
    // successful turn — observed live: a plan call returned that string,
    // parseTwoJson chewed on the error message, and the whole run died on
    // a condition that is transient BY DEFINITION. One retry after a short
    // pause; a second occurrence throws a real transport error so metrics
    // record an error call instead of a parser crash far from the cause.
    const first = await this.completeOnce(req);
    if (!isCliTransportErrorText(first.text)) return first;
    await new Promise((r) => setTimeout(r, 3000));
    const second = await this.completeOnce(req);
    if (!isCliTransportErrorText(second.text)) return second;
    // Both attempts returned usage before being judged transport errors —
    // those tokens were paid; attach them (review 2026-08-14 §1.13).
    throw attachPartialUsage(
      new Error(`claude-cli transport error (after 1 retry): ${second.text.slice(0, 200)}`),
      [first.usage, second.usage]
    );
  }

  private async completeOnce(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const hasTools = req.executor !== undefined && (req.tools?.length ?? 0) > 0;
    const budget = Math.max(1, req.maxToolIterations ?? this.maxIter);

    const abort = new AbortController();
    const onAbort = (): void => abort.abort(req.signal?.reason);
    if (req.signal) {
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted');
      req.signal.addEventListener('abort', onAbort, { once: true });
    }
    // PER-CALL DEADLINE. The run-level `AbortSignal.timeout` is ADVISORY:
    // it can only cancel work that observes it, and a subprocess wedged on
    // a dropped connection observes nothing — the stream below then never
    // yields a `result` message and the await never settles. Measured
    // consequence: a build-app process found alive after 11 DAYS with 2
    // minutes of CPU, still holding a headless Chrome and an esbuild
    // service, because one call never came back. So every call gets its
    // own clock; on expiry we abort the controller (which terminates the
    // SDK subprocess) and THROW, turning an infinite hang into an ordinary
    // transport error the supervise loop can escalate on.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Rearmed on every sign of life (stream message, tool invocation), so
    // the deadline measures SILENCE rather than elapsed time.
    const bumpDeadline = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort(new Error(`claude-cli call idle for ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);
    };
    let lastAssistantText = '';
    // Resolved ONCE and reported back as `servedModel`: this transport maps
    // tier pins onto CLI aliases (haiku/sonnet/opus), so pricing on the raw
    // pin would misattribute the tokens (review 2026-08-14 §1.13).
    const served = resolveCliModel(req.model);
    try {
      bumpDeadline();
      const toolOptions = hasTools
        ? buildToolBridge(req.tools!, req)
        : { mcpServers: undefined, allowedTools: undefined, toolAliases: undefined };
      const stream = query({
        prompt: req.userContent,
        options: {
          model: served,
          systemPrompt: req.systemPrompt,
          // SDK isolation: no CLAUDE.md / settings bleed, no built-in tools.
          settingSources: [],
          tools: [],
          ...(toolOptions.mcpServers ? { mcpServers: toolOptions.mcpServers } : {}),
          ...(toolOptions.allowedTools ? { allowedTools: toolOptions.allowedTools } : {}),
          ...(toolOptions.toolAliases ? { toolAliases: toolOptions.toolAliases } : {}),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          ...(cliEffortFor(req) ? { effort: cliEffortFor(req) } : {}),
          ...(cliThinkingFor(req) ? { thinking: cliThinkingFor(req) } : {}),
          maxTurns: hasTools ? budget : 2,
          abortController: abort,
          // THE LOGIN SESSION, AND NOTHING ELSE. Dropping a stale
          // `ANTHROPIC_API_KEY` used to be tidiness — one variable, so the
          // CLI's own OAuth login authenticates the subprocess. Since a tier
          // may now be pinned to this transport while other tiers bill real
          // keys, it is LOAD-BEARING for the payer guarantee: any inherited
          // variable that could re-credential or redirect this subprocess
          // would silently move the payer of a tier the journal has already
          // named (design 2026-08-28, D9). So the whole `ANTHROPIC_*` family
          // goes, plus the two gateway switches that reroute Claude Code to
          // another vendor's account.
          env: subscriptionTransportEnv(process.env),
        },
      });

      for await (const msg of stream) {
        bumpDeadline();
        if (msg.type === 'assistant') {
          const blocks = msg.message?.content;
          if (Array.isArray(blocks)) {
            const text = blocks
              .filter((b) => b.type === 'text')
              .map((b) => (b as { text: string }).text)
              .join('\n');
            if (text.trim().length > 0) lastAssistantText = text;
          }
          continue;
        }
        if (msg.type === 'result') {
          const usage = msg.usage;
          const mapped = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens || undefined,
            cacheReadInputTokens: usage.cache_read_input_tokens || undefined,
          };
          if (msg.subtype === 'success') {
            return {
              text: msg.result || lastAssistantText,
              stopReason: msg.stop_reason ?? 'end_turn',
              usage: mapped,
              servedModel: served,
            };
          }
          // Non-success result (error_max_turns, error_during_execution, ...):
          // salvage the last assistant text when there is one — the callers'
          // JSON parsers are tolerant and a truncated-but-present payload
          // beats a hard throw (mirrors the Anthropic client's graceful
          // budget-exhausted finalization).
          if (lastAssistantText) {
            return {
              text: lastAssistantText,
              stopReason: msg.subtype,
              usage: mapped,
              servedModel: served,
            };
          }
          // The usage was computed above and used to be DISCARDED here —
          // the one claude-cli path that lost paid tokens on error
          // (review 2026-08-14 §1.13). Same `partialUsage` contract as
          // AnthropicLlmClient.raise (e15d810).
          throw attachPartialUsage(
            new Error(`claude-cli query ended without output: ${msg.subtype}`),
            [mapped]
          );
        }
      }
      throw new Error('claude-cli query stream ended without a result message');
    } catch (err) {
      // The abort surfaces here as whatever the SDK throws on cancellation;
      // re-label it so the cause is unmistakable in the trace instead of a
      // generic "aborted" that reads like a user interrupt.
      if (timedOut) {
        throw new Error(
          `claude-cli call produced no output for ${this.callTimeoutMs}ms (idle — dropped connection?)`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Attach paid-for tokens to an error leaving this transport — the exact
 * `partialUsage` property AnthropicLlmClient.raise established (e15d810),
 * mirrored here per review 2026-08-14 §1.13: claude-cli used to compute
 * usage from the result message and then discard it on the throw, so
 * MetricsLlmClient recorded zeros for tokens already billed. Sums multiple
 * usages because the transport-error retry path pays for TWO attempts.
 */
function attachPartialUsage(
  err: Error,
  usages: readonly LlmCompletionResponse['usage'][]
): Error {
  try {
    (err as Error & { partialUsage?: object }).partialUsage = usages.reduce<{
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    }>(
      (acc, u) => ({
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + (u.cacheCreationInputTokens ?? 0),
        cacheReadInputTokens: acc.cacheReadInputTokens + (u.cacheReadInputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    );
  } catch {
    // frozen/exotic errors can't carry properties — fine.
  }
  return err;
}

/**
 * The environment the subscription subprocess runs in: the caller's, minus
 * everything that could authenticate or redirect it somewhere else.
 *
 * Exported because this is a payer guarantee, and a guarantee nothing can
 * observe is a comment. `tests/llm-claude-cli.test.ts` pins the constructed
 * env rather than trusting the call site.
 */
export function subscriptionTransportEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_')) delete env[key];
  }
  // Not `ANTHROPIC_*`-prefixed, and both reroute Claude Code onto a cloud
  // account whose bill is not the operator's login.
  delete env['CLAUDE_CODE_USE_BEDROCK'];
  delete env['CLAUDE_CODE_USE_VERTEX'];
  return env;
}

/**
 * Map atoma's pinned per-tier model ids onto Claude Code model aliases.
 * Exported for tests.
 */
export function resolveCliModel(model: string): string {
  // Debug-only escape hatch: collapse EVERY tier onto one model. This
  // deliberately breaks the cheapest-model-that-can-answer gradient — its
  // only legitimate uses are tier-isolation debugging and smoke tests.
  // PER-TIER selection does not live here: it's the provider-agnostic
  // ATOMA_MODEL_L1/L2/L3 (src/core/models.ts), whose values arrive as
  // req.model — aliases like 'sonnet' pass straight through below.
  const override = process.env['ATOMA_CLAUDE_MODEL'];
  if (override && override.trim().length > 0) return override.trim();
  if (/haiku/i.test(model)) return 'haiku';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  return model;
}

/**
 * Build the in-process MCP server bridging atoma's declared tools to
 * `req.executor`, plus the allowlist and bare-name aliases the query
 * options need. The MCP tool namespace is `mcp__atoma__<name>`.
 */
function buildToolBridge(
  tools: Tool[],
  req: LlmCompletionRequest
): {
  mcpServers: Record<string, { type: 'sdk'; name: string; instance: McpServer }>;
  allowedTools: string[];
  toolAliases: Record<string, string>;
} {
  const server = new McpServer({ name: 'atoma', version: '1.0.0' });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: jsonSchemaToZodShape(t.inputSchema),
      },
      async (args: Record<string, unknown>) => {
        const startedAt = Date.now();
        try {
          const result = await req.executor!.execute(t.name, args ?? {});
          notify(req.onToolInvocation, {
            name: t.name,
            args: args ?? {},
            result,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: truncateToolResultContent(
                  typeof result === 'string' ? result : JSON.stringify(result)
                ),
              },
            ],
          };
        } catch (err) {
          const errMsg = (err as Error).message;
          notify(req.onToolInvocation, {
            name: t.name,
            args: args ?? {},
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: truncateToolResultContent(`tool "${t.name}" failed: ${errMsg}`),
              },
            ],
            isError: true,
          };
        }
      }
    );
  }
  const allowedTools = tools.map((t) => `mcp__atoma__${t.name}`);
  const toolAliases = Object.fromEntries(tools.map((t) => [t.name, `mcp__atoma__${t.name}`]));
  return {
    mcpServers: { atoma: { type: 'sdk', name: 'atoma', instance: server } },
    allowedTools,
    toolAliases,
  };
}

/**
 * Convert atoma's flat JSON-Schema tool declarations into a zod3 raw
 * shape for MCP `registerTool`. Handles the shapes the builtin toolbox
 * actually uses (string / number / boolean / array-of-string / object
 * passthrough); anything unrecognised degrades to z.unknown() so a new
 * tool can't crash the bridge. Exported for tests.
 */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : []
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let zt: z.ZodTypeAny;
    switch (prop['type']) {
      case 'string':
        zt = z.string();
        break;
      case 'number':
        zt = z.number();
        break;
      case 'integer':
        zt = z.number().int();
        break;
      case 'boolean':
        zt = z.boolean();
        break;
      case 'array': {
        const items = prop['items'] as Record<string, unknown> | undefined;
        zt = items?.['type'] === 'string' ? z.array(z.string()) : z.array(z.unknown());
        break;
      }
      case 'object':
        zt = z.record(z.unknown());
        break;
      default:
        zt = z.unknown();
    }
    const description = prop['description'];
    if (typeof description === 'string') zt = zt.describe(description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

function notify(
  cb: ((info: ToolInvocationInfo) => void) | undefined,
  info: ToolInvocationInfo
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // observer failure must not poison execution
  }
}
