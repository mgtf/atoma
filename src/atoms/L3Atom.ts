import Anthropic from '@anthropic-ai/sdk';
import { Atom, type Supervisor } from '../core/atom.js';
import type {
  GenerationParams,
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Tool,
  Verdict,
} from '../core/types.js';
import {
  stripBranchProvenance,
  type AtomRegistry,
  type AtomType,
} from '../registry/atomRegistry.js';
import { PIN_HAIKU, resolveLatestOpus, FALLBACK_OPUS } from '../core/models.js';
import { L2Atom } from './L2Atom.js';
import { buildTargetContext, llmVerdict } from './L2Atom.js';
import {
  l3StrategySchema,
  parsePayloadTolerant,
  parsePlanWithFallback,
  parseTwoJson,
  planSchema,
  type L3Strategy,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { forkBranch } from '../core/branchCtx.js';
import { randomUUID } from 'node:crypto';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';
import {
  prefilterStrategy,
  shouldTrustType,
  trustedApproval,
  STRATEGY_MAX_TOKENS,
  TaskChildrenMemo,
} from './cost.js';

/**
 * Fresh narrow-domain system prompt for an L2 branched after escalation.
 * Same purpose as `buildNarrowL1Prompt`: start the branch clean instead
 * of inheriting the failed parent's prompt. The branched atom's
 * rebrandPersona pass at `registry.branch` time will swap in the branch's
 * actual taxonomy name on the "You are {Name}" line.
 */
export function buildNarrowL2Prompt(subtaskDescription: string): string {
  return [
    `You are an L2 molecule that decomposes a single-purpose task into`,
    `orthogonal L1 leaf subtasks and supervises their parallel execution.`,
    ``,
    `Your current subtask: ${subtaskDescription}`,
    ``,
    `Do NOT import assumptions from other domains — the parent type you`,
    `were branched from may have been narrowly specialised for a`,
    `different problem. IGNORE its domain and focus SOLELY on this`,
    `subtask as stated.`,
    ``,
    `You NEVER execute tools yourself. Your job:`,
    `  1. Decompose the subtask into 1+ orthogonal L1 subtasks`,
    `  2. Choose an L1 for each (reuse a catalog match or create a narrow new one)`,
    `  3. Pick an aggregation mode (concat or llm-synthesize) matching the artefact`,
    `  4. Return the strategy+plan JSON pair`,
  ].join('\n');
}

export class L3Atom extends Atom implements Supervisor<L2Atom> {
  readonly tier: Tier = 3;
  readonly model: string;
  readonly validationModel: string;

  private registry: AtomRegistry;
  private pendingStrategy: L3Strategy | null = null;
  private l2Peers: L2Atom[] = [];
  private triedChildren = new TaskChildrenMemo();

  private constructor(args: {
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly Tool[];
    params: GenerationParams;
    registry: AtomRegistry;
    model: string;
    validationModel?: string;
  }) {
    super({
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model;
    this.validationModel = args.validationModel ?? PIN_HAIKU;
    this.registry = args.registry;
  }

  static async fromType(
    type: AtomType,
    registry: AtomRegistry,
    client?: Anthropic
  ): Promise<L3Atom> {
    if (type.tier !== 3) throw new Error(`L3Atom.fromType requires tier=3`);
    const model = client ? await resolveLatestOpus(client) : FALLBACK_OPUS;
    return new L3Atom({
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      model,
    });
  }

  /** Test/manual constructor bypassing model discovery. */
  static buildWithModel(
    type: AtomType,
    registry: AtomRegistry,
    model: string = FALLBACK_OPUS
  ): L3Atom {
    if (type.tier !== 3) throw new Error(`L3Atom.buildWithModel requires tier=3`);
    return new L3Atom({
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      model,
    });
  }

  /** Public entry: run the full supervised flow. */
  async handle(task: Task, ctx: RunContext): Promise<Result> {
    const plan = await this.plan(task, ctx);
    return this.execute(task, plan, ctx);
  }

  async plan(task: Task, ctx: RunContext): Promise<Plan> {
    if (this.isFallbackMode()) return this.selfPlan(task, ctx);

    this.triedChildren.beginTask(task.description);
    const catalog = this.registry.listByTier(2);

    if (catalog.length > 0) {
      const prefilter = await prefilterStrategy({
        ctx,
        task,
        // See L2 prefilter call site for rationale: strip the
        // "(branched from X)" tail so Haiku sees the real description.
        catalog: catalog.map((t) => ({
          name: t.name,
          description: stripBranchProvenance(t.description),
        })),
        exclude: this.triedChildren.excluded(),
      });
      if (prefilter && prefilter.kind === 'reuse') {
        this.pendingStrategy = {
          strategy: 'reuse',
          target: prefilter.target,
          reasoning: `prefilter: ${prefilter.reasoning}`,
        };
        this.triedChildren.mark(prefilter.target);
        ctx.logger.debug(
          `[${this.name}] prefilter picked L2 ${prefilter.target}`,
          { reasoning: prefilter.reasoning }
        );
        // Prefilter degenerate case: one subtask, one preferred child.
        return {
          reasoning: `prefilter selected ${prefilter.target}`,
          proposedAction: `delegate task to L2 "${prefilter.target}"`,
          subtasks: [
            {
              description: task.description,
              preferredChild: prefilter.target,
              ...(task.inputs ? { inputs: task.inputs } : {}),
            },
          ],
          aggregation: { mode: 'concat' as const },
          expectedOutput: task.description,
        };
      }
    }
    const toolCatalog =
      this.tools.length === 0
        ? '(no tools — children will work with prompts only)'
        : this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');
    const userContent = [
      `You are atom "${this.name}" (tier 3 / cell).`,
      ``,
      `HARD RULE: You NEVER execute tools yourself. You do NOT write files, run`,
      `shells, start servers, or validate anything. Your ONLY job is strategic:`,
      `DECOMPOSE the task into orthogonal subtasks and route each to an L2`,
      `molecule. The L2s will in turn decompose their own work into L1 leaf`,
      `tasks — L1 is the only tier allowed to call tools. Keep your reasoning`,
      `short and your plan high-level.`,
      ``,
      `== DECOMPOSITION DISCIPLINE ==`,
      `Break the task into a LIST of subtasks. Each subtask:`,
      `  - targets one coherent aspect of the overall work`,
      `  - is ORTHOGONAL to the others (no cross-dependencies — they run`,
      `    in PARALLEL)`,
      `  - carries a "preferredChild" naming the L2 molecule that should`,
      `    handle it (required for N>1 plans)`,
      `For genuinely atomic tasks, emit a single-subtask list. Do NOT force`,
      `decomposition when one L2 can clearly handle the whole thing.`,
      ``,
      `== AGGREGATION ==`,
      `Pick how the sub-results combine:`,
      `  - "concat": mechanical array join (no extra LLM call)`,
      `  - "llm-synthesize": you run one more call to merge sub-results into a`,
      `    unified deliverable (provide an "instruction" string)`,
      ``,
      `== STRATEGY OPTIONS (baseline when a subtask lacks preferredChild) ==`,
      `  - "reuse": pick an existing L2 molecule from the catalog that fits`,
      `  - "create": design a new L2 molecule and register it (provide a seed)`,
      ``,
      `CRITICAL — domain-match rule:`,
      `  ONLY "reuse" an L2 whose description matches the task's domain. If the`,
      `  best candidate's description names a different domain than the task`,
      `  (even when the workflow looks similar), DO NOT reuse it — its prompt`,
      `  will bias downstream decisions and you'll escalate. Use "create" with a`,
      `  fresh narrow seed instead.`,
      ``,
      `CRITICAL — "preferredChild" naming rule:`,
      `  - If you set "preferredChild" on a subtask, it MUST be the EXACT name of`,
      `    an L2 already listed in the catalog below. Do NOT invent new names.`,
      `  - If none of the existing L2s fit a subtask, OMIT "preferredChild" and set`,
      `    strategy="create" so the supervisor auto-spawns a fresh L2.`,
      ``,
      `L2 catalog (molecules):`,
      catalog.length === 0
        ? '  (empty — you must create)'
        : catalog.map((t) => `  - ${t.name}: ${t.description}`).join('\n'),
      ``,
      `System tools the L1 workers will have access to downstream (for context only;`,
      `do NOT call them yourself):`,
      toolCatalog,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ``,
      `CRITICAL OUTPUT FORMAT: your entire response MUST be exactly one JSON array`,
      `of TWO objects, with no prose before or after, no markdown fences, no tool calls.`,
      `Shape:`,
      `[`,
      `  {"strategy": "reuse"|"create", "target": "<name>"?, "seed"?: {"description": "...", "systemPrompt": "...", "tools": [], "params": {}}, "reasoning": "..."},`,
      `  {"reasoning": "...", "subtasks": [{"description": "...", "preferredChild": "<L2-name>"?, "inputs": {}?}, ...], "aggregation": {"mode": "concat"|"llm-synthesize", "instruction": "..."?}, "expectedOutput": "..."}`,
      `]`,
      `The first character of your response MUST be "[". Do NOT call any tools.`,
    ]
      .filter(Boolean)
      .join('\n');

    // L3 is a pure reasoning / routing tier: no executor and no tool declarations
    // are passed to the LLM. Only L1 may actually execute tools. Cap output at
    // STRATEGY_MAX_TOKENS — the response is routing JSON, not content.
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: { ...this.params, maxTokens: STRATEGY_MAX_TOKENS },
      signal: ctx.signal,
    });

    const pair = parseTwoJson(resp.text);
    this.pendingStrategy = l3StrategySchema.parse(pair[0]);
    return planSchema.parse(pair[1]);
  }

  async execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    if (this.isFallbackMode()) return this.selfExecute(task, plan, ctx);

    const strategy = this.pendingStrategy;
    this.pendingStrategy = null;
    if (!strategy) return this.selfExecute(task, plan, ctx);

    const subtasks = plan.subtasks;

    // Fan-out: one superviseLoop per subtask, all in parallel. Per-subtask
    // hooks close over the subtask description so `branchOnEscalation`
    // writes a FRESH L2 system prompt aligned with this subtask, not
    // inherited from the parent (same anti-Frankenstein pattern as L2).
    const subResults = await Promise.all(
      subtasks.map((subtask, idx) => {
        const hooks = this.makeL2Hooks(ctx, subtask.description);
        return this.runSubtask({ subtask, strategy, parentTask: task, idx, hooks, ctx });
      })
    );

    return this.aggregate(subResults, plan.aggregation, task, ctx);
  }

  private async runSubtask(args: {
    subtask: Plan['subtasks'][number];
    strategy: L3Strategy;
    parentTask: Task;
    idx: number;
    hooks: SupervisionHooks<L2Atom>;
    ctx: RunContext;
  }): Promise<Result> {
    const { subtask, strategy, parentTask, idx, hooks, ctx } = args;
    const l2Type = this.resolveL2ForSubtask(subtask, strategy, parentTask, idx, ctx);
    this.triedChildren.mark(l2Type.name);
    const l2 = L2Atom.fromType(l2Type, this.registry, this.l2Peers);
    for (const p of this.l2Peers) l2.addPeer(p);
    this.l2Peers.push(l2);
    const subTask: Task = subtask.inputs
      ? { description: subtask.description, inputs: subtask.inputs }
      : { description: subtask.description };
    // Fork a branch-scoped ctx so the viz can render each L2 subtask
    // (and its downstream L1 tree) as its own lane.
    const branchCtx = forkBranch(ctx, randomUUID());
    return superviseLoop<L2Atom>(this, l2, subTask, branchCtx, hooks);
  }

  private resolveL2ForSubtask(
    subtask: Plan['subtasks'][number],
    strategy: L3Strategy,
    parentTask: Task,
    idx: number,
    ctx: RunContext
  ): AtomType {
    if (subtask.preferredChild) {
      const found = this.registry.getByName(subtask.preferredChild);
      if (found) {
        if (found.tier !== 2) {
          throw new Error(
            `subtask preferredChild "${subtask.preferredChild}" is tier ${found.tier}, expected L2`
          );
        }
        return found;
      }
      // Planner hallucination (same failure mode as in L2.resolveL1ForSubtask):
      // fallback to auto-creation instead of crashing the whole fan-out.
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} preferredChild "${subtask.preferredChild}" not in registry — auto-creating a fresh L2`
      );
      return this.createSubtaskL2(subtask, strategy, parentTask);
    }
    if (idx > 0) {
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} has no preferredChild — auto-creating a fresh L2`
      );
      return this.createSubtaskL2(subtask, strategy, parentTask);
    }
    if (strategy.strategy === 'reuse') {
      if (!strategy.target) throw new Error('reuse requires target');
      const found = this.registry.getByName(strategy.target);
      if (!found) throw new RegistryNotFoundError(strategy.target);
      return found;
    }
    return this.createSubtaskL2(subtask, strategy, parentTask);
  }

  /**
   * Create a fresh L2 for a subtask that can't be routed to an existing
   * catalog entry. Mirrors L2Atom.createSubtaskL1 — description takes the
   * subtask's description so prefilter can route to it on future runs.
   */
  private createSubtaskL2(
    subtask: Plan['subtasks'][number],
    strategy: L3Strategy,
    parentTask: Task
  ): AtomType {
    const seed: NonNullable<typeof strategy.seed> =
      strategy.seed ?? ({ tools: [], params: {} } as NonNullable<typeof strategy.seed>);
    return this.registry.create(2, {
      description:
        seed.description ?? `L2 for subtask: ${subtask.description.slice(0, 120)}`,
      systemPrompt:
        seed.systemPrompt ??
        [
          `You are an L2 molecule created by ${this.name}.`,
          `Decompose sub-tasks into L1 elements and supervise them.`,
          `Subtask you were handed: ${subtask.description}`,
          `Parent task (for context only): ${parentTask.description}`,
        ].join('\n'),
      tools: mergeTools(this.tools, (seed.tools ?? []) as Tool[]),
      params: (seed.params ?? this.params) as GenerationParams,
      createdBy: this.name,
    });
  }

  private makeL2Hooks(ctx: RunContext, subtaskDescription: string): SupervisionHooks<L2Atom> {
    return {
      applyByScope: async (child, verdict) => {
        if (verdict.scope === 'ephemeral') {
          child.applyModifications(verdict.modifications);
          return child;
        }
        if (verdict.scope === 'patch') {
          const patched = this.registry.patch(
            child.name,
            verdict.modifications,
            this.name,
            verdict.reasoning
          );
          const fresh = L2Atom.fromType(patched, this.registry, this.l2Peers);
          return fresh;
        }
        const branched = this.registry.branch(
          child.name,
          verdict.modifications,
          this.name,
          verdict.branchName
        );
        ctx.logger.info(`[${this.name}] branched L2 ${child.name} → ${branched.name}`);
        const fresh = L2Atom.fromType(branched, this.registry, this.l2Peers);
        this.l2Peers.push(fresh);
        return fresh;
      },
      branchOnEscalation: async (child, _trace, reason) => {
        // Reset the L2's system prompt so it's aligned with THIS subtask's
        // domain rather than inherited from the parent that failed.
        const narrowPrompt = buildNarrowL2Prompt(subtaskDescription);
        const narrowDesc = `L2 narrow orchestrator for: ${subtaskDescription.slice(0, 120)}`;
        const branched = this.registry.branch(
          child.name,
          {
            systemPromptReplace: narrowPrompt,
            descriptionReplace: narrowDesc,
            additionalContext:
              `Branched after escalation. Prior L2 flow failed because the inherited prompt was` +
              ` misaligned with this subtask.`,
          },
          this.name,
          undefined
        );
        ctx.logger.warn(
          `[${this.name}] escalation — branched ${child.name} → ${branched.name} (${reason})`
        );
        // Hand the fresh L2 instance back so superviseLoop can give it one
        // attempt before falling back to this L3. Same rationale as at L2:
        // the narrow-template branch exists specifically to fix the failure
        // that just escalated — letting it try in-flight is strictly more
        // informative than recording it and never exercising it.
        return L2Atom.fromType(branched, this.registry);
      },
      onApproved: async (child, _result) => {
        this.registry.recordSuccess(child.name);
      },
      onFailed: async (child, _reason) => {
        this.registry.recordFailure(child.name);
      },
    };
  }

  /**
   * Combine N sub-results. See L2Atom.aggregate for the contract — the
   * L3 variant uses Opus for llm-synthesize (this.model) because the
   * synthesis step is closer to top-level planning than routine merge.
   */
  private async aggregate(
    subResults: Result[],
    aggregation: Plan['aggregation'],
    parentTask: Task,
    ctx: RunContext
  ): Promise<Result> {
    if (subResults.length === 1) {
      return subResults[0]!;
    }
    if (aggregation.mode === 'concat') {
      const outputs = subResults.map((r) => r.output);
      const summary = `${subResults.length} subtasks aggregated (concat): ${subResults
        .map((r, i) => `#${i + 1} ${r.summary}`)
        .join(' | ')}`;
      return {
        output: outputs,
        summary,
        trace: [],
        producedBy: { tier: 3, name: this.name, viaFallback: false },
      };
    }
    const userContent = [
      `You are "${this.name}" (tier 3). Synthesise a single result from ${subResults.length} sub-results.`,
      `Original task: ${parentTask.description}`,
      aggregation.instruction
        ? `Merge instruction: ${aggregation.instruction}`
        : 'Merge instruction: combine the sub-results into one coherent final deliverable.',
      ``,
      `Sub-results:`,
      ...subResults.map(
        (r, i) =>
          `--- #${i + 1} (by ${r.producedBy.name}) ---\nsummary: ${r.summary}\noutput: ${
            typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
          }`
      ),
      ``,
      `Return JSON: {"output": <any>, "summary": "<one sentence>"}`,
    ].join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
      signal: ctx.signal,
    });
    const { output, summary } = parsePayloadTolerant(resp.text);
    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 3, name: this.name, viaFallback: false },
    };
  }

  private async selfPlan(task: Task, ctx: RunContext): Promise<Plan> {
    // In fallback mode the L3 IS the executor (no L2 below, no L1 below). If
    // we hand it tool declarations at execute time, the plan must acknowledge
    // that — otherwise earlier runs produced plans that said "I'll write
    // index.html" but ran in a tools-less completion that could only emit
    // markdown, leaving no file on disk.
    const hasTools = this.tools.length > 0 && ctx.tools !== undefined;
    const toolCatalog = hasTools
      ? this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n')
      : '(no tools available — reasoning-only answer)';
    const userContent = [
      `You are "${this.name}" (tier 3) in FALLBACK: do the task yourself, no delegation.`,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      hasTools
        ? 'You HAVE tool access in this fallback turn (see Tools below). Plan concrete tool calls — do NOT describe work as prose when a tool can do it.'
        : 'You have NO tool access; produce a reasoning-only answer.',
      `Tools:`,
      toolCatalog,
      `IMPORTANT: emit ONE JSON object, NOT an array. Shape exactly:`,
      `{"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}`,
      `Your regular mode uses a [strategy, plan] array — that mode is OFF here.`,
      `The first character of your response MUST be "{".`,
    ]
      .filter(Boolean)
      .join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
      signal: ctx.signal,
    });
    // Tolerant parse WITH fallback: see L2Atom.selfPlan for rationale —
    // the routing-conditioned prompt sometimes produces responses that
    // don't include any plan-shaped fields. We synthesise a stub plan
    // from the task so selfExecute can still run with the tools.
    return parsePlanWithFallback(resp.text, {
      reasoning: `fallback: could not parse a plan from the LLM response; proceeding with direct execution of the task`,
      proposedAction: `execute the task directly using the available tools (${
        this.tools.map((t) => t.name).join(', ') || 'none'
      })`,
      expectedOutput: task.description,
    });
  }

  private async selfExecute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    // Fallback executor: the supervise loop already tried L2 → L1 and failed,
    // so L3 is the last line of defence. We break the "L3 never touches tools"
    // rule here intentionally — if we don't, side-effect tasks (write a file,
    // start a server) produce only prose and the user gets nothing on disk.
    // When `ctx.tools` isn't wired (research-brief-style runs), we fall back
    // to the old reasoning-only behaviour.
    const hasTools = this.tools.length > 0 && ctx.tools !== undefined;
    const hasValidator = hasTools && this.tools.some((t) => t.name === 'validate_html');
    const userContent = [
      `You are "${this.name}" (tier 3) in FALLBACK: L2/L1 supervision failed, you are now the executor.`,
      hasTools
        ? 'You HAVE tool access in this fallback turn. Use the tools to actually perform the work — do NOT just describe it. Relative paths for file tools ("index.html", not "/abs/index.html").'
        : 'You have NO tool access; produce a reasoning-only answer. Do not claim to have written files or started servers.',
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      `Plan: ${JSON.stringify(plan)}`,
      hasValidator
        ? 'If the task produces a web artefact, call validate_html on the returned URL after write_file + start_static_server, and iterate (read_file → fix → write_file → re-validate) until ok:true. Only then return success.'
        : '',
      `Return JSON: {"output", "summary"} once the work is done.`,
    ]
      .filter((l): l is string => typeof l === 'string' && l.length > 0)
      .join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      ...(hasTools ? { tools: [...this.tools], executor: ctx.tools } : {}),
      params: this.params,
      signal: ctx.signal,
      maxToolIterations: hasValidator ? 40 : undefined,
    });
    const { output, summary } = parsePayloadTolerant(resp.text);
    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 3, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }

  // Supervisor<L2Atom> — validations run on validationModel (Haiku by default).
  // Opus stays reserved for strategy/plan generation; yes/no verdicts are
  // delegated to the cheapest atom that can answer them.
  async validatePlan(child: L2Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) {
      const approval = trustedApproval(type);
      ctx.recordTrust?.({
        supervisorName: this.name,
        supervisorTier: 3,
        childName: child.name,
        childTier: child.tier,
        subject: 'PLAN',
        successes: type.successes,
        failures: type.failures,
        reasoning: approval.reasoning,
      });
      return approval;
    }
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 3,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
      // Inject the downstream-target description so Haiku can judge the
      // routing on facts, not on name-based guesses.
      targetContext: buildTargetContext(plan, this.registry),
    });
  }

  async validateResult(child: L2Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) {
      const approval = trustedApproval(type);
      ctx.recordTrust?.({
        supervisorName: this.name,
        supervisorTier: 3,
        childName: child.name,
        childTier: child.tier,
        subject: 'RESULT',
        successes: type.successes,
        failures: type.failures,
        reasoning: approval.reasoning,
      });
      return approval;
    }
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 3,
      subject: 'RESULT',
      child,
      task,
      payload: { output: result.output, summary: result.summary },
    });
  }
}
