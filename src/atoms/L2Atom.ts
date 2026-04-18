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
import { PIN_HAIKU, PIN_SONNET } from '../core/models.js';
import { L1Atom } from './L1Atom.js';
import {
  type L2Strategy,
  l2StrategySchema,
  parseWith,
  planSchema,
  repairTruncatedJson,
  resultPayloadSchema,
  verdictSchema,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';
import {
  prefilterStrategy,
  shouldTrustType,
  trustedApproval,
  STRATEGY_MAX_TOKENS,
} from './cost.js';

export class L2Atom extends Atom implements Supervisor<L1Atom>, Peerable<L2Atom> {
  readonly tier: Tier = 2;
  readonly model: string;
  readonly validationModel: string;
  readonly peers: L2Atom[] = [];

  private registry: AtomRegistry;
  private pendingStrategy: L2Strategy | null = null;
  /**
   * Names of L1 children already delegated to and proven unable to satisfy
   * supervision during the CURRENT task. The prefilter is told to avoid them
   * so we don't loop on the same failing catalog match across plan
   * iterations. Reset via `resetTaskMemory()` when a new task comes in.
   */
  private triedChildren = new Set<string>();
  /** Task description seen on the previous plan() call, used to detect task boundaries. */
  private lastTaskDescription: string | null = null;

  constructor(args: {
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly Tool[];
    params: GenerationParams;
    registry: AtomRegistry;
    peers?: L2Atom[];
    model?: string;
    validationModel?: string;
  }) {
    super({
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model ?? PIN_SONNET;
    this.validationModel = args.validationModel ?? PIN_HAIKU;
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

    // Reset per-task memory when the supervisor moves to a new task.
    if (this.lastTaskDescription !== task.description) {
      this.triedChildren.clear();
      this.lastTaskDescription = task.description;
    }

    const catalog = this.registry.listByTier(1);

    // Cheap Haiku prefilter: if the catalog has an obvious match for this task,
    // route straight to it and skip the Sonnet strategy call entirely. On
    // "escalate" (or no catalog) we fall through to the full Sonnet plan.
    // `triedChildren` is threaded in so repeated failures don't get re-picked.
    if (catalog.length > 0) {
      const prefilter = await prefilterStrategy({
        ctx,
        task,
        catalog: catalog.map((t) => ({ name: t.name, description: t.description })),
        exclude: this.triedChildren,
      });
      if (prefilter && prefilter.kind === 'reuse') {
        this.pendingStrategy = {
          strategy: 'reuse',
          target: prefilter.target,
          reasoning: `prefilter: ${prefilter.reasoning}`,
        };
        // Record the pick so the next plan iteration (if the outer supervisor
        // rejects this attempt) won't loop on the same L1.
        this.triedChildren.add(prefilter.target);
        ctx.logger.debug(
          `[${this.name}] prefilter picked L1 ${prefilter.target}`,
          { reasoning: prefilter.reasoning }
        );
        return {
          reasoning: `prefilter selected ${prefilter.target}`,
          proposedAction: `delegate leaf task to L1 "${prefilter.target}"`,
          expectedOutput: task.description,
        };
      }
    }

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
    // Only L1 may actually execute tools. Cap output at STRATEGY_MAX_TOKENS —
    // the response is a routing JSON pair, not content.
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: { ...this.params, maxTokens: STRATEGY_MAX_TOKENS },
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
      this.triedChildren.add(l1Type.name);
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
      this.triedChildren.add(l1Type.name);
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
          verdict.branchName ?? undefined
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
      onApproved: async (child, _result) => {
        this.registry.recordSuccess(child.name);
      },
      onFailed: async (child, _reason) => {
        this.registry.recordFailure(child.name);
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
    // Tolerant parse: Sonnet occasionally ignores the JSON envelope in fallback
    // and dumps raw content. Accept that gracefully so the parent supervisor
    // still gets a Result and can decide what to do next.
    let output: unknown;
    let summary: string;
    try {
      const p = parseWith(resultPayloadSchema, resp.text);
      output = p.output;
      summary = p.summary;
    } catch {
      const trimmed = resp.text.trim();
      output = trimmed;
      summary = `fallback produced non-JSON output (${trimmed.length} chars)`;
    }
    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }

  // Supervisor<L1Atom> contract — validations always run on validationModel
  // (Haiku by default), not the supervisor's own model. The job here is a
  // terse yes/no on the child's plan/result; it does not need Sonnet to answer.
  async validatePlan(child: L1Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) return trustedApproval(type);
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 2,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
    });
  }

  async validateResult(child: L1Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) return trustedApproval(type);
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 2,
      subject: 'RESULT',
      child,
      task,
      payload: { output: result.output, summary: result.summary },
    });
  }
}

