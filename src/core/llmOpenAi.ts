import OpenAI from 'openai';
import {
  BUDGET_EXHAUSTED_HINT,
  DEFAULT_MAX_TOOL_ITERATIONS,
  coercePseudoFinalToolCall,
  offScopeToolMessage,
  truncateToolResultContent,
} from './llm.js';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
  ToolInvocationInfo,
} from './types.js';

/**
 * OPENAI BY API — the `api:openai:` transport (`contracts/modelSelector.ts`).
 *
 * The Responses API with function tools, so this transport hosts atoma's tool
 * loop and is admissible on EVERY tier, L1 included — unlike the Codex CLI
 * (`sub:openai:` / `own:openai:`), which cannot expose only atoma's tools and
 * is therefore supervisor-only. Same loop contract as `AnthropicLlmClient`:
 * declared-tools scope gate (#8a), head/tail truncation of tool results, one
 * tools-disabled finalisation round when the iteration budget runs out, and
 * the usage aggregated so far attached to any error leaving the loop.
 *
 * STATE LIVES SERVER-SIDE BETWEEN ROUNDS. Each tool round sends only the new
 * `function_call_output` items with `previous_response_id`, so reasoning items
 * the model produced (which GPT-5 requires back verbatim beside its function
 * calls) never have to be replayed by hand. Tools and instructions are resent
 * on every round because the API does not carry them over.
 *
 * ACCOUNTING follows the Anthropic shape the rest of the system prices:
 * `input_tokens` on this API INCLUDES cached tokens, so the cached share is
 * subtracted out into `cacheReadInputTokens` and the remainder is billed as
 * fresh input. Reasoning tokens are part of `output_tokens` and are billed as
 * output, which is what the vendor does too.
 */

export const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * GPT-5 and the o-series are reasoning models: they reject `temperature` /
 * `top_p` and accept `reasoning.effort` instead. Everything else is the other
 * way round. One predicate, both decisions.
 */
export function openAiModelIsReasoning(model: string): boolean {
  return /^(?:gpt-5|o\d)/i.test(model.trim());
}

export interface OpenAiLlmClientOptions {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  /** Test seam: a pre-built SDK client. */
  readonly client?: OpenAI;
}

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type FunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall;
type OpenAiResponse = OpenAI.Responses.Response;

