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
import { resolveLatestOpus, FALLBACK_OPUS } from '../core/models.js';
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

export class L3Atom extends Atom implements Supervisor<L2Atom> {
  readonly tier: Tier = 3;
  readonly model: string;

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
  }) {
    super({
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model;
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
    const userContent = [
      `You are atom "${this.name}" (tier 3 / cell).`,
      `Decide how to handle this task. Options:`,
      `  - "reuse": pick an existing L2 molecule from the catalog that fits`,
      `  - "create": design a new L2 molecule and register it (provide a seed)`,
      ``,
      `L2 catalog (molecules):`,
      catalog.length === 0
        ? '  (empty — you must create)'
        : catalog.map((t) => `  - ${t.name}: ${t.description}`).join('\n'),
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ``,
      `Respond with STRATEGY JSON then PLAN JSON as an array: [strategy, plan].`,
      `Strategy: {"strategy": "reuse"|"create", "target": "<name>"?, "seed"?: {...}, "reasoning": "..."}`,
      `Plan: {"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}`,
    ]
      .filter(Boolean)
      .join('\n');

    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      tools: this.tools,
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
      if (!strategy.seed) throw new Error('create requires seed');
      l2Type = this.registry.create(2, {
        description: strategy.seed.description,
        systemPrompt: strategy.seed.systemPrompt,
        tools: strategy.seed.tools as Tool[],
        params: strategy.seed.params as GenerationParams,
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
    const userContent = [
      `You are "${this.name}" (tier 3) executing the approved plan yourself.`,
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

  // Supervisor<L2Atom>
  async validatePlan(child: L2Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    return llmVerdict({
      ctx,
      model: this.model,
      supervisorName: this.name,
      supervisorTier: 3,
      systemPrompt: this.effectiveSystemPrompt(),
      params: this.params,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
    });
  }

  async validateResult(child: L2Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
    return llmVerdict({
      ctx,
      model: this.model,
      supervisorName: this.name,
      supervisorTier: 3,
      systemPrompt: this.effectiveSystemPrompt(),
      params: this.params,
      subject: 'RESULT',
      child,
      task,
      payload: { output: result.output, summary: result.summary },
    });
  }
}

function parseTwoJson(text: string): [unknown, unknown] {
  const trimmed = text.trim();
  try {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr) && arr.length >= 2) return [arr[0], arr[1]];
  } catch {
    /* continue */
  }
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  if (fences.length >= 2) {
    return [JSON.parse(fences[0]![1]!), JSON.parse(fences[1]![1]!)];
  }
  const start1 = trimmed.indexOf('{');
  if (start1 === -1) throw new Error('no JSON object');
  let depth = 0;
  let end1 = -1;
  for (let i = start1; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end1 = i + 1;
        break;
      }
    }
  }
  if (end1 === -1) throw new Error('unterminated first JSON');
  const first = JSON.parse(trimmed.slice(start1, end1));
  const rest = trimmed.slice(end1);
  const start2 = rest.indexOf('{');
  if (start2 === -1) throw new Error('missing second JSON');
  depth = 0;
  let end2 = -1;
  for (let i = start2; i < rest.length; i++) {
    const c = rest[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end2 = i + 1;
        break;
      }
    }
  }
  if (end2 === -1) throw new Error('unterminated second JSON');
  return [first, JSON.parse(rest.slice(start2, end2))];
}