function parseTwoJson(text: string): [unknown, unknown] {
  const trimmed = text.trim();

  // Fast path: pure JSON array [strategy, plan].
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
      // Truncation path: the array was never closed. Try to repair it so we
      // at least recover the strategy (the plan can be approximate).
      const sliced = trimmed.slice(firstBracket);
      const repaired = repairTruncatedJson(sliced);
      if (repaired) {
        try {
          const arr = JSON.parse(repaired);
          if (Array.isArray(arr) && arr.length >= 2) return [arr[0], arr[1]];
          if (Array.isArray(arr) && arr.length === 1) {
            // Only the strategy came through — synthesise a minimal plan so
            // the supervise loop can still proceed.
            return [
              arr[0],
              {
                reasoning: 'plan section truncated; synthesised placeholder',
                proposedAction: 'delegate to child per strategy',
                expectedOutput: 'as described in task',
              },
            ];
          }
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

  // Two successive top-level JSON objects (string-aware).
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
 * index of its matching close bracket, honouring string literals and escapes.
 * Mirrors L3Atom.findBalancedEnd. See CLAUDE.md note: if a third tier appears,
 * consolidate this helper.
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

/**
 * Fixed system prompt used for EVERY validation call across all tiers. It is
 * identical call-to-call, which lets prompt caching short-circuit the input
 * bill on repeat verdicts — critical since validations dominate the loop.
 */
export const VALIDATION_SYSTEM_PROMPT = [
  'You validate agent outputs in a three-tier LLM orchestration system.',
  'Your ONLY job: emit a single Verdict JSON. No prose, no markdown, no tool calls.',
  'Approve when the subject clearly satisfies the stated task.',
  'Reject only when there is a concrete, fixable problem you can state in one sentence.',
  'When rejecting, provide actionable "modifications" and pick a "scope":',
  '  - "ephemeral": apply only to this instance for this task',
  '  - "patch":     update the canonical child type for future reuses',
  '  - "branch":    create a new child type with the modifications applied',
  'Verdict shapes:',
  '  {"approved": true, "reasoning": "..."}',
  '  {"approved": false, "reasoning": "...", "modifications": {...}, "scope": "ephemeral"|"patch"|"branch", "branchName"?: "..."}',
  'Your entire response MUST start with "{" and be ONLY the JSON object.',
].join('\n');

/** Compact params for validation: verdict JSON is short, be fast and deterministic. */
const VALIDATION_PARAMS: GenerationParams = { temperature: 0, maxTokens: 512 };

export async function llmVerdict(args: {
  ctx: RunContext;
  model: string;
  supervisorName: string;
  supervisorTier: Tier;
  subject: 'PLAN' | 'RESULT';
  child: Atom;
  task: Task;
  payload: unknown;
}): Promise<Verdict> {
  const userContent = [
    `Supervisor: "${args.supervisorName}" (tier ${args.supervisorTier})`,
    `Child: "${args.child.name}" (tier ${args.child.tier})`,
    `Task: ${args.task.description}`,
    `${args.subject}: ${JSON.stringify(args.payload)}`,
  ].join('\n');

  const resp = await args.ctx.llm.complete({
    model: args.model,
    systemPrompt: VALIDATION_SYSTEM_PROMPT,
    userContent,
    params: VALIDATION_PARAMS,
  });

  return parseWith(verdictSchema, resp.text);
}
