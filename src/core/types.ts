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
  /**
   * Reasoning-depth hint (`output_config: {effort}`) for models that
   * support it (Sonnet 4.6+/5, Opus 4.5+/5 — the client gates via
   * `modelSupportsEffort`; Haiku rejects the param). Plan/strategy call
   * sites pin `'medium'`: those models default to `'high'`, the most
   * expensive setting, and a routing JSON pair does not need it.
   */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * One unit of work a supervisor hands to a child atom. Spelled out as its
 * own shape (rather than reusing `Task`) because a subtask carries a
 * routing hint (`preferredChild`) that has no place at the task-level API.
 * `description` is the "what" the child must accomplish. `inputs` is an
 * optional structured payload passed through the child's Task at
 * supervision time. `preferredChild` is a soft hint — the supervisor's
 * prefilter/create path still gets the final say — meant for planners
 * that already know which catalog entry fits best.
 */
export interface SubtaskSpec {
  readonly description: string;
  readonly inputs?: Record<string, unknown>;
  readonly preferredChild?: string;
}

/**
 * How a supervisor combines the N `Result`s produced by its subtasks into
 * the single `Result` it returns to its own supervisor. Three modes:
 *   - `concat`: mechanical aggregation — outputs concatenated into an
 *     array, summaries joined. Cheap (no LLM call), useful when sub-
 *     results are naturally independent artefacts (ex: N research
 *     summaries → 1 brief). Subtasks run in PARALLEL via Promise.all.
 *   - `llm-synthesize`: the supervisor's own model is called with the N
 *     sub-results and `instruction` to produce a final structured
 *     output. Expensive but necessary when the final deliverable is a
 *     COMBINED artefact (ex: L1s produce layout/logic/rendering
 *     fragments → the L2 synthesizer assembles them into `index.html`).
 *     Subtasks run in PARALLEL via Promise.all.
 *   - `sequential`: subtasks run ONE AT A TIME, with each step's summary
 *     threaded into the next step's `inputs.previousStepSummary`. The
 *     final aggregated result is the LAST step's output (no extra LLM
 *     call). Use when phases share an artefact that EVOLVES across
 *     steps (build-then-extend-then-smoke on the same file). The
 *     workspace filesystem is implicitly shared, so phases mutate the
 *     same on-disk artefact; the threaded `previousStepSummary` carries
 *     the narrative state, not the bytes.
 */
export interface AggregationSpec {
  readonly mode: 'concat' | 'llm-synthesize' | 'sequential';
  readonly instruction?: string;
}

/**
 * Fan-out plan emitted by L2/L3 supervisors. `subtasks` is ALWAYS at
 * least length 1 — a "single-subtask" plan is the degenerate fan-out
 * case, not a separate shape. This keeps the execute loop uniform:
 * `Promise.all(subtasks.map(run))` trivially collapses to a single
 * child run when N=1.
 */
export interface Plan {
  readonly reasoning: string;
  readonly subtasks: readonly SubtaskSpec[];
  readonly aggregation: AggregationSpec;
  readonly expectedOutput: string;
  /**
   * Legacy single-action hint, kept for L1 plans (which still describe
   * a single direct action) and for backwards-compat with older
   * `{reasoning, proposedAction, expectedOutput}` shapes. Optional on
   * fan-out plans — the subtasks carry the detail.
   */
  readonly proposedAction?: string;
  readonly toolCalls?: ToolCall[];
  /**
   * Internal provenance marker set when a plan was synthesised by the
   * Haiku prefilter short-circuit in L2/L3.plan (not by the full
   * Sonnet/Opus strategy call). The supervisor's validatePlan treats
   * such plans as already-vetted — see planSchema docs in json.ts and
   * L2Atom.validatePlan for the full rationale. LLMs never set this
   * field; the plan synthesiser in L2/L3 does.
   */
  readonly viaPrefilter?: boolean;
}

