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
  parsePlanTolerant,
  parseTwoJson,
  planSchema,
  type L3Strategy,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';
import {
  prefilterStrategy,
  shouldTrustType,
  trustedApproval,
  STRATEGY_MAX_TOKENS,
  TaskChildrenMemo,
} from './cost.js';

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
        return {
          reasoning: `prefilter selected ${prefilter.target}`,
          proposedAction: `delegate task to L2 "${prefilter.target}"`,
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
      `choose an L2 molecule (reuse or create) and hand the work off. The L2 will`,
      `in turn delegate each concrete leaf step to an L1 element — L1 is the only`,
      `tier allowed to call tools. This hierarchy exists to minimise LLM cost, so`,
      `keep your reasoning short and your plan high-level.`,
      ``,
      `Options:`,
      `  - "reuse": pick an existing L2 molecule from the catalog that fits`,
      `  - "create": design a new L2 molecule and register it (provide a seed)`,
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
      `  {"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}`,
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

    let l2Type: AtomType;
    if (strategy.strategy === 'reuse') {
      if (!strategy.target) throw new Error('reuse requires target');
      const found = this.registry.getByName(strategy.target);
      if (!found) throw new RegistryNotFoundError(strategy.target);
      l2Type = found;
    } else {
      const seed: NonNullable<typeof strategy.seed> =
        strategy.seed ?? ({ tools: [], params: {} } as NonNullable<typeof strategy.seed>);
      l2Type = this.registry.create(2, {
        description:
          seed.description ?? `L2 molecule created by ${this.name} for: ${task.description}`,
        systemPrompt:
          seed.systemPrompt ??
          [
            `You are an L2 molecule created by ${this.name}.`,
            `Decompose sub-tasks into L1 elements and supervise them.`,
            `Original task: ${task.description}`,
          ].join('\n'),
        tools: mergeTools(this.tools, (seed.tools ?? []) as Tool[]),
        params: (seed.params ?? this.params) as GenerationParams,
        createdBy: this.name,
      });
      ctx.logger.info(`[${this.name}] created L2 ${l2Type.name}`, { ordinal: l2Type.ordinal });
    }
    this.triedChildren.mark(l2Type.name);

    const l2 = L2Atom.fromType(l2Type, this.registry, this.l2Peers);
    // thread existing peers so the new instance can mutualize
    for (const p of this.l2Peers) l2.addPeer(p);
    this.l2Peers.push(l2);

    const hooks: SupervisionHooks<L2Atom> = {
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
        const branched = this.registry.branch(
          child.name,
          { additionalContext: 'Branched after escalation. Prior L2 flow failed.' },
          this.name,
          undefined
        );
        ctx.logger.warn(
          `[${this.name}] escalation — branched ${child.name} → ${branched.name} (${reason})`
        );
      },
      onApproved: async (child, _result) => {
        this.registry.recordSuccess(child.name);
      },
      onFailed: async (child, _reason) => {
        this.registry.recordFailure(child.name);
      },
    };

    return superviseLoop<L2Atom>(this, l2, task, ctx, hooks);
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
    // Tolerant parse: see L2Atom.selfPlan for rationale — the non-fallback
    // strategy-array conditioning leaks through even in fallback mode.
    return parsePlanTolerant(resp.text);
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
