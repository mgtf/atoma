export type Tier = 1 | 2 | 3;

export interface Task {
  readonly description: string;
  readonly inputs?: Record<string, unknown>;
  readonly constraints?: string[];
}

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface GenerationParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface Plan {
  readonly reasoning: string;
  readonly proposedAction: string;
  readonly toolCalls?: ToolCall[];
  readonly expectedOutput: string;
}

export interface Result {
  readonly output: unknown;
  readonly summary: string;
  readonly toolCallResults?: unknown[];
  readonly trace: TraceEntry[];
  readonly producedBy: { tier: Tier; name: string; viaFallback: boolean };
}

export type MutationScope = 'ephemeral' | 'branch' | 'patch';

export interface AtomModifications {
  systemPromptAppend?: string;
  systemPromptReplace?: string;
  addTools?: Tool[];
  removeTools?: string[];
  params?: Partial<GenerationParams>;
  additionalContext?: string;
}

export type PositiveVerdict = { approved: true; reasoning: string };
export type NegativeVerdict = {
  approved: false;
  reasoning: string;
  modifications: AtomModifications;
  scope: MutationScope;
  branchName?: string | null;
};
export type Verdict = PositiveVerdict | NegativeVerdict;

export interface TraceEntry {
  kind:
    | 'plan'
    | 'verdict-plan'
    | 'execute'
    | 'verdict-result'
    | 'applied-modifications'
    | 'escalated';
  ts: string;
  atom: string;
  payload: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface Limits {
  readonly maxPlanIterations: number;
  readonly maxExecIterations: number;
}

export interface LlmCompletionRequest {
  model: string;
  systemPrompt: string;
  userContent: string;
  tools?: Tool[];
  params?: GenerationParams;
  cacheSystem?: boolean;
  cacheTools?: boolean;
  /**
   * If provided, the LLM client will run a tool-use loop: any `tool_use`
   * blocks returned by the model are executed locally via this executor and
   * their results are sent back to the model until it returns a final text
   * response. Without it the client returns the first response as-is.
   */
  executor?: ToolExecutor;
}

export interface LlmCompletionResponse {
  text: string;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
}

export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

/**
 * Executes a declared tool by name. Implementations are usually backed by an
 * in-memory map populated at app startup (the registry stores only the
 * serializable declaration — name/description/schema — so executors live
 * outside the DB).
 */
export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  has(name: string): boolean;
}

export interface RunContext {
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly llm: LlmClient;
  readonly limits: Limits;
  /** Optional: tool executor used by atoms when the LLM emits tool_use blocks. */
  readonly tools?: ToolExecutor;
}