export class OpenAiLlmClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(opts: OpenAiLlmClientOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const apiKey = opts.apiKey?.trim();
    if (!apiKey) {
      throw new Error(
        'api:openai requires OPENAI_API_KEY — export it (optional: OPENAI_BASE_URL), or select ' +
          'sub:openai:<model> to spend a ChatGPT subscription through the Codex CLI on L2/L3'
      );
    }
    this.client = new OpenAI({
      apiKey,
      ...(opts.baseUrl?.trim() ? { baseURL: opts.baseUrl.trim() } : {}),
    });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const tools = toOpenAiTools(req.tools ?? []);
    const reasoning = openAiModelIsReasoning(req.model);
    const agg = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    const raise = (err: unknown): never => {
      try {
        (err as { partialUsage?: typeof agg }).partialUsage = { ...agg };
      } catch {
        // frozen/exotic abort reasons can't carry properties — fine.
      }
      throw err;
    };
    const accumulate = (response: OpenAiResponse): void => {
      const usage = response.usage;
      if (!usage) return;
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      agg.inputTokens += Math.max(0, usage.input_tokens - cached);
      agg.cacheReadInputTokens += cached;
      agg.outputTokens += usage.output_tokens;
    };

    const send = async (
      input: ResponseInputItem[],
      previousResponseId: string | undefined,
      disableTools: boolean
    ): Promise<OpenAiResponse> => {
      if (req.signal?.aborted) raise(req.signal.reason ?? new Error('aborted'));
      try {
        return await this.client.responses.create(
          {
            model: req.model,
            instructions: req.systemPrompt,
            input,
            max_output_tokens: req.params?.maxTokens ?? OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
            ...(tools.length > 0
              ? { tools, tool_choice: disableTools ? ('none' as const) : ('auto' as const) }
              : {}),
            ...(reasoning
              ? req.params?.effort !== undefined
                ? { reasoning: { effort: req.params.effort } }
                : {}
              : {
                  temperature: req.params?.temperature ?? 0.2,
                  ...(req.params?.topP !== undefined ? { top_p: req.params.topP } : {}),
                }),
          },
          req.signal ? { signal: req.signal } : {}
        );
      } catch (err) {
        return raise(err);
      }
    };

    const budget = Math.max(1, req.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS);
    const declaredToolNames =
      req.tools && req.tools.length > 0 ? new Set(req.tools.map((t) => t.name)) : null;
    let input: ResponseInputItem[] = [{ role: 'user', content: req.userContent }];
    let previousResponseId: string | undefined;
    let finalResponse: OpenAiResponse | null = null;
    let syntheticFinalText: string | null = null;

    for (let iter = 0; iter < budget; iter++) {
      const response = await send(input, previousResponseId, false);
      accumulate(response);
      previousResponseId = response.id;

      const calls = response.output.filter(
        (item): item is FunctionToolCall => item.type === 'function_call'
      );
      if (calls.length === 0 || req.executor === undefined) {
        finalResponse = response;
        break;
      }

      if (calls.length === 1 && declaredToolNames && !declaredToolNames.has(calls[0]!.name)) {
        const pseudoFinal = coercePseudoFinalToolCall(calls[0]!.name, parseArguments(calls[0]!));
        if (pseudoFinal) {
          syntheticFinalText = pseudoFinal;
          finalResponse = response;
          break;
        }
      }

      const outputs: ResponseInputItem[] = [];
      for (const call of calls) {
        const args = parseArguments(call);
        const startedAt = Date.now();
        if (declaredToolNames && !declaredToolNames.has(call.name)) {
          const errMsg = offScopeToolMessage(declaredToolNames, call.name);
          outputs.push({ type: 'function_call_output', call_id: call.call_id, output: errMsg });
          notifyToolInvocation(req.onToolInvocation, {
            name: call.name,
            args,
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
          continue;
        }
        try {
          const result = await req.executor.execute(call.name, args);
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: truncateToolResultContent(
              typeof result === 'string' ? result : JSON.stringify(result)
            ),
          });
          notifyToolInvocation(req.onToolInvocation, {
            name: call.name,
            args,
            result,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: truncateToolResultContent(`tool "${call.name}" failed: ${errMsg}`),
          });
          notifyToolInvocation(req.onToolInvocation, {
            name: call.name,
            args,
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
        }
      }

      if (iter === budget - 1) {
        // Graceful finalisation: the last slot went to tool execution, so
        // one tools-disabled round coaxes a text answer instead of throwing.
        const finalResp = await send(
          [...outputs, { role: 'user', content: BUDGET_EXHAUSTED_HINT }],
          previousResponseId,
          true
        );
        accumulate(finalResp);
        finalResponse = finalResp;
        break;
      }
      input = outputs;
    }

    if (!finalResponse) {
      throw new Error(
        `OpenAiLlmClient: tool loop exited without a final response (budget=${budget})`
      );
    }

    return {
      text: syntheticFinalText ?? finalResponse.output_text,
      stopReason: syntheticFinalText ? 'end_turn' : stopReasonOf(finalResponse),
      usage: {
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        cacheReadInputTokens: agg.cacheReadInputTokens || undefined,
      },
      servedModel: finalResponse.model,
    };
  }
}

function parseArguments(call: FunctionToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || '{}') as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The vocabulary the rest of the system reads (`Anthropic.Messages.Message['stop_reason']`). */
function stopReasonOf(response: OpenAiResponse): string {
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
  }
  return response.output.some((item) => item.type === 'function_call') ? 'tool_use' : 'end_turn';
}

function toOpenAiTools(tools: Tool[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    // atoma's tool schemas are not authored for strict mode (optional fields,
    // additionalProperties), and strict mode rejects them; the executor
    // validates arguments itself.
    strict: false,
  }));
}

function notifyToolInvocation(
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
