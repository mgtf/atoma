import { Atom, type Peerable, type Supervisor } from '../core/atom.js';
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
import { PIN_SONNET } from '../core/models.js';
import { L1Atom } from './L1Atom.js';
import {
  type L2Strategy,
  l2StrategySchema,
  parseWith,
  planSchema,
  resultPayloadSchema,
  verdictSchema,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';

export class L2Atom extends Atom implements Supervisor<L1Atom>, Peerable<L2Atom> {
  readonly tier: Tier = 2;
  readonly model: string;
  readonly peers: L2Atom[] = [];

  private registry: AtomRegistry;
  private pendingStrategy: L2Strategy | null = null;

  constructor(args: {
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly Tool[];
    params: GenerationParams;
    registry: AtomRegistry;
    peers?: L2Atom[];
    model?: string;
  }) {
    super({
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model ?? PIN_SONNET;
    this.registry = args.registry;
    if (args.peers) this.peers.push(...args.peers);
  }

  static fromType(type: AtomType, registry: AtomRegistry, peers: L2Atom[] = []): L2Atom {
    if (type.tier !== 2) throw new Error(`L2Atom.fromType requires tier=2`);
    return new L2Atom({
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      peers,
    });
  }

  addPeer(p: L2Atom): void {
    if (p === this) return;
    if (!this.peers.includes(p)) this.peers.push(p);
  }

  async plan(task: Task, ctx: RunContext): Promise<Plan> {
    if (this.isFallbackMode()) {
      return this.selfPlan(task, ctx);
    }

    const catalog = this.registry.listByTier(1);
    const peerCatalog = this.peers.map((p) => ({ name: p.name, ordinal: p.ordinal }));

    const userContent = [
      `You are atom "${this.name}" (tier 2 / molecule).`,
      ``,
      `HARD RULE: You NEVER execute tools yourself. You do NOT write files, run`,
      `shells, start servers, or validate anything. Your role is coordination:`,
      `break the task into a focused leaf sub-task and route it to an L1 element`,
      `(the only tier that can call tools). If the work needs several leaf steps,`,
      `give the L1 a single composite leaf with clear instructions — the L1's own`,
      `LLM loop will call the tools sequentially. Minimise LLM spend: prefer`,
      `"reuse" or "mutualize" over "create" whenever possible, keep prompts short.`,
      ``,
      `Options:`,
      `  - "reuse": pick an existing L1 element from the catalog that fits`,
      `  - "create": design a new L1 element and register it (provide a seed)`,
      `  - "mutualize": delegate to a peer L2 molecule when their specialty fits better`,
      ``,
      `L1 catalog (elements):`,
      catalog.length === 0
        ? '  (empty — no elements exist yet; "reuse" is not possible)'
        : catalog.map((t) => `  - ${t.name}: ${t.description}`).join('\n'),
      ``,
      `Peer L2 catalog (molecules you can mutualize with):`,
      peerCatalog.length === 0
        ? '  (no peers available)'
        : peerCatalog.map((p) => `  - ${p.name}`).join('\n'),
      ``,
      `Tools the L1 you spawn will inherit automatically (for context only — do`,
      `NOT call them yourself):`,
      this.tools.length === 0
        ? '  (none)'
        : this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n'),
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ``,
      `CRITICAL OUTPUT FORMAT: your entire response MUST be exactly one JSON array`,
      `of TWO objects, with no prose before or after, no markdown fences, no tool calls.`,
      `Shape:`,
      `[`,
      `  {"strategy": "reuse"|"create"|"mutualize", "target": "<name>"?, "seed"?: {"description": "...", "systemPrompt": "...", "tools": [], "params": {}}, "reasoning": "..."},`,
      `  {"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}`,
      `]`,
      `The first character of your response MUST be "[". Do NOT call any tools.`,
    ]
      .filter(Boolean)
      .join('\n');

    // L2 is a pure reasoning / routing tier: no executor, no tool declarations.
    // Only L1 may actually execute tools.
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
    });

    const pair = parseTwoJson(resp.text);
    this.pendingStrategy = l2StrategySchema.parse(pair[0]);
    const plan = planSchema.parse(pair[1]);
    return plan;
  }

  async execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    if (this.isFallbackMode()) {
      return this.selfExecute(task, plan, ctx);
    }

    const strategy = this.pendingStrategy;
    this.pendingStrategy = null;
    if (!strategy) {
      return this.selfExecute(task, plan, ctx);
    }

    if (strategy.strategy === 'mutualize') {
      const peer = this.peers.find((p) => p.name === strategy.target);
      if (!peer) throw new RegistryNotFoundError(strategy.target ?? 'unknown peer');
      return peer.handleDirect(task, ctx);
    }

    let l1Type: AtomType;
    if (strategy.strategy === 'reuse') {
      if (!strategy.target) throw new Error('reuse requires target');
      const found = this.registry.getByName(strategy.target);
      if (!found) throw new RegistryNotFoundError(strategy.target);
      l1Type = found;
    } else {
      const seed: NonNullable<typeof strategy.seed> =
        strategy.seed ?? ({ tools: [], params: {} } as NonNullable<typeof strategy.seed>);
      l1Type = this.registry.create(1, {
        description:
          seed.description ?? `L1 element created by ${this.name} for: ${task.description}`,
        systemPrompt:
          seed.systemPrompt ??
          [
            `You are an L1 element created by ${this.name}.`,
            `Execute a focused leaf task and return a clean, structured result.`,
            `Original task: ${task.description}`,
          ].join('\n'),
        tools: mergeTools(this.tools, (seed.tools ?? []) as Tool[]),
        params: (seed.params ?? this.params) as GenerationParams,
        createdBy: this.name,
      });
      ctx.logger.info(`[${this.name}] created L1 ${l1Type.name}`, { ordinal: l1Type.ordinal });
    }

    const l1 = L1Atom.fromType(l1Type);
    const hooks: SupervisionHooks<L1Atom> = {
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
          return L1Atom.fromType(patched);
        }
        const branched = this.registry.branch(
          child.name,
          verdict.modifications,
          this.name,
          verdict.branchName
        );
        ctx.logger.info(`[${this.name}] branched L1 ${child.name} → ${branched.name}`);
        return L1Atom.fromType(branched);
      },
      branchOnEscalation: async (child, _trace, reason) => {
        const branched = this.registry.branch(
          child.name,
          { additionalContext: 'Branched after escalation. Previous attempts failed.' },
          this.name,
          undefined
        );
        ctx.logger.warn(
          `[${this.name}] escalation — branched ${child.name} → ${branched.name} (${reason})`
        );
      },
    };

    return superviseLoop<L1Atom>(this, l1, task, ctx, hooks);
  }

  /** Mutualization target: peer runs the task end-to-end without further supervision. */
  async handleDirect(task: Task, ctx: RunContext): Promise<Result> {
    const plan = await this.plan(task, ctx);
    return this.execute(task, plan, ctx);
  }

  async mutualize(task: Task, ctx: RunContext): Promise<Result> {
    if (this.peers.length === 0) throw new Error('no peers to mutualize with');
    const peer = this.peers[0]!;
    return peer.handleDirect(task, ctx);
  }

  /** L2 self-exec fallback (used when L3 escalates OR when L1 supervision bails). */
  private async selfPlan(task: Task, ctx: RunContext): Promise<Plan> {
    const userContent = [
      `You are atom "${this.name}" (tier 2) in FALLBACK mode: do the task yourself, no delegation.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      ``,
      `Produce plan JSON: {"reasoning", "proposedAction", "expectedOutput"}.`,
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
    // L2 fallback: reasoning-only. L2 is not allowed to touch tools. If the
    // task truly needs side effects, the supervise loop should have spawned an
    // L1 instead of falling back here.
    const userContent = [
      `You are "${this.name}" (tier 2) in FALLBACK: reasoning-only answer.`,
      `You have NO tools. Do not claim to have written files or run commands.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      ``,
      `Plan: ${JSON.stringify(plan)}`,
      ``,
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
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }

  // Supervisor<L1Atom> contract
  async validatePlan(child: L1Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    return llmVerdict({
      ctx,
      model: this.model,
      supervisorName: this.name,
      supervisorTier: 2,
      systemPrompt: this.effectiveSystemPrompt(),
      params: this.params,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
    });
  }

  async validateResult(child: L1Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
    return llmVerdict({
      ctx,
      model: this.model,
      supervisorName: this.name,
      supervisorTier: 2,
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
  const asArray = safeParse(trimmed);
  if (Array.isArray(asArray) && asArray.length >= 2) {
    return [asArray[0], asArray[1]];
  }
  // fallback: look for two JSON blocks back-to-back
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  if (fences.length >= 2) {
    return [JSON.parse(fences[0]![1]!), JSON.parse(fences[1]![1]!)];
  }
  const first = extractFirstJsonObject(trimmed);
  const rest = trimmed.slice(first.end);
  const second = extractFirstJsonObject(rest);
  return [first.value, second.value];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(s: string): { value: unknown; end: number } {
  const start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON object');
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = s.slice(start, i + 1);
        return { value: JSON.parse(raw), end: i + 1 };
      }
    }
  }
  throw new Error('unterminated JSON object');
}

export async function llmVerdict(args: {
  ctx: RunContext;
  model: string;
  supervisorName: string;
  supervisorTier: Tier;
  systemPrompt: string;
  params: GenerationParams;
  subject: 'PLAN' | 'RESULT';
  child: Atom;
  task: Task;
  payload: unknown;
}): Promise<Verdict> {
  const userContent = [
    `You are "${args.supervisorName}" (tier ${args.supervisorTier}) supervising "${args.child.name}" (tier ${args.child.tier}).`,
    `Evaluate the ${args.subject} below. Respond with a JSON verdict.`,
    ``,
    `Task: ${args.task.description}`,
    `${args.subject}: ${JSON.stringify(args.payload, null, 2)}`,
    ``,
    `Approve only if the ${args.subject.toLowerCase()} is clearly acceptable.`,
    `If you reject, provide actionable "modifications" and a "scope":`,
    `  - "ephemeral": change applies only to this instance for this task`,
    `  - "patch": update the canonical child type (future reuses see the change)`,
    `  - "branch": create a new child type with these modifications applied`,
    ``,
    `Verdict JSON shapes:`,
    `  {"approved": true, "reasoning": "..."}`,
    `  {"approved": false, "reasoning": "...", "modifications": {...}, "scope": "ephemeral"|"patch"|"branch", "branchName"?: "..."}`,
  ].join('\n');

  // Supervision verdicts are pure reasoning: no tool access needed or allowed.
  const resp = await args.ctx.llm.complete({
    model: args.model,
    systemPrompt: args.systemPrompt,
    userContent,
    params: args.params,
  });

  return parseWith(verdictSchema, resp.text);
}
