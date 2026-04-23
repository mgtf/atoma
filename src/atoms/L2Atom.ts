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
  parsePlanWithFallback,
  parseTwoJson,
  parseVerdict,
  planSchema,
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
import { resolveCreationDescription } from './capability.js';

/**
 * Shared smoke-test design guidance. Appended to every L1 system
 * prompt that the supervisor controls — both the one `createSubtaskL1`
 * emits on fresh-L1 creation and the one `buildNarrowL1Prompt` emits
 * on escalation branches. Keeping this block identical in both paths
 * means a new L1 starts with the same smoke discipline as a branched
 * one: IIFE-only, `window.__test` hooks for state-heavy apps, no
 * simulated-input cargo-culting.
 *
 * Earlier runs ran into two persistent pain points that this block
 * addresses:
 *   (1) smokes written as top-level statements (`const x = ...; x > 0`)
 *       which don't parse inside the tool's `(${smoke})` wrapper and
 *       cost a full Puppeteer round-trip per mistake;
 *   (2) smokes that try to reproduce domain-specific winning paths via
 *       simulated clicks — observed burning 15+ rounds on a chess
 *       puzzle asserting `statusText.includes('Checkmate')` after
 *       random clicks that could not produce a mate.
 */
export const SMOKE_DESIGN_GUIDANCE = [
  `== SMOKE-TEST DESIGN (read carefully — this is where runs go wrong) ==`,
  `The \`smoke\` arg of validate_html is evaluated inside`,
  `  (() => { const __r = (YOUR_CODE); return __r; })()`,
  `so YOUR_CODE must be a pure EXPRESSION. These ALL break parsing:`,
  `    const x = 1; x > 0         // top-level \`const\``,
  `    return x > 0               // top-level \`return\``,
  `    if (cond) { return true }  // top-level \`if\``,
  `Wrap any logic in an IIFE when you need locals or statements:`,
  `    (() => { const x = compute(); return x > 0 })()`,
  `    (function(){ /* ... */ return result })()`,
  ``,
  `== STATE-HEAVY APPS: expose a __test hook, do NOT simulate inputs ==`,
  `For games with rules (chess, minesweeper, roguelikes), for`,
  `multi-step flows (wizards, forms with validation), or for any app`,
  `whose success criterion needs domain-specific knowledge — DO NOT`,
  `try to reproduce the winning path via simulated clicks/keypresses.`,
  `Random clicks on a chess board will never produce a checkmate, and`,
  `the smoke loop will grind for many rounds with the same false`,
  `assertion (observed in production: 15+ wasted Puppeteer rounds`,
  `asserting \`statusText.includes('Checkmate')\` after arbitrary`,
  `clicks).`,
  `Instead, EXPOSE a deterministic test hook from the app code:`,
  `    window.__test = {`,
  `      forceState(scenario) { /* seed the exact position */ },`,
  `      checkInvariant() { /* return bool for the claim you verify */ },`,
  `    };`,
  `Then the smoke becomes trivial and reliable:`,
  `    (() => { window.__test.forceState('mate-in-1-back-rank');`,
  `             return window.__test.checkInvariant(); })()`,
  `The hook is production-harmless (guarded by a flag, or simply`,
  `always-on — it adds <1KB). Validate_html output will also echo`,
  `coaching hints back to you when it rejects a smoke pre-flight or`,
  `detects the same smoke failing repeatedly; read and act on them.`,
  ``,
  `== SMOKE-LOOP DISCIPLINE ==`,
  `If the SAME smoke assertion fails more than twice, STOP retrying`,
  `it — the assertion is structurally unreachable with the current`,
  `inputs. Switch to either: a \`window.__test\` hook (see above), a`,
  `simpler invariant (element exists + renders), OR accept the`,
  `functionality as verified and return your final JSON output.`,
  `Interleaving a trivially-passing sanity smoke between real-retry`,
  `smokes does NOT reset the stuck detector — it is cumulative over`,
  `a sliding window.`,
].join('\n');

/**
 * Fresh narrow-responsibility system prompt used when `branchOnEscalation`
 * spawns a new L1 after the parent type couldn't solve a task. The parent
 * is kept intact; the NEW branch gets this prompt written fresh so it
 * doesn't carry forward any domain bias (e.g. "You are Nitrogen, a WebGL
 * platformer builder" bleeding into a dashboard task). The branched
 * atom's rebrandPersona pass at `registry.branch` time will then swap in
 * the branch's actual taxonomy name on the "You are {Name}" line.
 */
