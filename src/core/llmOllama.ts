import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
  ToolInvocationInfo,
} from './types.js';

/**
 * `LlmClient` backed by Ollama's chat API. Lets atoma run against a
 * local (or Ollama-Cloud-tagged) model instead of Anthropic.
 *
 * The default target is `glm-5.1:cloud` — Ollama Cloud's GLM-5.1 tag,
 * which supports tool calling and 198K context. Any Ollama model with
 * tool-calling support will work; pass its tag via `defaultModel`.
 *
 * Architectural notes:
 * - Ollama doesn't implement Anthropic's `cache_control` semantics, so
 *   the atom layer's cache-hinting decorators are silently dropped.
 *   Performance comparison vs Anthropic + prompt caching is provider-
 *   specific; don't expect the same cost-per-run profile as the
 *   Haiku-heavy happy path. The `usage.cacheReadInputTokens` field
 *   stays at 0 — it's a metric for Anthropic runs only.
 * - The `req.model` field is IGNORED here: the atom code dispatches
 *   between PIN_HAIKU / PIN_SONNET / FALLBACK_OPUS based on tier, but
 *   Ollama runs a single model per endpoint. Hence all three tiers'
 *   requests land on the configured `defaultModel`. Cost-discipline
 *   decisions made at atom level (validator on cheap, plan on
 *   expensive) still structure the CALL GRAPH, but the underlying
 *   per-call cost becomes uniform.
 * - Declared-tools scope enforcement (#8a) and onToolInvocation
 *   mirror the Anthropic client: an LLM that asks for a tool not in
 *   `req.tools` gets a tool_result error and the executor isn't
 *   touched, preserving the safety contract across providers.
 */
export interface OllamaLlmClientOptions {
  /** Default: `http://localhost:11434` (Ollama's local API). */
  baseUrl?: string;
  /** Default: `glm-5.1:cloud`. */
  defaultModel?: string;
  /** Default: 24 (mirrors AnthropicLlmClient's DEFAULT_MAX_TOOL_ITERATIONS). */
  maxToolIterations?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'glm-5.1:cloud';
const DEFAULT_MAX_TOOL_ITERATIONS = 24;

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OllamaToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly maxIter: number;

  constructor(opts: OllamaLlmClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.maxIter = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const model = this.defaultModel;
    const messages: OllamaMessage[] = [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userContent },
    ];

    const ollamaTools = req.tools && req.tools.length > 0 ? req.tools.map(toOllamaTool) : undefined;
    // #8a declared-tools scope gate — identical semantics to the
    // AnthropicLlmClient: an off-scope tool_use is turned into a tool
    // result with an error message, the executor is not invoked, and
    // the onToolInvocation observer fires with `error` set. See
    // src/core/llm.ts comments for the full rationale.
    const declaredToolNames =
      req.tools && req.tools.length > 0 ? new Set(req.tools.map((t) => t.name)) : null;

    const options: Record<string, unknown> = {};
    if (req.params?.temperature !== undefined) options['temperature'] = req.params.temperature;
    if (req.params?.maxTokens !== undefined) options['num_predict'] = req.params.maxTokens;
    if (req.params?.topP !== undefined) options['top_p'] = req.params.topP;

    const budget = req.maxToolIterations ?? this.maxIter;
    let aggInput = 0;
    let aggOutput = 0;
    let finalText = '';
    let stopReason: string | null = null;

    for (let iter = 0; iter < budget; iter++) {
      if (req.signal?.aborted) {
        throw req.signal.reason instanceof Error
          ? req.signal.reason
          : new Error('aborted');
      }

      const body = {
        model,
        messages,
        stream: false,
        ...(ollamaTools ? { tools: ollamaTools } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };

      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Ollama HTTP ${resp.status}: ${errText.slice(0, 400)}`);
      }
      const json = (await resp.json()) as OllamaChatResponse;

      aggInput += json.prompt_eval_count ?? 0;
      aggOutput += json.eval_count ?? 0;

      const msg = json.message;
      if (!msg) throw new Error('Ollama response missing `message`');
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const shouldLoop = toolCalls.length > 0 && req.executor !== undefined;

      if (!shouldLoop) {
        finalText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        stopReason = json.done_reason ?? (json.done ? 'stop' : null);
        break;
      }

      // Preserve the assistant turn verbatim so a subsequent `tool` turn
      // can refer to it by tool_call_id (when Ollama provides one).
      messages.push(msg as OllamaMessage);

      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        if (typeof toolName !== 'string') {
          // Malformed tool call from the model — skip.
          continue;
        }
        const rawArgs = tc.function?.arguments;
        const args: Record<string, unknown> =
          typeof rawArgs === 'string'
            ? (safeParseJson(rawArgs) as Record<string, unknown>) ?? {}
            : (rawArgs ?? {});
        const startedAt = Date.now();

        // Scope gate.
        if (declaredToolNames && !declaredToolNames.has(toolName)) {
          const declared = [...declaredToolNames].sort().join(', ');
          const errMsg = `tool "${toolName}" is NOT in your declared tools. You may only invoke: ${declared}. Do not call "${toolName}" again for this task.`;
          messages.push({
            role: 'tool',
            content: errMsg,
            ...(tc.id ? { tool_call_id: tc.id } : {}),
            name: toolName,
          });
          notify(req.onToolInvocation, {
            name: toolName,
            args,
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
          continue;
        }

        try {
          const result = await req.executor!.execute(toolName, args);
          messages.push({
            role: 'tool',
            content: typeof result === 'string' ? result : JSON.stringify(result),
            ...(tc.id ? { tool_call_id: tc.id } : {}),
            name: toolName,
          });
          notify(req.onToolInvocation, {
            name: toolName,
            args,
            result,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          messages.push({
            role: 'tool',
            content: `tool "${toolName}" failed: ${errMsg}`,
            ...(tc.id ? { tool_call_id: tc.id } : {}),
            name: toolName,
          });
          notify(req.onToolInvocation, {
            name: toolName,
            args,
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
        }
      }
    }

    if (finalText === '' && stopReason === null) {
      // Budget exhausted without a final assistant text turn. Mirror the
      // Anthropic client's "tool budget exhausted" fallback by doing
      // ONE tools-disabled round-trip to force a final text reply.
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            ...messages,
            {
              role: 'user',
              content:
                '== TOOL BUDGET EXHAUSTED == Return your best final answer now as plain text; no more tool calls will be permitted.',
            },
          ],
          stream: false,
          ...(Object.keys(options).length > 0 ? { options } : {}),
        }),
        signal: req.signal,
      });
      if (resp.ok) {
        const json = (await resp.json()) as OllamaChatResponse;
        aggInput += json.prompt_eval_count ?? 0;
        aggOutput += json.eval_count ?? 0;
        finalText = json.message?.content ?? '';
        stopReason = 'tool_budget_exhausted';
      }
    }

    return {
      text: finalText,
      stopReason,
      usage: {
        inputTokens: aggInput,
        outputTokens: aggOutput,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  }
}

function toOllamaTool(t: Tool): {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}

function notify(cb: ((info: ToolInvocationInfo) => void) | undefined, info: ToolInvocationInfo): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // observer errors never break the tool loop
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