export interface Result {
  readonly output: unknown;
  readonly summary: string;
  readonly toolCallResults?: unknown[];
  readonly trace: TraceEntry[];
  readonly producedBy: { tier: Tier; name: string; viaFallback: boolean };
  /**
   * Machine-checkable witnesses extracted from the payload at production
   * time (see src/contracts/witness.ts). VERIFICATION-FIRST principle: a
   * result carrying witnesses is structurally stronger evidence than one
   * carrying narrative alone — validators and projections read this typed
   * field instead of re-parsing `output`. Optional because fallback paths
   * and legacy producers may not populate it; absence means "no
   * machine-checkable evidence", never "verified".
   */
  readonly evidence?: readonly import('../contracts/witness.js').Witness[];
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

export type PositiveVerdict = {
  approved: true;
  reasoning: string;
  /**
   * Usage-conditioned skill credit (adherence gate). Set by the RESULT
   * validator ONLY when the run was driven by an injected skill: `true`
   * when the child demonstrably followed the recipe, `false` when it
   * visibly ignored it and solved the task another way. `undefined`
   * means "unknown" (no skill active, validator omitted it, or the
   * trust fast-path skipped the LLM) and preserves legacy behaviour —
   * skill counters only stop moving on an EXPLICIT `false`. Orthogonal
   * to `approved`: adherence routes credit, it never gates approval.
   */
  activeSkillFollowed?: boolean;
};
export type NegativeVerdict = {
  approved: false;
  reasoning: string;
  modifications: AtomModifications;
  scope: MutationScope;
  branchName?: string;
  /** See PositiveVerdict.activeSkillFollowed — same semantics on rejections. */
  activeSkillFollowed?: boolean;
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
    | 'escalated'
    | 'branch-retry';
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
  /**
   * Optional fan-out lane identifier echoed back on trace events emitted
   * for this completion (the LLM event itself AND any tool events from
   * its tool-use loop). Callers usually copy this from
   * `RunContext.currentBranchId` — see L2/L3 runSubtask. Not the same
   * thing as the completion's own id; multiple completions within the
   * same branch share this value.
   */
  branchId?: string;
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

/**
 * Observability hook fired whenever a supervisor short-circuits validation
 * via the trust fast-path (`shouldTrustType` / `trustedApproval`). Such
 * decisions skip the LLM call entirely and therefore don't appear in the
 * trace as `kind: 'llm'` events — but they ARE real supervision decisions
 * that the visualiser should show, otherwise the lane for a trusted atom
 * looks suspiciously empty ("zero L2 calls" puzzles users reasonably). The
 * hook is optional to keep core decoupled from the viz layer.
 */
export interface TrustFastPathInfo {
  supervisorName: string;
  supervisorTier: Tier;
  childName: string;
  childTier: Tier;
  subject: 'PLAN' | 'RESULT';
  successes: number;
  failures: number;
  /** Reasoning text synthesised by `trustedApproval` (echoed verbatim). */
  reasoning: string;
  /** Fan-out lane id — set by `forkBranch` when the trust check happens inside a subtask. */
  branchId?: string;
}

/**
 * A routing decision served from the prefilter DECISION CACHE instead of
 * an LLM call. Recorded because the alternative is invisibility: a cache
 * hit produces no llm event at all, so a run that routed for free reads
 * as a run that mysteriously made fewer Haiku calls. Same reasoning as
 * `TrustFastPathInfo` — the cheapest paths must be the ones you can SEE,
 * otherwise the cost story is unverifiable.
 */
export interface CacheHitInfo {
  /** Which decision was replayed — 'reuse <target>' or 'escalate'. */
  outcome: string;
  /** Verbatim reasoning of the cached decision. */
  reasoning: string;
  /** Model the ORIGINAL decision was made with (the call we skipped). */
  model: string;
  /** Caller attribution, when the prefilter received one. */
  actorName?: string;
  actorTier?: Tier;
  /** Fan-out lane id, echoed from the branch-scoped context. */
  branchId?: string;
}

/**
 * Skill-pipeline event surfaced to the trace recorder. Mirrors the shape of
 * `VizSkillEvent` minus the storage-layer fields (id/ts/kind), so call sites
 * in L2Atom.ts emit a typed payload rather than reaching into the viz module
 * directly. The recorder fills in id + ts and tags `kind: 'skill'`.
 *
 * `op` semantics — see VizSkillEvent in src/viz/trace.ts for the canonical
 * documentation. Kept in sync because the union here is the source of truth
 * for what L2 may emit.
 */
export interface SkillEventInfo {
  op:
    | 'match'
    | 'inject'
    | 'learn'
    | 'update'
    | 'success'
    | 'failure'
    | 'promote'
    | 'demote'
    | 'direct'
    | 'quarantine'
    | 'credit-withheld';
  l1Name: string;
  skillId: string;
  actorName: string;
  actorTier: Tier;
  /** Match reasoning, validator diagnosis, body excerpt — free-form. */
  reasoning?: string;
  /** Fan-out lane id — set by `forkBranch` when the event happens inside a subtask. */
  branchId?: string;
}

export interface RunContext {
  readonly logger: Logger;
  /**
   * Run-scoped memo of deterministic-dispatch outputs: skill id → the
   * summaries its dispatches already returned during THIS run. Lazily
   * initialised by L2.runSubtask; deliberately on the CONTEXT because it
   * must survive supervisor replans, which build fresh L2/L1 instances
   * (epoch-5 run 5: a content-rejected dispatch was re-produced
   * byte-identically six times across replans — no instance-level state
   * could have seen it). Mutable by design.
   */
  dispatchedScriptSignatures?: Map<string, string[]>;
  readonly signal: AbortSignal;
  readonly llm: LlmClient;
  readonly limits: Limits;
  /** Optional: tool executor used by atoms when the LLM emits tool_use blocks. */
  readonly tools?: ToolExecutor;
  /**
   * Optional trust-fast-path observer. When set, L2/L3 validators call this
   * instead of silently returning `trustedApproval` — the recorder can then
   * emit a `VizTrustEvent` so the UI lane still shows the decision.
   */
  readonly recordTrust?: (info: TrustFastPathInfo) => void;
  /**
   * Optional skill-pipeline observer. When set, L2 surfaces match /
   * inject / learn / update / success / failure events here so the viz
   * recorder can render a Skills lane next to the LLM/tool/registry
   * lanes. Same pattern as `recordTrust` — observer only, no effect on
   * runtime behaviour when undefined.
   */
  readonly recordSkill?: (info: SkillEventInfo) => void;
  /**
   * Optional prefilter-cache observer — see `CacheHitInfo`. Same
   * observer-only contract as `recordTrust` / `recordSkill`: absent, the
   * cache still serves, it just leaves no trace.
   */
  readonly recordCacheHit?: (info: CacheHitInfo) => void;
  /**
   * Fan-out lane identifier (uuid) of the subtask currently executing.
   * Set by L2/L3 when they dispatch `Promise.all` over subtasks — each
   * parallel branch gets its own shallow-cloned ctx with a unique id, so
   * every event recorded downstream (LLM call, tool invocation, trust
   * fast-path) carries that id. The viz uses it to group events into
   * per-subtask lanes rather than collapsing parallel chains into one
   * confused timeline. Absent (undefined) at the trunk level.
   */
  readonly currentBranchId?: string;
}
