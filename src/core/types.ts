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
  /**
   * Overwrite the atom type's short human-readable description. Useful when a
   * validator realises that a branched/patched atom's *purpose* has drifted
   * from its original template (e.g. a "platformer builder" description on a
   * type whose system prompt now targets Minesweeper). The description is
   * what the prefilter sees when choosing a catalog entry, so keeping it in
   * sync with the actual system prompt matters for routing accuracy.
   */
  descriptionReplace?: string;
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
  branchName?: string;
};
export type Verdict = PositiveVerdict | NegativeVerdict;

export interface TraceEntry {
  kind:
    | 'plan'
    | 'verdict-plan'
    | 'execute'
    | 'verdict-result'
    | 'applied-modifications'
    | 'repeat-rejection'
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
  /**
   * Abort signal forwarded to the underlying transport. The Anthropic SDK
   * honours this on each HTTP round-trip, so a global run-deadline (usually
   * `RunContext.signal`) can actually cancel long-running completions and
   * tool-loop iterations. Atom call sites thread `ctx.signal` here.
   */
  signal?: AbortSignal;
  /**
   * Upper bound on tool-use iterations for this single call. Each iteration
   * is one round-trip to the model; when the model replies with `tool_use`
   * we execute the tools, send the results back, and loop again. Tasks with
   * long convergence patterns (e.g. a build-app L1 that iterates on a
   * validate_html → fix → re-validate cycle) need more budget than a
   * one-shot reasoning call. When the budget is exhausted the client does
   * a final tools-disabled round-trip to force a text response rather than
   * throwing. Defaults to 24 if omitted.
   */
  maxToolIterations?: number;
  /**
   * Observer callback invoked for every tool invocation inside the tool-use
   * loop, once per tool_use block. Fires AFTER the tool has run (success or
   * failure) so the callback sees the observed result. Used by
   * `RecordingLlmClient` to emit `VizToolEvent`s into the trace — the recorder
   * is the only known caller today, but the hook is kept general so e.g.
   * metrics or audit decorators can plug in later. Must not throw; errors
   * from this callback are swallowed so observability never breaks execution.
   */
  onToolInvocation?: (info: ToolInvocationInfo) => void;
}

export interface ToolInvocationInfo {
  /** Tool name exactly as declared on the atom. */
  name: string;
  /** JSON-serialisable args the model sent to the tool. */
  args: Record<string, unknown>;
  /** Raw return value from the tool executor, if the call succeeded. */
  result?: unknown;
  /** Error message, if the tool threw. Mutually exclusive with `result`. */
  error?: string;
  /** Wall time from executor start to callback invocation. */
  durationMs: number;
  /** Wall-clock timestamp at which the tool call STARTED (`Date.now()`). */
  startedAt: number;
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
