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
import {
  stripBranchProvenance,
  type AtomRegistry,
  type AtomType,
} from '../registry/atomRegistry.js';
import { PIN_HAIKU, PIN_SONNET } from '../core/models.js';
import { L1Atom } from './L1Atom.js';
import {
  type L2Strategy,
  l2StrategySchema,
  parsePayloadTolerant,
  parsePlanTolerant,
  parseTwoJson,
  parseVerdict,
  planSchema,
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

export class L2Atom extends Atom implements Supervisor<L1Atom>, Peerable<L2Atom> {
  readonly tier: Tier = 2;
  readonly model: string;
  readonly validationModel: string;
  readonly peers: L2Atom[] = [];

  private registry: AtomRegistry;
  private pendingStrategy: L2Strategy | null = null;
  private triedChildren = new TaskChildrenMemo();

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

    this.triedChildren.beginTask(task.description);
    const catalog = this.registry.listByTier(1);

    if (catalog.length > 0) {
      const prefilter = await prefilterStrategy({
        ctx,
        task,
        // Strip the "(branched from X)" provenance tail — it carries no
        // useful signal for routing (the catalog listing already implies
        // the tier) and just pads the prompt with repetitive noise.
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
      signal: ctx.signal,
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
    this.triedChildren.mark(l1Type.name);

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

  /**
   * L2 self-exec fallback (used when L3 escalates OR when L1 supervision bails).
   * Parallels the L3 fallback fix: if both `this.tools` and `ctx.tools` are
   * wired, the L2 IS the executor of last resort and must be allowed to call
   * tools directly. Without this, earlier runs produced a "FALLBACK_NO_TOOLS"
   * payload with just HTML source text and no file on disk — the L3 supervisor
   * rightly rejected that and the 10-minute deadline ran out.
   */
  private async selfPlan(task: Task, ctx: RunContext): Promise<Plan> {
    const hasTools = this.tools.length > 0 && ctx.tools !== undefined;
    const toolCatalog = hasTools
      ? this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n')
      : '(no tools available — reasoning-only answer)';
    const userContent = [
      `You are atom "${this.name}" (tier 2) in FALLBACK mode: do the task yourself, no delegation.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      hasTools
        ? 'You HAVE tool access in this fallback turn (see Tools below). Plan concrete tool calls — do NOT describe work as prose when a tool can do it.'
        : 'You have NO tool access; produce a reasoning-only answer.',
      `Tools:`,
      toolCatalog,
      ``,
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
    // Tolerant parse: even with the explicit "emit ONE object" hint above,
    // the LLM sometimes still wraps the plan in an array because its
    // non-fallback system prompt is heavily conditioned to the
    // [strategy, plan] shape. parsePlanTolerant unwraps those for us.
    return parsePlanTolerant(resp.text);
  }

  private async selfExecute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    const hasTools = this.tools.length > 0 && ctx.tools !== undefined;
    const hasValidator = hasTools && this.tools.some((t) => t.name === 'validate_html');
    const userContent = [
      `You are "${this.name}" (tier 2) in FALLBACK: L1 supervision failed, you are now the executor.`,
      hasTools
        ? 'You HAVE tool access in this fallback turn. Use the tools to actually perform the work — do NOT just describe it. Relative paths for file tools ("index.html", not "/abs/index.html").'
        : 'You have NO tool access; produce a reasoning-only answer. Do not claim to have written files or run commands.',
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      ``,
      `Plan: ${JSON.stringify(plan)}`,
      hasValidator
        ? 'If the task produces a web artefact, call validate_html on the returned URL after write_file + start_static_server, and iterate (read_file → fix → write_file → re-validate) until ok:true. Only then return success.'
        : '',
      ``,
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
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }

  // Supervisor<L1Atom> contract — validations always run on validationModel
  // (Haiku by default), not the supervisor's own model. The job here is a
  // terse yes/no on the child's plan/result; it does not need Sonnet to answer.
  async validatePlan(child: L1Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) {
      const approval = trustedApproval(type);
      ctx.recordTrust?.({
        supervisorName: this.name,
        supervisorTier: 2,
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
      supervisorTier: 2,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
      // Inject the description of anything the plan wants to delegate to,
      // so Haiku doesn't judge "delegate to L1 Fluorine" from the name
      // alone and hallucinate what Fluorine does.
      targetContext: buildTargetContext(plan, this.registry),
    });
  }

  async validateResult(child: L1Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) {
      const approval = trustedApproval(type);
      ctx.recordTrust?.({
        supervisorName: this.name,
        supervisorTier: 2,
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
      supervisorTier: 2,
      subject: 'RESULT',
      child,
      task,
      payload: { output: result.output, summary: result.summary },
    });
  }
}

/**
 * Fixed system prompt used for EVERY validation call across all tiers. It is
 * identical call-to-call, which lets prompt caching short-circuit the input
 * bill on repeat verdicts — critical since validations dominate the loop.
 */
export const VALIDATION_SYSTEM_PROMPT = [
  'You validate agent outputs in a three-tier LLM orchestration system.',
  'Your ONLY job: emit a single Verdict JSON. No prose, no markdown, no tool calls.',
  '',
  '== TIERING CONTRACT (do NOT second-guess it) ==',
  'L1 elements are the ONLY tier allowed to invoke tools (file I/O, shell, HTTP, validation).',
  'L2 molecules plan and delegate a focused leaf task to exactly ONE L1 element per step.',
  'L3 cells plan and delegate the task to exactly ONE L2 molecule per step.',
  'Delegation DOWN the tiers is the protocol, NOT a violation:',
  '  - An L3 plan whose proposedAction is "delegate to <L2-name>" is CORRECT.',
  '  - An L2 plan whose proposedAction is "delegate to <L1-name>" is CORRECT.',
  '  - A supervisor is NEVER required to execute its child\'s work itself.',
  '  - Never reject a plan for "delegating to a lower tier" or "not retaining orchestration".',
  'The concrete side-effects (file writes, server starts, HTML validation) happen ONLY at L1.',
  'If a supervisor at L2 or L3 proposes calling tools directly, THAT is the violation.',
  '',
  '== PLAN vs RESULT (they have different acceptance bars) ==',
  'The "Subject kind" field in the user message tells you which applies.',
  'The "Plan kind" field (DIRECT or DELEGATION) tells you how strict to be about',
  'visible-deliverable enumeration — see below.',
  'If Subject kind is PLAN:',
  '  The child is proposing WHAT IT INTENDS TO DO. You are NOT checking a completed',
  '  artefact yet. Approve when the plan is coherent, targets a reasonable child of',
  '  the appropriate lower tier (or describes an in-tier action when L1), and states',
  '  a verifiable expectedOutput. Reject only if the plan is structurally broken:',
  '  wrong tier target, missing a step the task explicitly demands, or contradicts',
  '  the task. Aspirational language ("will write...", "will validate...") is',
  '  EXPECTED at plan-time and is NEVER grounds for rejection — absence of executed',
  '  work is not a defect of a plan.',
  '  VISIBLE-DELIVERABLES RULE (tier-aware):',
  '    - If Plan kind is DIRECT (child tier 1, the executor, OR a supervisor acting',
  '      in fallback): for tasks that produce an interactive artefact (an app, a',
  '      game, a UI) the plan MUST enumerate the VISIBLE deliverables — not just',
  '      "render a grid" but every user-perceivable affordance the task implies:',
  '      numbers/text displayed, icons or glyphs for distinct states, feedback on',
  '      each interaction kind, end-state screens. A plan that only describes',
  '      colored shapes for a task that needs numbers and icons is structurally',
  '      broken and MUST be rejected with an additionalContext listing the',
  '      missing visible affordances.',
  '      Implicit gameplay requirements (e.g. Minesweeper must show mine counts',
  '      and flag icons) are NOT optional just because the task statement didn\'t',
  '      list them word-for-word.',
  '    - If Plan kind is DELEGATION (child tier 2 or 3, routing to a lower tier):',
  '      the plan is a ROUTING decision. The visible-deliverables checklist does',
  '      NOT apply here — enumerating per-affordance UX detail is the downstream',
  '      L1\'s responsibility, not the delegator\'s. APPROVE the plan when (a) the',
  '      proposedAction targets a sensible lower-tier name, AND (b) the',
  '      expectedOutput is present and preserves the task\'s intent. An',
  '      expectedOutput that restates the task verbatim is ACCEPTABLE — the task',
  '      itself already carries the implicit requirements that the downstream L1',
  '      will unpack. Reject ONLY if the delegation target is structurally wrong',
  '      OR the expectedOutput drops critical task constraints explicitly listed',
  '      in the task statement (e.g. task says "with a 10x10 grid" and',
  '      expectedOutput says "any grid").',
  '      Do NOT reject a DELEGATION plan for "missing VISIBLE deliverables" — that is the wrong tier to enforce it.',
  'If Subject kind is RESULT:',
  '  The child claims the work is DONE. Approve when the claimed output plausibly',
  '  satisfies the task\'s success criteria (e.g. a URL is present when the task',
  '  asked for one, a file path is reported, the deliverable exists). Reject if the',
  '  deliverable is obviously missing, unverifiable, or contradicts the task.',
  '  CRITICAL: do NOT accept the child\'s narration as proof of success.',
  '  Self-reported "smokeTests: all passed" or "validation successful" is NOT evidence.',
  '  If the user message contains a "GROUND-TRUTH EVIDENCE" block, that block is',
  '  the supervisor\'s OWN independent re-run of validate_html. Its console errors,',
  '  failed requests, and ok flag outrank anything the child claims. If',
  '  ground-truth shows errors or failures that contradict the child\'s summary,',
  '  reject with scope "ephemeral" and put the ground-truth errors in',
  '  modifications.additionalContext so the next attempt can fix them.',
  '  CRITICAL: absence of a GROUND-TRUTH EVIDENCE block is NOT itself grounds',
  '  for rejection. The block is a supervisor-side auto-probe; it only fires',
  '  when the RESULT contains an http(s) URL and a validate_html tool is wired',
  '  into the supervisor\'s context. When it is absent, evaluate the RESULT on',
  '  its own merits (URL present? file path reported? deliverable described?) —',
  '  do NOT demand the child produce a GROUND-TRUTH block themselves; they',
  '  cannot. Rejecting purely for "no ground-truth block provided" is a false',
  '  negative that has starved earlier runs of progress.',
  '  For interactive artefacts (apps, games, UIs), when Plan kind is DIRECT (child',
  '  tier 1 or a fallback supervisor) you must also check the RESULT against the',
  '  task\'s implicit VISIBLE deliverables: are all user-perceivable affordances —',
  '  numbers, icons, state feedback — actually documented in the RESULT output? A',
  '  result that only confirms colored shapes rendered for a task needing',
  '  numbers/icons must be REJECTED even if validate_html reported zero console',
  '  errors — a visually-incomplete artefact is a failed deliverable, not a',
  '  passing one. When Plan kind is DELEGATION, trust the downstream L1\'s RESULT',
  '  subject to the ground-truth evidence block (if present); the delegator is',
  '  not expected to re-enumerate the affordances itself.',
  '',
  '== REJECT SCOPES ==',
  'When rejecting, provide actionable "modifications" and pick a "scope":',
  '  - "ephemeral": apply only to this instance for this task (pure retry OK — empty modifications allowed)',
  '  - "patch":     update the canonical child type for future reuses',
  '  - "branch":    create a new child type with the modifications applied',
  'HARD RULE: scope "patch" and scope "branch" MUST carry at least one non-empty field in "modifications"',
  '  (systemPromptAppend, systemPromptReplace, descriptionReplace, additionalContext, addTools, removeTools, or params).',
  '  If you only have a diagnostic but no concrete prescription, use scope "ephemeral" and put your',
  '  diagnostic in modifications.additionalContext so the next attempt sees it — do NOT use patch/branch.',
  '',
  '== DESCRIPTION DRIFT ==',
  'The child type\'s "description" is what the prefilter sees when choosing catalog entries.',
  'If you notice the description no longer reflects the actual system prompt — e.g. the',
  'description still says "Mario-like platformer" but the system prompt has been retargeted',
  'to Minesweeper — issue a scope "patch" with modifications.descriptionReplace set to a',
  'fresh one-sentence description of what the type ACTUALLY does now. Accurate descriptions',
  'cut routing cost; stale ones cause the prefilter to escalate unnecessarily.',
  '',
  '== BRANCHING ACROSS DOMAINS ==',
  'When you set scope "branch" with a branchName, the new type INHERITS the parent\'s',
  'systemPrompt unless you override it. If the branchName signals a DIFFERENT domain',
  'than the parent (e.g. parent is "Hydrogen: WebGL platformer builder", branch is',
  '"WebGLMinesweeper"), the parent\'s platformer instructions will silently contaminate',
  'the new child — producing a Frankenstein that "knows" it must build Minesweeper but',
  'retains validation contracts, keybindings, and code patterns for a platformer.',
  'HARD RULE: whenever branchName signals a different domain from the parent\'s',
  'description, modifications MUST include a complete systemPromptReplace that fully',
  'rewrites the parent prompt for the new domain. Do NOT rely on systemPromptAppend or',
  'additionalContext to "override" the parent — inherited instructions outweigh a short',
  'appended note. In the modifications.descriptionReplace, also give the branch a fresh',
  'description matching its new purpose.',
  '',
  '== OUTPUT ==',
  'Verdict shapes:',
  '  {"approved": true, "reasoning": "..."}',
  '  {"approved": false, "reasoning": "...", "modifications": {...}, "scope": "ephemeral"|"patch"|"branch", "branchName"?: "..."}',
  'Your entire response MUST start with "{" and be ONLY the JSON object.',
  'BREVITY: keep "reasoning" under 120 words — a crisp diagnosis beats a long',
  'essay. Earlier runs saw verdicts truncated mid-sentence (stop_reason',
  '"max_tokens") because reasoning ballooned into paragraphs, losing the',
  'modifications block entirely and crashing the parser. One sharp sentence on',
  'what is wrong plus the concrete fix in "modifications" is enough.',
].join('\n');

/**
 * Compact params for validation: verdict JSON is short, be fast and
 * deterministic. We give a generous maxTokens budget so the JSON suffix
 * (`"modifications": {...}, "scope": "..."`) is never truncated even if the
 * model goes long on `reasoning` — truncation lost entire modifications
 * blocks in earlier runs. The prompt also tells the model to keep reasoning
 * under 120 words, so typical completions still stay small.
 */
const VALIDATION_PARAMS: GenerationParams = { temperature: 0, maxTokens: 2048 };

export async function llmVerdict(args: {
  ctx: RunContext;
  model: string;
  supervisorName: string;
  supervisorTier: Tier;
  subject: 'PLAN' | 'RESULT';
  child: Atom;
  task: Task;
  payload: unknown;
  /**
   * Optional pre-formatted description of the atoms the plan references
   * (usually the DELEGATION target's name + description + trust counters).
   * Injected verbatim into userContent so Haiku doesn't have to guess what
   * an atom named "Fluorine" actually does. Without this field, earlier
   * runs saw Haiku reject a valid `delegate to L1 "Fluorine"` plan with
   * hallucinated reasoning ("Fluorine's description indicates it builds
   * generic web apps/games without specialization in WebGL") even though
   * Fluorine's description literally said "WebGL Minesweeper builder".
   * The caller builds this string (it has the registry); we just inject.
   */
  targetContext?: string;
}): Promise<Verdict> {
  // `Subject kind` is repeated as its own field so the validator cannot miss
  // the PLAN-vs-RESULT distinction — the bar is different between the two and
  // earlier runs showed Haiku collapsing them together (rejecting PLANs for
  // not being completed RESULTs yet).
  const subjectHint =
    args.subject === 'PLAN'
      ? 'PLAN — the child proposes what it INTENDS to do; do NOT demand execution evidence yet.'
      : "RESULT — the child claims the work is DONE; check the output against the task's success criteria.";

  // Plan kind is a structural signal so the validator applies the
  // visible-deliverables checklist to the right tier. L1 is the executor
  // (plans there are DIRECT), L2/L3 route to a lower tier (plans there are
  // DELEGATION — enumeration is the downstream L1's responsibility, not
  // theirs). Without this hint, Haiku rejected perfectly valid L2 delegation
  // plans for "missing VISIBLE deliverables", starving the run of tool calls.
  const planKind: 'DIRECT' | 'DELEGATION' = args.child.tier === 1 ? 'DIRECT' : 'DELEGATION';
  const planKindHint =
    planKind === 'DIRECT'
      ? 'DIRECT — the child IS the executor (tier 1 or fallback); apply the VISIBLE-deliverables checklist.'
      : 'DELEGATION — the child is routing to a lower tier; do NOT demand visible-deliverable enumeration in THIS plan — that is the downstream L1\'s job.';

  // Ground-truth probe: for RESULT verdicts that include a URL, re-run
  // validate_html ourselves (if available) with a minimal independent
  // configuration. This breaks the "child self-reports success → validator
  // rubber-stamps" loop observed in the WebGL Minesweeper run where the
  // RESULT literally said "smokeTests: all passed" and the validator simply
  // believed it. We don't invent task-specific interactions (too risky); we
  // just check the page loads cleanly. If the page throws pageerror or has
  // console errors the validator now has hard evidence the claim is false.
  const groundTruthBlock = await probeGroundTruth(args);

  const userContent = [
    `Supervisor: "${args.supervisorName}" (tier ${args.supervisorTier})`,
    `Child: "${args.child.name}" (tier ${args.child.tier})`,
    `Subject kind: ${subjectHint}`,
    `Plan kind: ${planKindHint}`,
    `Task: ${args.task.description}`,
    args.targetContext ? `Delegation target(s):\n${args.targetContext}` : '',
    `${args.subject}: ${JSON.stringify(args.payload)}`,
    groundTruthBlock,
  ]
    .filter(Boolean)
    .join('\n');

  const resp = await args.ctx.llm.complete({
    model: args.model,
    systemPrompt: VALIDATION_SYSTEM_PROMPT,
    userContent,
    params: VALIDATION_PARAMS,
    signal: args.ctx.signal,
  });

  const raw = parseVerdict(resp.text);
  if (raw.approved) return raw;
  return { ...raw, branchName: raw.branchName ?? undefined };
}

/**
 * Extract likely delegation-target atom names from a PLAN payload and build
 * a compact context string with each target's description + trust counters,
 * for injection into the validator's userContent.
 *
 * Heuristic: scans `proposedAction` (and optionally `expectedOutput`) for
 * `L\d "name"` or `\bL\d-(name)\b` patterns, plus any catalog name that
 * appears as a whole word. We don't parse strategy JSON (not every plan
 * carries one). Returns `undefined` when no target can be identified or
 * the registry has no matching entry — in that case the verdict skips the
 * block entirely rather than inject noise.
 */
export function buildTargetContext(
  plan: unknown,
  registry: AtomRegistry
): string | undefined {
  if (!plan || typeof plan !== 'object') return undefined;
  const planObj = plan as Record<string, unknown>;
  const haystack = [planObj['proposedAction'], planObj['expectedOutput']]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n');
  if (haystack.length === 0) return undefined;

  const found: string[] = [];
  const seen = new Set<string>();

  // Structured hint: `L1 "Foo"` / `L2 "Bar"` — the canonical delegation shape
  // produced by L2/L3 `plan()`. Catches the common case first.
  const quoted = /\bL[123]\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(haystack)) !== null) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }

  // Fallback scan: any catalog atom name that appears as a whole word in
  // the haystack. Keeps the set bounded by requiring registry presence.
  if (found.length === 0) {
    for (const tier of [1, 2, 3] as const) {
      for (const t of registry.listByTier(tier)) {
        const safe = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${safe}\\b`);
        if (re.test(haystack) && !seen.has(t.name)) {
          seen.add(t.name);
          found.push(t.name);
        }
      }
    }
  }

  const lines: string[] = [];
  for (const name of found) {
    const type = registry.getByName(name);
    if (!type) continue;
    const desc = stripBranchProvenance(type.description);
    lines.push(
      `  - ${type.name} (L${type.tier}, v${type.version}, ✓${type.successes}/✗${type.failures}): ${desc}`
    );
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Extract a URL to probe from a RESULT payload. We check, in order:
 *   1. `output.url` — the canonical structured shape
 *   2. top-level `url`
 *   3. `output` as a bare URL string (the shape Haiku most often emits:
 *      `{"output":"http://localhost:8000/index.html","summary":"…"}`)
 *   4. any `http(s)://` URL embedded in `output` or `summary` as free text
 *      (regex scan — last-resort so we still auto-probe when the model
 *      narrates "the server is running at http://…" inside the summary).
 *
 * Earlier builds missed (3) and (4), which meant the ground-truth probe
 * never fired on WebGL Minesweeper runs — every RESULT verdict rejected for
 * "no GROUND-TRUTH EVIDENCE block" even though the L1 had just passed
 * validate_html. That false-negative loop burned the 10-minute deadline.
 */
export function extractResultUrl(payload: unknown): string | null {
  const urlRe = /^https?:\/\//i;
  if (typeof payload === 'string' && urlRe.test(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const output = obj['output'];
  if (output && typeof output === 'object') {
    const u = (output as Record<string, unknown>)['url'];
    if (typeof u === 'string' && urlRe.test(u)) return u;
  }

  const topLevel = obj['url'];
  if (typeof topLevel === 'string' && urlRe.test(topLevel)) return topLevel;

  if (typeof output === 'string' && urlRe.test(output)) return output;

  // Free-text fallback: scan `output` (if string) and `summary` for the
  // first http(s) URL. Stops at whitespace, quotes, or angle brackets —
  // conservative enough not to grab trailing punctuation.
  const freeTextRe = /https?:\/\/[^\s"'<>)]+/i;
  const candidates: string[] = [];
  if (typeof output === 'string') candidates.push(output);
  const summary = obj['summary'];
  if (typeof summary === 'string') candidates.push(summary);
  for (const s of candidates) {
    const m = s.match(freeTextRe);
    if (m && m[0]) return m[0];
  }
  return null;
}

async function probeGroundTruth(args: {
  ctx: RunContext;
  subject: 'PLAN' | 'RESULT';
  payload: unknown;
}): Promise<string> {
  if (args.subject !== 'RESULT') return '';
  const tools = args.ctx.tools;
  if (!tools || !tools.has('validate_html')) return '';
  const url = extractResultUrl(args.payload);
  if (!url) return '';

  try {
    // Minimal load-and-look probe: no interactions, no smoke. The goal is
    // "does this URL load cleanly?", not "does gameplay work?". Invented
    // interactions could false-positive-fail a working deliverable; the
    // clean-load bar is conservative.
    const raw = await tools.execute('validate_html', { url, waitMs: 1500 });
    const summary = summarizeValidateHtml(raw);
    return [
      '',
      '== GROUND-TRUTH EVIDENCE (independent re-validation) ==',
      `Supervisor independently re-ran validate_html on ${url}.`,
      'This is OBJECTIVE evidence — weight it above the child\'s self-reported claims.',
      'If this evidence contradicts the child\'s RESULT, REJECT the verdict.',
      summary,
    ].join('\n');
  } catch (err) {
    // Probe failures are themselves signal (e.g. URL unreachable → the
    // child's deliverable isn't actually running). Surface, don't swallow.
    return [
      '',
      '== GROUND-TRUTH EVIDENCE (independent re-validation) ==',
      `Supervisor tried to re-run validate_html on ${url} but the tool call failed:`,
      `  ${(err as Error).message}`,
      'This strongly suggests the child\'s deliverable is not actually running.',
    ].join('\n');
  }
}

function summarizeValidateHtml(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return `result: ${JSON.stringify(raw)}`;
  const r = raw as Record<string, unknown>;
  const ok = r['ok'];
  const errors = Array.isArray(r['errors']) ? (r['errors'] as unknown[]) : [];
  const failedRequests = Array.isArray(r['failedRequests'])
    ? (r['failedRequests'] as unknown[])
    : [];
  const lines = [
    `ok: ${ok === true ? 'true' : 'false'}`,
    `consoleErrors: ${errors.length}`,
    `failedRequests: ${failedRequests.length}`,
  ];
  if (errors.length > 0) {
    lines.push(`errors: ${JSON.stringify(errors.slice(0, 5))}`);
  }
  if (failedRequests.length > 0) {
    lines.push(`failedRequests: ${JSON.stringify(failedRequests.slice(0, 5))}`);
  }
  return lines.join('\n');
}
