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
import type { AtomRegistry, AtomType } from '../registry/atomRegistry.js';
import { PIN_HAIKU, resolveLatestOpus, FALLBACK_OPUS } from '../core/models.js';
import { L2Atom } from './L2Atom.js';
import { llmVerdict } from './L2Atom.js';
import {
  l3StrategySchema,
  parseWith,
  planSchema,
  resultPayloadSchema,
  type L3Strategy,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';

export class L3Atom extends Atom implements Supervisor<L2Atom> {
  readonly tier: Tier = 3;
  readonly model: string;
  readonly validationModel: string;

  private registry: AtomRegistry;
  private pendingStrategy: L3Strategy | null = null;
  private l2Peers: L2Atom[] = [];

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

    const catalog = this.registry.listByTier(2);
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
    // are passed to the LLM. Only L1 may actually execute tools.
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
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
    };

    return superviseLoop<L2Atom>(this, l2, task, ctx, hooks);
  }

  private async selfPlan(task: Task, ctx: RunContext): Promise<Plan> {
    const userContent = [
      `You are "${this.name}" (tier 3) in FALLBACK: do the task yourself, no delegation.`,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      `Return plan JSON: {"reasoning", "proposedAction", "expectedOutput"}`,
    ]
      .filter(Boolean)
      .join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
    });
    return parseWith(planSchema, resp.text);
  }

  private async selfExecute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    // Fallback: even here L3 does NOT touch tools. It summarises / reasons only.
    // If the task truly requires side effects, the supervise loop should retry
    // through an L2 → L1 path before reaching this branch.
    const userContent = [
      `You are "${this.name}" (tier 3) in FALLBACK: produce a reasoning-only answer.`,
      `You have NO tools. Do not claim to have written files or started servers.`,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      `Plan: ${JSON.stringify(plan)}`,
      `Return JSON: {"output", "summary"}`,
    ]
      .filter(Boolean)
      .join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
    });
    const p = parseWith(resultPayloadSchema, resp.text);
    return {
      output: p.output,
      summary: p.summary,
      trace: [],
      producedBy: { tier: 3, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }

  // Supervisor<L2Atom> — validations run on validationModel (Haiku by default).
  // Opus stays reserved for strategy/plan generation; yes/no verdicts are
  // delegated to the cheapest atom that can answer them.
  async validatePlan(child: L2Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 3,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
    });
  }

  async validateResult(child: L2Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
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

function parseTwoJson(text: string): [unknown, unknown] {
  const trimmed = text.trim();

  // Fast path: the model returned a pure JSON array [strategy, plan].
  const firstBracket = trimmed.indexOf('[');
  if (firstBracket !== -1) {
    const firstBrace = trimmed.indexOf('{');
    if (firstBracket < firstBrace || firstBrace === -1) {
      const arrEnd = findBalancedEnd(trimmed, firstBracket);
      if (arrEnd !== -1) {
        try {
          const arr = JSON.parse(trimmed.slice(firstBracket, arrEnd + 1));
          if (Array.isArray(arr) && arr.length >= 2) return [arr[0], arr[1]];
        } catch {
          /* fall through */
        }
      }
    }
  }

  // Two fenced code blocks.
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  if (fences.length >= 2) {
    return [JSON.parse(fences[0]![1]!), JSON.parse(fences[1]![1]!)];
  }

  // Fallback: extract two successive top-level JSON objects anywhere in the text.
  const start1 = trimmed.indexOf('{');
  if (start1 === -1) {
    throw new Error(
      `parseTwoJson: no JSON object found (head: ${trimmed.slice(0, 200)})`
    );
  }
  const end1 = findBalancedEnd(trimmed, start1);
  if (end1 === -1) {
    throw new Error(
      `parseTwoJson: unterminated first JSON (head: ${trimmed.slice(0, 200)})`
    );
  }
  const first = JSON.parse(trimmed.slice(start1, end1 + 1));
  const rest = trimmed.slice(end1 + 1);
  const start2 = rest.indexOf('{');
  if (start2 === -1) {
    throw new Error(
      `parseTwoJson: missing second JSON (head: ${trimmed.slice(0, 200)})`
    );
  }
  const end2 = findBalancedEnd(rest, start2);
  if (end2 === -1) {
    throw new Error(
      `parseTwoJson: unterminated second JSON (head: ${trimmed.slice(0, 200)})`
    );
  }
  return [first, JSON.parse(rest.slice(start2, end2 + 1))];
}

/**
 * Scan forward from `start` (which must point at `{` or `[`) and return the
 * index of its matching close bracket, honouring string literals (including
 * escape sequences). Returns -1 if unterminated.
 */
function findBalancedEnd(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (inString) {
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