export function buildNarrowL1Prompt(subtaskDescription: string): string {
  return [
    `You are an L1 element builder with ONE narrow responsibility.`,
    `Your current subtask: ${subtaskDescription}`,
    ``,
    `Do NOT import assumptions from other domains — the parent type you`,
    `were branched from may have been narrowly specialised for a`,
    `different problem (platformer, minesweeper, etc.); IGNORE its`,
    `domain and focus SOLELY on this subtask as stated.`,
    ``,
    `Call tools sequentially to produce the deliverable. For web`,
    `artefacts:`,
    `  1. write_file the complete source`,
    `  2. start_static_server to serve it (port 0 = OS-assigned is fine)`,
    `  3. validate_html on the returned URL with appropriate interactions`,
    `     and a smoke check that asserts the key state transitions`,
    `  4. if validation fails: read_file, diagnose, write_file with the`,
    `     fix, re-validate. Up to 4 iterations.`,
    `  5. return JSON {"output": <url or summary>, "summary": "<one sentence>"}`,
    ``,
    `For non-web artefacts, adapt the loop but keep the JSON envelope.`,
    ``,
    SMOKE_DESIGN_GUIDANCE,
  ].join('\n');
}

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
        actor: { name: this.name, tier: 2 },
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
        // Prefilter degenerate case: one subtask, one preferred child.
        // The fan-out loop collapses to a single child run.
        return {
          reasoning: `prefilter selected ${prefilter.target}`,
          proposedAction: `delegate leaf task to L1 "${prefilter.target}"`,
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

    const peerCatalog = this.peers.map((p) => ({ name: p.name, ordinal: p.ordinal }));

    const userContent = [
      `You are atom "${this.name}" (tier 2 / molecule).`,
      ``,
      `HARD RULE: You NEVER execute tools yourself. You do NOT write files, run`,
      `shells, start servers, or validate anything. Your role is to DECOMPOSE the`,
      `task into orthogonal subtasks and route each to an L1 element (the only`,
      `tier that can call tools).`,
      ``,
      `== DECOMPOSITION DISCIPLINE ==`,
      `Split the task into a LIST of subtasks. Each subtask:`,
      `  - has ONE single-responsibility description ("write the HTML layout",`,
      `    "implement game state machine", "start server + run validation")`,
      `  - is ORTHOGONAL to every other subtask — no subtask reads or depends on`,
      `    another subtask's output. Subtasks run in PARALLEL.`,
      `  - targets a specific L1 element via "preferredChild" (required for N>1,`,
      `    optional for N=1 where your strategy field still drives selection).`,
      `A single-responsibility task is still valid: emit a list with exactly ONE`,
      `subtask. Do NOT force decomposition when the task is genuinely atomic.`,
      ``,
      `== AGGREGATION ==`,
      `Pick how the N sub-results combine into one deliverable:`,
      `  - "concat": mechanical array-join (cheap, no extra LLM call). Use when`,
      `    sub-results are independent artefacts or a list is the natural output.`,
      `  - "llm-synthesize": you run one more LLM call to merge the sub-results`,
      `    into a single coherent artefact. Use when the final deliverable is a`,
      `    COMBINED product (e.g. L1s produce layout/logic/render fragments, an`,
      `    aggregation step assembles them into one file). Provide a short`,
      `    "instruction" describing how to merge.`,
      ``,
      `== STRATEGY OPTIONS (picks the L1 baseline) ==`,
      `  - "reuse": pick an existing L1 element from the catalog that fits`,
      `  - "create": design a new L1 element and register it (provide a seed)`,
      `  - "mutualize": delegate to a peer L2 molecule when their specialty fits better`,
      `Prefer "reuse" over "create" whenever possible.`,
      ``,
      `CRITICAL — domain-match rule:`,
      `  ONLY "reuse" an L1 whose catalog description matches the task's domain.`,
      `  If the best candidate's description names a DIFFERENT domain than the`,
      `  task (e.g. you need a "dashboard builder" and the candidate is described`,
      `  as a "Mario-like platformer builder"), DO NOT reuse it — even if its`,
      `  toolset is the same and its workflow "looks similar". That atom's system`,
      `  prompt is domain-biased and will fight your task for 5 iterations before`,
      `  escalating. Use "create" with a fresh narrow seed instead. Cross-domain`,
      `  reuse is the #1 failure mode in the training trace.`,
      ``,
      `CRITICAL — "preferredChild" naming rule:`,
      `  - If you set "preferredChild" on a subtask, it MUST be the EXACT name of`,
      `    an L1 already listed in the catalog below. Do NOT invent new names.`,
      `    Do NOT use chemical-element names like "Carbon" or "Oxygen" unless they`,
      `    are literally listed in the catalog.`,
      `  - If none of the existing L1s fit a subtask, OMIT "preferredChild" entirely`,
      `    and set strategy="create" — the supervisor will auto-spawn a fresh L1`,
      `    whose narrow responsibility matches your subtask.description.`,
      `  - Never mix: do not set "preferredChild" to an uncatalogued name "hoping"`,
      `    it will be created. The supervisor does auto-create on miss but you`,
      `    lose the ability to control its description and seed.`,
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
      `  {"reasoning": "...", "subtasks": [{"description": "...", "preferredChild": "<L1-name>"?, "inputs": {}?}, ...], "aggregation": {"mode": "concat"|"llm-synthesize", "instruction": "..."?}, "expectedOutput": "..."}`,
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

    const subtasks = plan.subtasks;

    // Fan-out: run each subtask in parallel with per-subtask hooks. The
    // hooks close over the subtask's description so `branchOnEscalation`
    // can write a FRESH system prompt aligned with THIS subtask's
    // domain — not the parent's (which is where the Frankenstein
    // contamination came from: Nitrogen kept its platformer prompt
    // through branches even when branched for a dashboard task).
    const subResults = await Promise.all(
      subtasks.map((subtask, idx) => {
        const hooks = this.makeL1Hooks(ctx, subtask.description);
        return this.runSubtask({ subtask, strategy, parentTask: task, idx, hooks, ctx });
      })
    );

    return this.aggregate(subResults, plan.aggregation, task, ctx);
  }

  /**
   * Run one subtask through a supervise-loop on the appropriate L1 child.
   * Child resolution order:
   *   1. subtask.preferredChild → registry lookup (must exist)
   *   2. degenerate single-subtask fan-out → fall back to the strategy
   *      resolved at plan-time (reuse/create)
   *   3. multi-subtask fan-out without preferredChild → error (the
   *      planner is expected to label each subtask with its target L1)
   */
  private async runSubtask(args: {
    subtask: Plan['subtasks'][number];
    strategy: L2Strategy;
    parentTask: Task;
    idx: number;
    hooks: SupervisionHooks<L1Atom>;
    ctx: RunContext;
  }): Promise<Result> {
    const { subtask, strategy, parentTask, idx, hooks, ctx } = args;
    const l1Type = this.resolveL1ForSubtask(subtask, strategy, parentTask, idx, ctx);
    this.triedChildren.mark(l1Type.name);
    const l1 = L1Atom.fromType(l1Type);
    const subTask: Task = subtask.inputs
      ? { description: subtask.description, inputs: subtask.inputs }
      : { description: subtask.description };
    // Fork a branch-scoped ctx so every LLM/tool/trust event recorded
    // inside this supervise loop carries a unique branchId. Viz renders
    // each branch as its own lane instead of interleaving them.
    const branchCtx = forkBranch(ctx, randomUUID());
    return superviseLoop<L1Atom>(this, l1, subTask, branchCtx, hooks);
  }

  private resolveL1ForSubtask(
    subtask: Plan['subtasks'][number],
    strategy: L2Strategy,
    parentTask: Task,
    idx: number,
    ctx: RunContext
  ): AtomType {
    if (subtask.preferredChild) {
      const found = this.registry.getByName(subtask.preferredChild);
      if (found) {
        if (found.tier !== 1) {
          throw new Error(
            `subtask preferredChild "${subtask.preferredChild}" is tier ${found.tier}, expected L1`
          );
        }
        return found;
      }
      // Planner hallucination: preferredChild does not exist. Sonnet
      // sometimes invents chemical-element names ("Carbon") that AREN'T
      // in the catalog yet. Rather than crash the whole fan-out (killing
      // N-1 healthy subtasks via Promise.all), create a NEW L1 on the fly
      // whose description takes the subtask's own description — that way
      // future runs can prefilter to it. The auto-assigned taxonomy name
      // will differ from the hallucinated one; we log the mismatch.
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} preferredChild "${subtask.preferredChild}" not in registry — auto-creating a fresh L1`
      );
      return this.createSubtaskL1(subtask, strategy, parentTask);
    }
    // No preferredChild: the single-subtask path uses the strategy
    // resolved at plan-time. For idx > 0 we still auto-create to
    // avoid the same "kill the whole fan-out" failure mode — the
    // planner is mis-behaving but the run can still produce SOME
    // output rather than none.
    if (idx > 0) {
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} has no preferredChild — auto-creating a fresh L1 (planner should have labeled this subtask)`
      );
      return this.createSubtaskL1(subtask, strategy, parentTask);
    }
    if (strategy.strategy === 'reuse') {
      if (!strategy.target) throw new Error('reuse requires target');
      const found = this.registry.getByName(strategy.target);
      if (!found) throw new RegistryNotFoundError(strategy.target);
      return found;
    }
    // create with explicit strategy seed
    return this.createSubtaskL1(subtask, strategy, parentTask);
  }

  /**
   * Create a new L1 for a subtask that couldn't be routed to an existing
   * catalog entry. Used both for explicit `strategy: "create"` plans and
   * for the fallback paths above (hallucinated preferredChild, missing
   * preferredChild in multi-subtask plan). Description defaults to the
   * subtask's own description, so the new L1's catalog entry is
   * prefilter-friendly on future runs.
   */
  private createSubtaskL1(
    subtask: Plan['subtasks'][number],
    strategy: L2Strategy,
    parentTask: Task
  ): AtomType {
    const seed: NonNullable<typeof strategy.seed> =
      strategy.seed ?? ({ tools: [], params: {} } as NonNullable<typeof strategy.seed>);
    const mergedTools = mergeTools(this.tools, (seed.tools ?? []) as Tool[]);
    // IMPORTANT: the registry description is the prefilter key on future
    // runs. Early versions echoed the full task narrative here ("L1 for
    // subtask: build a chess puzzle with 8x8 board + drag-and-drop + …"),
    // which locked each new L1 to a single theme and polluted the catalog
    // with task-bound singletons that prefilter could never re-use
    // cross-domain. We now force a capability-first label derived from
    // the tool signature; task-specific info still flows to the atom via
    // `handle(task, ctx)` at runtime. See `src/atoms/capability.ts` for
    // the full rationale.
    return this.registry.create(1, {
      description: resolveCreationDescription(seed.description, mergedTools),
      // Default system prompt emphasises SINGLE-RESPONSIBILITY. A freshly
      // created L1 should be a narrow specialist — one concern, one output
      // shape — not a Swiss-army knife that tries to solve the whole task.
      systemPrompt:
        seed.systemPrompt ??
        [
          `You are an L1 element with ONE narrow responsibility.`,
          `DO NOT attempt to solve the whole task — only the specific subtask you are handed.`,
          `Call tools sequentially to produce your single output. Return a structured`,
          `{"output", "summary"} JSON at the end.`,
          ``,
          `Scope boundary: if the subtask seems to require coordinating with other`,
          `subtasks (reading their outputs, sharing state) — that's a planning bug at`,
          `a higher tier. You still execute YOUR subtask in isolation; do NOT invent`,
          `cross-subtask side effects.`,
          ``,
          `Subtask you were handed: ${subtask.description}`,
          `Parent task (for context only): ${parentTask.description}`,
          ``,
          // Same smoke-test discipline as the escalation-branch path
          // (buildNarrowL1Prompt). Without this block, a newly-created
          // L1 missed the IIFE/__test guidance and burned rounds on
          // the two failure modes it diagnoses (observed on the chess
          // puzzle run: 20+ validate_html calls rotating the same
          // unreachable assertion).
          SMOKE_DESIGN_GUIDANCE,
        ].join('\n'),
      tools: mergedTools,
      params: (seed.params ?? this.params) as GenerationParams,
      createdBy: this.name,
    });
  }

  private makeL1Hooks(ctx: RunContext, subtaskDescription: string): SupervisionHooks<L1Atom> {
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
        // Aligned system prompt: start the branch FRESH with the current
        // subtask's domain, not inherited from the parent. Without this
        // reset, a "platformer builder" parent gets branched into a
        // "dashboard builder" child that still introduces itself as a
        // platformer and keeps emitting platformer plans (Frankenstein).
        const narrowPrompt = buildNarrowL1Prompt(subtaskDescription);
        const narrowDesc = `L1 narrow builder for: ${subtaskDescription.slice(0, 120)}`;
        const branched = this.registry.branch(
          child.name,
          {
            systemPromptReplace: narrowPrompt,
            descriptionReplace: narrowDesc,
            additionalContext:
              `Branched after escalation. Previous attempts failed because the inherited prompt` +
              ` was misaligned with this task. Prompt has been reset to a narrow template focused` +
              ` on the current subtask.`,
          },
          this.name,
          undefined
        );
        ctx.logger.warn(
          `[${this.name}] escalation — branched ${child.name} → ${branched.name} (${reason})`
        );
        // Return a fresh L1 instance of the branched type so the supervise
        // loop can give it one attempt before falling back to this L2.
        // Without this, the branch was recorded in the registry but never
        // actually tried on the current task — purely a lesson for future
        // runs. By handing the new instance back we let the anti-
        // Frankenstein narrow prompt prove itself in-flight.
        return L1Atom.fromType(branched);
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
   * Combine N sub-results into the supervisor's single Result.
   *   - `concat`: mechanical array-join. Cheap, no LLM call. Output
   *     becomes `[subResults[0].output, subResults[1].output, …]`
   *     unless N=1 where we return the single result directly (same
   *     shape as pre-fan-out behaviour).
   *   - `llm-synthesize`: ask the supervisor's own model to merge the
   *     N sub-results into a final `{output, summary}` using
   *     `aggregation.instruction` as the merge prompt.
   */
  private async aggregate(
    subResults: Result[],
    aggregation: Plan['aggregation'],
    parentTask: Task,
    ctx: RunContext
  ): Promise<Result> {
    if (subResults.length === 1) {
      // Degenerate fan-out (N=1): preserve the exact pre-fan-out shape so
      // existing call sites and tests see no difference.
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
        producedBy: { tier: 2, name: this.name, viaFallback: false },
      };
    }
    // llm-synthesize
    const userContent = [
      `You are "${this.name}" (tier 2). Synthesise a single result from ${subResults.length} sub-results.`,
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
      producedBy: { tier: 2, name: this.name, viaFallback: false },
    };
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
    // Tolerant parse WITH fallback: even with the explicit "emit ONE
    // object" hint above, Sonnet's non-fallback routing prompt is
    // heavily conditioned to emit a `[strategy, plan]` pair. When it
    // goes even more off-piste (emitting pure strategy JSON, a result
    // envelope, or free-form prose), `parsePlanWithFallback` synthesises
    // a stub plan from the task rather than crashing the whole run —
    // selfExecute can still do real work with the tools, and a missing
    // "plan text" is not a reason to throw away the fallback safety net.
    return parsePlanWithFallback(resp.text, {
      reasoning: `fallback: could not parse a plan from the LLM response; proceeding with direct execution of the task`,
      proposedAction: `execute the task directly using the available tools (${
        this.tools.map((t) => t.name).join(', ') || 'none'
      })`,
      expectedOutput: task.description,
    });
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
  '  VISIBLE-DELIVERABLES RULE (tier-aware, narrowly scoped):',
  '    - If Plan kind is DIRECT (child tier 1, the executor, OR a supervisor acting',
  '      in fallback): reject ONLY when the plan commits to building a',
  '      materially WRONG artefact — colored shapes in place of task-named',
  '      numbers/icons, a static page in place of the task-named interactive',
  '      element, or a stand-in for a task-named affordance that clearly',
  '      cannot satisfy the task (e.g. task says "Minesweeper" and the plan',
  '      does not mention mine counts or flag icons at all).',
  '      When you reject, name the CONCRETE task-stated element that the plan',
  '      fails to cover, in one short sentence, and put it in',
  '      modifications.additionalContext. A single missing element is enough',
  '      — do not chain a checklist of optional polish items.',
  '      DO NOT reject a plan because:',
  '        * it omits prose enumeration of affordances the implementation',
  '          will naturally produce (e.g. the plan says "FPS meter with',
  '          rolling graph and numeric readout" — that IS sufficient, you',
  '          need not demand a per-pixel breakdown of axis labels, grid',
  '          lines, tick formats);',
  '        * the smoke-test snippet could be slightly more thorough — smoke',
  '          quality is a RESULT-phase concern (re-evaluate then via ground',
  '          truth), not a plan-phase blocker;',
  '        * it could "go further" on feedback polish, end-state screens,',
  '          animation detail, etc. — absence of polish is not structural',
  '          brokenness and is NOT grounds for plan rejection.',
  '      Heuristic: if the plan, executed faithfully, would plausibly pass a',
  '      validate_html + smoke-check against the task, approve it. The plan',
  '      phase is a sanity gate, not a design review.',
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
  '== FAN-OUT DECOMPOSITION ==',
  'When Subject kind is PLAN and the plan carries a "subtasks" list, the child',
  'supervisor has decomposed the task into orthogonal parallel subtasks. Verify:',
  '  - subtasks is a non-empty array. Single-subtask plans (N=1) are PERFECTLY',
  '    VALID — a genuinely atomic task (e.g. "build one index.html with all',
  '    concerns in one file") should NOT be padded with artificial subtasks.',
  '    DO NOT reject a plan just because N=1. DO NOT reject because',
  '    "aggregation.mode is \'concat\' for a single artefact" — concat is the',
  '    correct default for N=1, it is a no-op (the single sub-result passes',
  '    through unchanged). The ONLY reason to require "llm-synthesize" is when',
  '    N>1 AND the final deliverable is a COMBINED product of the sub-results.',
  '  - each subtask has a concrete "description" (not "do the next step"). The',
  '    planner must write each description precisely enough that a child can act',
  '    on it without needing to read the others.',
  '  - NO subtask depends on another\'s output. Subtasks run in PARALLEL via',
  '    Promise.all; if the planner wrote "subtask 2 uses subtask 1\'s URL", that',
  '    is STRUCTURALLY BROKEN — reject with scope "ephemeral" and an',
  '    additionalContext pointing at the implicit dependency.',
  '  - for N>1, each subtask SHOULD carry "preferredChild". A missing or',
  '    invented "preferredChild" (a name not present in the "Delegation',
  '    target(s):" block) will force the supervisor to auto-create a fresh',
  '    child whose description matches subtask.description. That is',
  '    recoverable but wasteful — if "preferredChild" is set, it MUST match',
  '    an actual catalog entry. Reject plans that reference an unknown name',
  '    (e.g. "Carbon" when the catalog lists only "Hydrogen, Helium, …")',
  '    with scope "ephemeral" and an additionalContext telling the planner',
  '    to either use a real catalog name or omit preferredChild entirely.',
  '  - "aggregation.mode" is one of "concat" (mechanical join) or',
  '    "llm-synthesize" (merge via an extra LLM call). If the final deliverable',
  '    is a SINGLE combined artefact (e.g. an index.html assembled from pieces)',
  '    "concat" is almost always wrong — prefer "llm-synthesize" with a clear',
  '    "instruction" string.',
  'Artefact-collision rule: if two subtasks both produce side-effects on the',
  'same named resource (same file path, same port, same DB row), that is NOT',
  'parallel-safe. Reject with a note about which resources collide.',
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
  '',
  '== WORKED EXAMPLES ==',
  'The following examples anchor the rules above on concrete past runs.',
  'Each one is a SHORT reconstruction: the Subject/Plan kind, a one-line',
  'summary of the child\'s output, and the CORRECT verdict. Use them as',
  'pattern-matching reference — NOT as templates to copy verbatim.',
  '',
  '-- Example 1 — DELEGATION plan, approved --',
  '  Subject kind: PLAN | Plan kind: DELEGATION | child: L2 "Water"',
  '  Child summary: "delegate leaf task to L1 \'Fluorine\' with',
  '  expectedOutput=\'playable WebGL Minesweeper with mine counts and',
  '  flag icons visible\'"',
  '  Correct verdict: {"approved": true, "reasoning": "DELEGATION to',
  '  Fluorine; expectedOutput preserves task-stated visible affordances',
  '  (mine counts, flag icons). Enumeration is L1\'s responsibility."}',
  '  Why: the catalog name is real (Fluorine exists), the expectedOutput',
  '  carries the task\'s implicit requirements forward, and per the',
  '  DELEGATION rule we do NOT demand per-affordance prose here.',
  '',
  '-- Example 2 — DELEGATION plan, rejected for dropped constraint --',
  '  Subject kind: PLAN | Plan kind: DELEGATION | child: L2 "Glucose"',
  '  Child summary: "delegate to L1 \'Carbon\' with expectedOutput=\'a',
  '  playable grid game\'" (task explicitly said "10x10 Minesweeper with',
  '  30 mines")',
  '  Correct verdict: {"approved": false, "reasoning": "expectedOutput',
  '  drops critical task constraints (\'10x10\', \'30 mines\'). Rewrite to',
  '  preserve them.", "modifications": {"additionalContext": "restore',
  '  \'10x10 grid with 30 mines\' in expectedOutput"}, "scope":',
  '  "ephemeral"}',
  '  Why: the delegation target is fine but the delegator threw away',
  '  information the downstream L1 needs. Ephemeral — no need to rewrite',
  '  the type, just re-emit the plan with constraints preserved.',
  '',
  '-- Example 3 — DIRECT plan, approved --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Chlorine"',
  '  Child summary: "write index.html with 3 columns (FPS canvas+numeric',
  '  readout, mouse tracker with coords/delta/trail, keystroke logger',
  '  with timestamps). Start server. validate_html with interactions +',
  '  smoke checking fpsUpdated, mouseNonZero, keyEntries>=1."',
  '  Correct verdict: {"approved": true, "reasoning": "Plan commits to',
  '  the three task-named columns, each with its required affordance.',
  '  Implementation-faithful plan would plausibly pass validate_html +',
  '  smoke. Approve."}',
  '  Why: the plan names each task-stated element and commits to a',
  '  smoke-check that would detect regression on each. No prose',
  '  enumeration of axis-ticks / pixel-level polish is required.',
  '',
  '-- Example 4 — DIRECT plan, rejected for materially wrong artefact --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Boron"',
  '  Child summary: "write index.html with 3 colored boxes (red, green,',
  '  blue) and a button" (task: "Minesweeper with mine counts and flag',
  '  icons")',
  '  Correct verdict: {"approved": false, "reasoning": "Plan produces',
  '  colored boxes; task requires Minesweeper with mine counts and flag',
  '  icons. Concrete missing element: numeric mine-count tiles.",',
  '  "modifications": {"additionalContext": "rewrite to render a grid',
  '  of tiles with numeric mine counts and clickable flag icons"},',
  '  "scope": "ephemeral"}',
  '  Why: materially wrong artefact. Name the CONCRETE missing task-',
  '  stated element once ("numeric mine-count tiles") — do not chain a',
  '  checklist of every possible polish item.',
  '',
  '-- Example 5 — RESULT, ground-truth evidence contradicts child --',
  '  Subject kind: RESULT | Plan kind: DIRECT | child: L1 "Fluorine"',
  '  Child summary: "dashboard built, all three columns working, zero',
  '  errors" — GROUND-TRUTH EVIDENCE: ok=false, errors=["Uncaught',
  '  TypeError: Cannot read properties of null"], failedRequests=0',
  '  Correct verdict: {"approved": false, "reasoning": "Ground-truth',
  '  shows a null-dereference error contradicting child\'s claim.",',
  '  "modifications": {"additionalContext": "Uncaught TypeError in',
  '  production — likely a DOM element accessed before DOMContentLoaded',
  '  or before it exists"}, "scope": "ephemeral"}',
  '  Why: self-reported success is NEVER evidence. The ground-truth',
  '  block is the supervisor\'s independent probe and outranks the',
  '  child\'s narration. Ephemeral retry with the error surfaced.',
  '',
  '-- Example 6 — RESULT, approved on own-merits (no ground-truth) --',
  '  Subject kind: RESULT | Plan kind: DELEGATION | child: L2 "Sucrose"',
  '  Child summary: "http://localhost:8181/ with the 3-column dashboard',
  '  live; L1 validated internally with zero errors" — no GROUND-TRUTH',
  '  block (the probe did not fire because the tool wasn\'t wired)',
  '  Correct verdict: {"approved": true, "reasoning": "URL present, L2',
  '  reports internal L1 validation passed. Absence of ground-truth',
  '  block is not grounds for rejection; evaluate on own merits."}',
  '  Why: the ground-truth probe is a supervisor-side convenience; when',
  '  absent the result is judged on the reported deliverable alone.',
  '  Demanding the child produce a ground-truth block themselves is a',
  '  false-rejection pattern that starves runs of progress.',
  '',
  '-- Example 7 — DESCRIPTION drift, scope "patch" --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Hydrogen"',
  '  Child summary: reasonable plan for the task (Minesweeper) — BUT',
  '  child\'s type description still says "Mario-like platformer builder"',
  '  and its systemPrompt was long ago rewritten toward Minesweeper.',
  '  Correct verdict: {"approved": false, "reasoning": "Description has',
  '  drifted from actual capability. Update for prefilter accuracy.",',
  '  "modifications": {"descriptionReplace": "L1 builder for single-',
  '  file WebGL Minesweeper: writes, serves, and iterates until',
  '  validate_html passes."}, "scope": "patch"}',
  '  Why: the description is the prefilter\'s view of the child; stale',
  '  descriptions cause misrouting on future tasks. Patch (not branch)',
  '  because the type itself is fine — only its label is wrong.',
  '',
  '-- Example 8 — BRANCH across domain, systemPromptReplace required --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Hydrogen"',
  '  Child summary: plan for a dashboard task but the child is a',
  '  narrowly-scoped platformer-builder prompt ("You are Hydrogen, a',
  '  WebGL platformer builder"). Branch name: "DashboardBuilder".',
  '  Correct verdict: {"approved": false, "reasoning": "Branch to a',
  '  different domain requires a complete systemPromptReplace; do not',
  '  let platformer instructions contaminate the dashboard child.",',
  '  "modifications": {"systemPromptReplace": "<full fresh prompt for',
  '  dashboard builder>", "descriptionReplace": "L1 builder for single-',
  '  file interactive dashboards"}, "scope": "branch", "branchName":',
  '  "DashboardBuilder"}',
  '  Why: without systemPromptReplace the new branch inherits the',
  '  parent\'s platformer prompt — the Frankenstein pattern. Branching',
  '  across domains MUST reset the prompt.',
  '',
  '== PAD / CACHE-OPTIMISATION NOTE ==',
  'The worked examples above serve a second purpose beyond teaching:',
  'they extend the system prompt past the 4096-token minimum cacheable',
  'prompt length for Claude Haiku 4.5. Below that threshold, Anthropic',
  'silently skips prompt caching and every validator call pays full',
  'input price. Earlier runs showed cache_read=0 / cache_create=0 on',
  'every Haiku call because the prompt was ~3000 tokens — just short of',
  'the threshold. Keep this section intact even if it feels verbose:',
  'its cost is tiny (cache hit at 10% base price) and its presence is',
  'what flips caching on for the validators that dominate run cost.',
  'If you edit this prompt and shrink it below ~4100 tokens, expect',
  'validators to stop caching and run cost to roughly double.',
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
 * Fan-out aware: first checks `subtasks[].preferredChild` (authoritative
 * for multi-subtask plans since Phase 3). Falls back to legacy heuristics
 * — `L\d "name"` patterns and whole-word catalog scan in
 * `proposedAction` + `expectedOutput` — for single-subtask legacy plans
 * or plans that skip `preferredChild`. Returns `undefined` when no target
 * can be identified or the registry has no matching entry, so the verdict
 * skips the block entirely rather than inject noise.
 */
export function buildTargetContext(
  plan: unknown,
  registry: AtomRegistry
): string | undefined {
  if (!plan || typeof plan !== 'object') return undefined;
  const planObj = plan as Record<string, unknown>;

  const found: string[] = [];
  const seen = new Set<string>();

  // Authoritative path: subtasks.preferredChild, one per subtask. This
  // is where multi-subtask fan-out plans explicitly name their targets,
  // so we rely on it first and skip the regex heuristics when present.
  const subtasks = planObj['subtasks'];
  if (Array.isArray(subtasks)) {
    for (const st of subtasks) {
      if (!st || typeof st !== 'object') continue;
      const pc = (st as Record<string, unknown>)['preferredChild'];
      if (typeof pc === 'string' && pc.length > 0 && !seen.has(pc)) {
        seen.add(pc);
        found.push(pc);
      }
    }
  }

  if (found.length === 0) {
    const haystack = [planObj['proposedAction'], planObj['expectedOutput']]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    if (haystack.length === 0 && found.length === 0) return undefined;

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
