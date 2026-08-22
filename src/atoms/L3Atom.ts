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
import { modelForTier, resolveLatestOpus, FALLBACK_OPUS, type ModelListingClient } from '../core/models.js';
import { capToolIterations } from '../core/limits.js';
import { dispatchWithAggregation } from './dispatch.js';
import { acceptL3RootPlan } from './l3RootPlan.js';
import { L2Atom } from './L2Atom.js';
import {
  buildTargetContext,
  checkGroundTruth,
  llmVerdict,
  requiredPassingCommands,
  taskRequiresRealBrowser,
  type GroundTruthCheck,
} from './L2Atom.js';
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
import {
  bucketIdForTools,
  extractBranchDiagnostic,
  resolveCreationDescription,
} from './capability.js';
import {
  HTTP_PORTABLE_DOC_GUIDANCE,
  LITERAL_CONTRACT_PRESERVATION_GUIDANCE,
  MUTATING_SUBTASK_FILE_GUIDANCE,
  PROOF_OBLIGATION_GUIDANCE,
  preservePlanLiteralContracts,
} from './prompts.js';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * Fresh narrow-domain system prompt for an L2 branched after escalation.
 * Same purpose as `buildNarrowL1Prompt`: start the branch clean instead
 * of inheriting the failed parent's prompt. The branched atom's
 * rebrandPersona pass at `registry.branch` time will swap in the branch's
 * actual taxonomy name on the "You are {Name}" line.
 */
export function buildNarrowL2Prompt(
  subtaskDescription: string,
  childTools: readonly Tool[] = [],
  diagnostic: string = ''
): string {
  // BUCKET-AWARE framing: the closing line hints at the downstream L1
  // bucket so the branched L2 orchestrator doesn't describe itself as
  // web-focused when its tools are HTTP-scoped (or vice-versa). Parallel
  // to buildNarrowL1Prompt — see there for the full rationale (fix #8b).
  const bucket = bucketIdForTools(childTools);
  const bucketHint =
    bucket === 'http-server-build+probe'
      ? `Your leaf tier-1 will write Node HTTP server code, boot it via start_node_server, and probe endpoints with fetch_url — do NOT ask it to run validate_html or start_static_server.`
      : bucket === 'web-artefact-build+validate'
        ? `Your leaf tier-1 will write a single-file web artefact, serve it via start_static_server, and validate via headless browser (validate_html).`
        : `Your leaf tier-1 works with whatever tools it has been handed — do not assume a specific bucket.`;
  const lines: string[] = [
    `You are an L2 cell that decomposes a single-purpose task into`,
    `orthogonal L1 molecule subtasks and supervises their parallel execution.`,
    ``,
    `Your current subtask: ${subtaskDescription}`,
    ``,
    `Do NOT import assumptions from other domains — the parent type you`,
    `were branched from may have been narrowly specialised for a`,
    `different problem. IGNORE its domain and focus SOLELY on this`,
    `subtask as stated.`,
    ``,
  ];
  // Diagnostic injection (#1) — see buildNarrowL1Prompt for the
  // rationale. Same shape, one tier up.
  if (diagnostic.length > 0) {
    lines.push(`== PRIOR ATTEMPT DIAGNOSIS (act on this, do NOT ignore) ==`);
    lines.push(diagnostic);
    lines.push(``);
    lines.push(
      `Your decomposition should target the SPECIFIC failure cited above — don't`
    );
    lines.push(
      `re-plan the full task from scratch when a targeted fix is the right move.`
    );
    lines.push(``);
  }
  lines.push(
    `You NEVER execute tools yourself. Your job:`,
    `  1. Decompose the subtask into 1+ L1 subtasks (orthogonal/parallel OR`,
    `     phased/sequential — pick the shape that matches the artefact's nature)`,
    `  2. Choose an L1 for each (reuse a catalog match or create a narrow new one)`,
    `  3. Pick aggregation mode: "concat" / "llm-synthesize" for parallel,`,
    `     "sequential" for phased pipelines on a shared workspace`,
    `  4. Return the strategy+plan JSON pair`,
    ``,
    bucketHint
  );
  return lines.join('\n');
}

export function routeCrossBucketVerification(plan: Plan, registry: AtomRegistry): Plan {
  const l2Types = registry.listByTier(2);
  const supportsBrowser = (name: string | undefined): boolean => {
    const type = name ? registry.getByName(name) : undefined;
    return type?.tier === 2 && type.tools.some((tool) => tool.name === 'validate_html');
  };
  const supportsShellHarness = (name: string | undefined): boolean => {
    const type = name ? registry.getByName(name) : undefined;
    return (
      type?.tier === 2 &&
      type.tools.some((tool) => tool.name === 'run_shell') &&
      type.tools.some((tool) => tool.name === 'start_node_server')
    );
  };
  const fallbackWebL2 = l2Types.find((type) => supportsBrowser(type.name));
  const fallbackShellL2 = l2Types.find((type) => supportsShellHarness(type.name));
  let changed = false;
  const subtasks = plan.subtasks.flatMap((subtask) => {
    const browser = taskRequiresRealBrowser(subtask.description);
    const commands = requiredPassingCommands(subtask.description);
    const webL2 = supportsBrowser(subtask.preferredChild)
      ? registry.getByName(subtask.preferredChild!)
      : fallbackWebL2;
    const shellL2 = supportsShellHarness(subtask.preferredChild)
      ? registry.getByName(subtask.preferredChild!)
      : fallbackShellL2;
    if (browser && commands.length > 0 && webL2 && shellL2) {
      changed = true;
      const sentences = subtask.description.split(/(?<=[.!?])\s+(?=[A-Z])/);
      const browserSentences = sentences.filter((sentence) =>
        /\b(?:browser|selector-based|window\.__test|console(?:\.error|\s+errors?)|failed requests?|UI probe)\b/i.test(
          sentence
        )
      );
      const shellSentences = sentences.filter((sentence) =>
        /\b(?:test|harness|shell|probe-manifest|probe manifest|recorded probes?|README)\b/i.test(
          sentence
        ) && !taskRequiresRealBrowser(sentence)
      );
      return [
        {
          ...subtask,
          description:
            `BROWSER VERIFICATION ONLY — use a real browser and do not substitute a Node/static-source harness. ` +
            `${browserSentences.join(' ') || subtask.description}`,
          preferredChild: webL2.name,
        },
        {
          ...subtask,
          description:
            `FINAL SHELL/HARNESS VERIFICATION ONLY — run the exact required command(s) ` +
            `${commands.join(', ')} and require exit code 0; do not substitute another harness. ` +
            `${shellSentences.join(' ') || subtask.description}`,
          preferredChild: shellL2.name,
        },
      ];
    }
    if (browser && webL2 && !supportsBrowser(subtask.preferredChild)) {
      changed = true;
      return [{ ...subtask, preferredChild: webL2.name }];
    }
    return [subtask];
  });
  // Routing does not own dispatch topology. In particular an explicit concat
  // or llm-synthesize plan represents orthogonal checkpoints and must not be
  // silently serialized merely because one checkpoint changed bucket.
  return changed ? { ...plan, subtasks } : plan;
}

export class L3Atom extends Atom implements Supervisor<L2Atom> {
  readonly tier: Tier = 3;
  readonly model: string;
  readonly validationModel: string;

  private registry: AtomRegistry;
  private pendingStrategy: L3Strategy | null = null;
  private l2Peers: L2Atom[] = [];
  private triedChildren = new TaskChildrenMemo();
  /** SkillRegistry threaded down to every L2 instance L3 creates. */
  readonly skillRegistry: SkillRegistry | null;

  private constructor(args: {
    atomId?: string;
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly Tool[];
    params: GenerationParams;
    registry: AtomRegistry;
    model: string;
    validationModel?: string;
    skillRegistry?: SkillRegistry | null;
  }) {
    super({
      atomId: args.atomId,
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model;
    this.validationModel = args.validationModel ?? modelForTier(1);
    this.registry = args.registry;
    this.skillRegistry = args.skillRegistry ?? null;
  }

  static async fromType(
    type: AtomType,
    registry: AtomRegistry,
    client?: ModelListingClient,
    skillRegistry: SkillRegistry | null = null
  ): Promise<L3Atom> {
    if (type.tier !== 3) throw new Error(`L3Atom.fromType requires tier=3`);
    // An explicit ATOMA_MODEL_L3 pins the tier and SKIPS the network
    // resolution — provider-agnostic override beats live Opus discovery.
    const pinned = modelForTier(3);
    const model = pinned !== FALLBACK_OPUS ? pinned : client ? await resolveLatestOpus(client) : FALLBACK_OPUS;
    return new L3Atom({
      atomId: type.atomId,
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      model,
      skillRegistry,
    });
  }

  /** Test/manual constructor bypassing model discovery. */
  static buildWithModel(
    type: AtomType,
    registry: AtomRegistry,
    model: string = modelForTier(3),
    skillRegistry: SkillRegistry | null = null
  ): L3Atom {
    if (type.tier !== 3) throw new Error(`L3Atom.buildWithModel requires tier=3`);
    return new L3Atom({
      atomId: type.atomId,
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      model,
      skillRegistry,
    });
  }

  /** Public entry: run the full supervised flow. */
  async handle(task: Task, ctx: RunContext): Promise<Result> {
    // No parent validator sits above this plan. `acceptL3RootPlan` is the
    // one-shot collision check — see that module, not a second superviseLoop.
    const plan = await acceptL3RootPlan({
      plan: await this.plan(task, ctx),
      task,
      ctx,
      replan: (next) => this.plan(next, ctx),
    });
    ctx.recordRootPlan?.(plan);
    return this.execute(task, plan, ctx);
  }

  async plan(task: Task, ctx: RunContext): Promise<Plan> {
    if (this.isFallbackMode()) return this.selfPlan(task, ctx);

    this.triedChildren.beginTask(task.description);
    const catalog = this.registry.listByTier(2);

    // L3 NEVER short-circuits the prefilter into a skeletal plan.
    // The framework's value at the top tier is decomposition reasoning
    // — collapsing that to a 1-subtask routing decision wastes the
    // tier. The prefilter still runs (cheap Haiku call) and survives
    // as a routing HINT injected into the Opus plan; it can no longer
    // bypass Opus entirely. See L2.plan for the symmetric "decomposable"
    // flag — at L2 the hint is paired with a happy-path shortcut, but
    // L2's role is leaf-routing (one L1) where short-circuiting makes
    // sense. L3's role is task-shaping; it has to think every time.
    // Cost: ~+$0.10/run vs the previous shortcut, deliberately accepted.
    let prefilterHint: { target: string; reasoning: string } | null = null;
    if (catalog.length > 0) {
      // L1-affinity enrichment: for each L2 in the catalog, append a
      // short summary of the L1 children it would dispatch to. Without
      // this, L3.prefilter saw only the L2's own description — a
      // file-authoring task ("Node lib + README.md + package.json")
      // produced an "escalate" because no L2 description mentioned
      // file-scribe capability, triggering a full Opus plan ($0.12/run)
      // just to conclude "route to Methane, it dispatches to the
      // file-scribe L1 anyway". Now Haiku sees the L1 affinity directly
      // on the L2 catalog entry and can high-confidence pick.
      //
      // L1-children heuristic: a L2 "dispatches to" every canonical L1
      // (reachable via prefilter at the L2 tier) + any L1 it has
      // dynamically created (createdBy === L2.name). Kept deliberately
      // cheap — just a name + clipped description hint per child, no
      // tool lists or metadata.
      const allL1s = this.registry.listByTier(1);
      const canonicalMarkers = new Set([
        'bootstrap-canonical',
        'bootstrap-canonical-http',
        'bootstrap-canonical-filescribe',
      ]);
      const l1Affinity = (l2Name: string): typeof allL1s =>
        allL1s.filter(
          (l1) => canonicalMarkers.has(l1.createdBy) || l1.createdBy === l2Name
        );
      const prefilterCatalog = catalog.map((t) => {
        const base = stripBranchProvenance(t.description);
        const children = l1Affinity(t.name);
        if (children.length === 0) return { name: t.name, description: base };
        // Format the L1-affinity hint on its own line(s) with an
        // explicit "REACHABLE L1 CHILDREN" preamble, not a parenthetical
        // tail on the L2 description. Earlier attempts used
        // "(dispatches leaves to: …)" but Haiku kept parsing it as
        // flavour text and escalating on "L2 description seems narrow"
        // reasoning. A clearly-delimited block is harder to ignore.
        const childLines = children
          .map(
            (c) =>
              `      - ${c.name}: ${stripBranchProvenance(c.description).slice(0, 120)}`
          )
          .join('\n');
        return {
          name: t.name,
          description: `${base}\n    REACHABLE L1 CHILDREN (this L2 can dispatch any leaf task to any of these):\n${childLines}`,
        };
      });
      const prefilter = await prefilterStrategy({
        ctx,
        task,
        catalog: prefilterCatalog,
        exclude: this.triedChildren.excluded(),
        actor: { name: this.name, tier: 3 },
      });
      if (prefilter && prefilter.kind === 'reuse') {
        // No more short-circuit: regardless of `decomposable`, hand the
        // target to Opus as a routing hint and let the full plan call
        // decide the actual shape (single-subtask or multi-subtask).
        prefilterHint = { target: prefilter.target, reasoning: prefilter.reasoning };
        ctx.logger.debug(
          `[${this.name}] prefilter picked L2 ${prefilter.target} as routing hint — deferring to Opus plan`,
          { reasoning: prefilter.reasoning }
        );
      }
    }
    const toolCatalog =
      this.tools.length === 0
        ? '(no tools — children will work with prompts only)'
        : this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');
    const userContent = [
      `You are tissue "${this.name}" (tier 3 / tissue).`,
      ``,
      `HARD RULE: You NEVER execute tools yourself; those tools are elements. You do NOT write files, run`,
      `shells, start servers, or validate anything. Your ONLY job is strategic:`,
      `DECOMPOSE the task into subtasks and route each to an L2 cell.`,
      `The L2 cells will in turn decompose their own work into L1 molecule tasks —`,
      `L1 molecules are the only agent rank allowed to invoke elements. Keep your reasoning short and`,
      `your plan high-level.`,
      ``,
      `== DECOMPOSITION DISCIPLINE — pick ONE shape ==`,
      `For non-trivial tasks emit 2-5 subtasks. Pick the shape that matches`,
      `the task's natural structure:`,
      ``,
      `  ORTHOGONAL (parallel) — subtasks are INDEPENDENT, no shared state.`,
      `    Each runs in its own workspace lane and produces a separate`,
      `    artefact. Aggregation is "concat" or "llm-synthesize".`,
      `    Examples: "build three unrelated CLI tools, one per subdirectory";`,
      `    "research topic A" + "research topic B" (only when neither reads`,
      `    the other's output).`,
      `    A step that CONSUMES the others NEVER belongs here: parallel lanes`,
      `    cannot see each other's results, so "summarise all three" is a`,
      `    later PHASED step, not a fourth orthogonal subtask.`,
      ``,
      `  PHASED (sequential) — subtasks SHARE the same evolving artefact.`,
      `    Step N starts from where step N-1 left off (same workspace files).`,
      `    Each step receives a "previousStepSummary" automatically in its`,
      `    inputs. Aggregation is "sequential" — the FINAL phase carries`,
      `    the deliverable. No extra LLM call for aggregation.`,
      `    Examples: build apps and games (scaffold → wire input/logic →`,
      `    smoke-test); refactors (rewrite module → migrate callers →`,
      `    delete old module); pipelines (fetch data → transform → load).`,
      `    Use this whenever phases need to verify each other's work or`,
      `    when the artefact MUST go through review checkpoints.`,
      ``,
      // ONE PHASE PER ORTHOGONAL GROUP, not one phase per artefact. A plan
      // carries a SINGLE aggregation mode, so "3 independent parts, then a
      // step consuming all 3" has no direct spelling at this tier: the only
      // correct mode is "sequential", and the parallelism has to come from
      // the L2 that receives one grouped phase and fans it out itself.
      // Measured 2026-08-16 (docs/incidents/parallel-fanin-2026-08-16.md):
      // on three fan-out+join tasks, the ONE run that grouped its orthogonal
      // work into a single phase is the only live run in this repo's history
      // — 247 traces — whose lanes ever genuinely overlapped. The two runs
      // that emitted one phase per orthogonal artefact serialised work that
      // shared no file. Both L3 plans had correctly IDENTIFIED the
      // orthogonality in their own reasoning first; granularity, not
      // recognition, is what decided the outcome.
      `  ONE PHASE CAN CARRY A WHOLE ORTHOGONAL GROUP — and should. When N`,
      `  artefacts share nothing but a later step consumes them all, emit ONE`,
      `  phase naming all N ("create the three independent generators, each in`,
      `  its own subdirectory") followed by the phases that depend on them.`,
      `  The L2 receiving that phase splits the group into parallel lanes by`,
      `  itself; one phase PER orthogonal artefact throws that away and`,
      `  serialises work that had no reason to be serial. Group only artefacts`,
      `  that genuinely share no file, and name every one of them in the phase`,
      `  description so the L2 can tell them apart.`,
      ``,
      `When in doubt for an APP / GAME / FILE-BUILD task: prefer PHASED, with`,
      `each orthogonal group kept inside ONE phase rather than spread across`,
      `consecutive ones.`,
      `One big monolithic subtask delegates real reasoning to the L2 prompt`,
      `and skips the value of phase-by-phase smoke validation.`,
      ``,
      `== VERIFICATION MATCHES THE ARTEFACT ==`,
      `Every phase that verifies work MUST use the probe matching the`,
      `deliverable's NATURE — never default to the web pattern:`,
      `  - browser-rendered artefact (index.html page, canvas game, UI):`,
      `    start_static_server + validate_html smoke. A separate final`,
      `    validation phase is the norm here.`,
      `  - HTTP server / API: start_node_server + fetch_url probes against`,
      `    the endpoints. No browser, no validate_html.`,
      HTTP_PORTABLE_DOC_GUIDANCE,
      `  - CLI tool / scripts / config / docs: run_shell executing the`,
      `    artefact (node index.js, npm start) and checking stdout / exit`,
      `    code; read files back for docs. NO static server, NO`,
      `    validate_html, NO index.html — there is nothing to render.`,
      `Emitting a serve+validate_html phase for a non-browser artefact is`,
      `a PLAN DEFECT: the worker will fabricate an index.html just to have`,
      `something to serve and burn its tool budget on a browser loop that`,
      `proves nothing (observed: a Node CLI build given a "serve and`,
      `validate" phase 2 — 9 failed server boots and a parasitic`,
      `index.html). For non-browser artefacts, verification usually`,
      `belongs INSIDE the build phase itself (the builder runs the shell`,
      `probe right after writing the files); add a separate verification`,
      `phase only when it needs different expertise or tooling than the`,
      `build.`,
      `FULL-STACK CROSS-BUCKET RULE: a real-browser UI check and a finite`,
      `Node/API harness do NOT belong in one subtask. Emit two sequential`,
      `phases: browser/selector/window.__test verification to the web L2, then`,
      `the exact node test/probe command to the HTTP L2. Never route real`,
      `browser work to an HTTP-only child or replace it with source inspection.`,
      `Tool families above pick the verification NATURE — but write the`,
      `SUBTASK DESCRIPTIONS as OUTCOMES ("boot the app's server on an`,
      `OS-assigned port and probe every route over HTTP"), not as tool`,
      `invocations: the plan cannot know the final routing, and a`,
      `description hard-naming a tool binds a child that may not declare it`,
      `(measured: "boot with start_node_server" written into a phase that`,
      `routed to the file-authoring bucket — the child's plans echoed the`,
      `name, tripped the toolset pre-check repeatedly, and escalated a`,
      `healthy run into a 5x-cost cascade). Children know their own tools.`,
      `When a phase records or replays the probe manifest`,
      `(.atoma-probes.json), say WHAT to record — never SPELL OUT field`,
      `names or an entry schema in the subtask text. The workers carry the`,
      `canonical manifest contract in their own prompts; a plan-invented`,
      `schema (e.g. "command"/"expectExitCode") conflicts with it and the`,
      `validator then whipsaws the worker between the two shapes (observed:`,
      `five rejection cycles on one run, alternating demands between the`,
      `phantom schema and the real one).`,
      // A DOCUMENTATION PHASE DOCUMENTS EVIDENCE THAT ALREADY EXISTS. Measured
      // 2026-08-16 across two consecutive batches on the same task
      // (docs/incidents/parallel-fanin-2026-08-16.md): a phase told to "re-run
      // each command to capture its actual output if needed, and make sure all
      // three out.json files still exist at the end" spent ONE 567s execute
      // loop re-running every generator, staging the failure case by moving an
      // output file aside, restoring it, re-reading every source, and writing
      // the README only at 741s — then kept verifying until the run budget
      // died. Its sibling phases, which pointed at recorded evidence instead,
      // cost 46-51s. The restated invariant is what turns a writer into a
      // re-verifier: it makes the phase responsible for state it never
      // touched, so it proves that state from scratch.
      `A phase whose deliverable is DOCUMENTATION reports evidence that`,
      `already exists: point it at the recorded probes and let it re-run`,
      `only what is not recorded yet. Do NOT hand it re-verification duties`,
      `or workspace invariants to uphold ("make sure X still exists",`,
      `"re-run each command to capture its output"). A documentation phase`,
      `asked to re-establish state stages destructive experiments to`,
      `reproduce error cases it could have read, and can burn the whole run`,
      `budget doing it.`,
      // NOT "error cases belong to the build phase": that sentence was here for
      // one run and made things worse. It relocated the destructive experiment
      // instead of removing it — the build phase then had to MANUFACTURE the
      // failure state, and for a writer whose only error path is "cannot write
      // its output" that means deleting its own output. Measured on the
      // 2026-08-17 05:21 run: four `rm` attempts, all correctly refused by the
      // shell allowlist, one refused hand-edit of the probe manifest, and the
      // build phase went 103s → 506s at 5x the whole-run cost while the
      // documentation phase it was meant to relieve fell 598s → 117s. Where an
      // error case runs is the plan's business; what matters is that NO phase
      // is pushed into staging one destructively.
      `An error path that can only be evidenced by destroying state is not`,
      `worth a phase of either kind — prefer the artefact's non-destructive`,
      `failure inputs (a missing argument, a path that does not exist).`,
      ``,
      MUTATING_SUBTASK_FILE_GUIDANCE,
      ``,
      PROOF_OBLIGATION_GUIDANCE,
      ``,
      LITERAL_CONTRACT_PRESERVATION_GUIDANCE,
      ``,
      `Each subtask carries a "preferredChild" naming the L2 cell that`,
      `should handle it (required for N>1 plans). Multiple phases can target`,
      `the SAME L2 — that's the common case for PHASED builds.`,
      ``,
      `Single-subtask plans are reserved for GENUINELY indivisible tasks`,
      `(e.g. "look up the current time", "write a one-line config file"). For`,
      `apps, libraries, builds, multi-step procedures: ALWAYS emit ≥2 subtasks.`,
      ``,
      `== AGGREGATION ==`,
      `Pick how the sub-results combine — must match decomposition shape:`,
      `  - "concat": mechanical array join (no extra LLM call). For ORTHOGONAL.`,
      `  - "llm-synthesize": one more call to merge sub-results into a unified`,
      `    deliverable (provide an "instruction" string). For ORTHOGONAL when`,
      `    sub-results need synthesis.`,
      `  - "sequential": phases run one-at-a-time on a shared workspace; final`,
      `    phase's output is the deliverable. For PHASED.`,
      `Parallel phases MUST declare disjoint "outputs". Shared paths mean the`,
      `work is PHASED — use sequential. Omit "outputs" only on read-only phases.`,
      ``,
      `== STRATEGY OPTIONS (baseline when a subtask lacks preferredChild) ==`,
      `  - "reuse": pick an existing L2 cell from the catalog that fits`,
      `  - "create": design a new L2 cell and register it (provide a seed)`,
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
      // Prefilter hint — never a hard route, just a strong default.
      // L3 always runs this Opus plan; the prefilter just narrows the
      // candidate space so Opus doesn't waste tokens re-discovering
      // which L2 fits the task domain.
      prefilterHint
        ? [
            `== PREFILTER HINT ==`,
            `A lightweight prefilter identified "${prefilterHint.target}" as the most likely`,
            `reusable L2 for this task (${prefilterHint.reasoning}). Prefer setting`,
            `"preferredChild": "${prefilterHint.target}" on each subtask that aligns with that`,
            `L2's capability, unless a subtask genuinely needs a different orchestrator.`,
            ``,
          ].join('\n')
        : '',
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
      `  {"reasoning": "...", "subtasks": [{"description": "...", "preferredChild": "<L2-name>"?, "inputs": {}?, "outputs": ["<file the subtask creates/modifies>", ...]}, ...], "aggregation": {"mode": "concat"|"llm-synthesize"|"sequential", "instruction": "..."?}, "expectedOutput": "..."}`,
      `]`,
      `Every file-mutating subtask MUST include "outputs". Omit the key only on read-only phases.`,
      `The first character of your response MUST be "[". Do NOT call any tools.`,
    ]
      .filter(Boolean)
      .join('\n');

    // L3 is a pure reasoning / routing tier: no executor and no tool declarations
    // are passed to the LLM. Only L1 may actually execute tools. Cap output at
    // STRATEGY_MAX_TOKENS — the response is routing JSON, not content.
    const resp = await ctx.llm.complete(
      this.toLlmRequest('plan', {
        userContent,
        params: { ...this.params, maxTokens: STRATEGY_MAX_TOKENS, effort: 'medium' },
        signal: ctx.signal,
      })
    );

    const pair = parseTwoJson(resp.text);
    const strategy = l3StrategySchema.parse(pair[0]);
    const plan = planSchema.parse(pair[1]);
    // TRUNCATION DEFAULT, L3 flavour. `planSchema` defaults a missing
    // `aggregation` to `concat` — the right degradation at L2 (concat is a
    // legitimate L2 mode; 19 observed) but the WRONG one here: at L3 every
    // analysable archived plan emitted `sequential` (83/83), and `concat`
    // routes the phases through `Promise.all` (`dispatch.ts`) over a SHARED
    // workspace while dropping the `previousStepSummary` threading. The
    // moment the field goes missing is a truncated response — precisely
    // when we know least — so the fallback must be the low-blast-radius
    // mode, not the high one. Read from the RAW pair, not the parsed plan:
    // after `parse` an omitted field is indistinguishable from an explicit
    // `"concat"`, which stays honoured.
    const rawPlan = pair[1];
    const aggregationWasOmitted =
      typeof rawPlan === 'object' &&
      rawPlan !== null &&
      (rawPlan as Record<string, unknown>)['aggregation'] === undefined;
    if (aggregationWasOmitted) plan.aggregation = { mode: 'sequential' };
    const routed = preservePlanLiteralContracts(
      routeCrossBucketVerification(plan, this.registry),
      task.description
    );
    // Committed LAST, only once the plan this strategy belongs to is fully
    // validated. `acceptL3RootPlan`'s coached replan is fail-open: if a
    // replan died AFTER writing its strategy but before its plan parsed, the
    // ORIGINAL plan was re-served while `execute()` consumed the REPLAN's
    // strategy — a reuse-shaped plan dispatched under a `create` seed built
    // for a different decomposition.
    this.pendingStrategy = strategy;
    return routed;
  }

  async execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    if (this.isFallbackMode()) return this.selfExecute(task, plan, ctx);

    const strategy = this.pendingStrategy;
    this.pendingStrategy = null;
    if (!strategy) return this.selfExecute(task, plan, ctx);

    const subtasks = plan.subtasks;
    const subResults = await this.dispatchSubtasks(subtasks, plan, strategy, task, ctx);
    return this.aggregate(subResults, plan.aggregation, task, ctx);
  }

  /**
   * Dispatch the subtasks of a plan according to its aggregation mode.
   *   - sequential: for-of with await; each step's summary and declared
   *     `outputs` are threaded into the next step's inputs so the next
   *     L2 sees what the previous one accomplished and which paths it
   *     named. The workspace filesystem is shared (same sandbox), so
   *     phases that mutate the same artefact (build → extend → smoke)
   *     get implicit state handover via disk; the threaded summary is
   *     the NARRATIVE state and `previousStepOutputs` is the structured
   *     path list.
   *   - concat / llm-synthesize: Promise.all (current behaviour).
   * The branch is in dispatch, not aggregate, because the dispatch
   * shape (parallel vs sequential) is what differs — the aggregate
   * call shape stays uniform (it gets an in-order array of Results).
   */
  /**
   * Plan-scoped aliases from a hallucinated/anticipated `preferredChild`
   * name to the L2 actually created for it. An Opus plan routinely names
   * ONE invented child (e.g. "Ethane") on SEVERAL subtasks; without the
   * alias each subtask's lookup missed independently and auto-created its
   * own clone. Observed on the first cold-start run: phases 1 and 2 both
   * asked for "Ethane" and the registry gained Ammonia AND CarbonDioxide —
   * two L2s with the identical capability label, born two minutes apart,
   * for one plan. Cleared at each dispatch; resolution happens in the
   * synchronous prefix of runSubtask, so the map is race-free even under
   * the parallel branch.
   */
  private readonly planChildAliases = new Map<string, string>();

  private async dispatchSubtasks(
    subtasks: readonly Plan['subtasks'][number][],
    plan: Plan,
    strategy: L3Strategy,
    task: Task,
    ctx: RunContext
  ): Promise<Result[]> {
    this.planChildAliases.clear();
    return dispatchWithAggregation(subtasks, plan, ctx, (subtask, idx) => {
      const hooks = this.makeL2Hooks(ctx, subtask.description);
      return this.runSubtask({
        subtask,
        strategy,
        parentTask: task,
        idx,
        total: subtasks.length,
        aggregationMode: plan.aggregation.mode,
        hooks,
        ctx,
      });
    });
  }

  private async runSubtask(args: {
    subtask: Plan['subtasks'][number];
    strategy: L3Strategy;
    parentTask: Task;
    idx: number;
    total: number;
    aggregationMode: Plan['aggregation']['mode'];
    hooks: SupervisionHooks<L2Atom>;
    ctx: RunContext;
  }): Promise<Result> {
    const {
      subtask,
      strategy,
      parentTask,
      idx,
      total,
      aggregationMode,
      hooks,
      ctx,
    } = args;
    const l2Type = this.resolveL2ForSubtask(subtask, strategy, parentTask, idx, ctx);
    this.triedChildren.mark(l2Type.name);
    const l2 = L2Atom.fromType(l2Type, this.registry, this.l2Peers, this.skillRegistry);
    for (const p of this.l2Peers) l2.addPeer(p);
    this.l2Peers.push(l2);
    const subTask: Task = {
      description: subtask.description,
      ...(subtask.inputs ? { inputs: subtask.inputs } : {}),
      // Structured output intent travels with the task: the skill dispatch
      // gates read it as authoritative instead of regex-recovering it.
      ...(subtask.outputs && subtask.outputs.length > 0 ? { outputs: subtask.outputs } : {}),
    };
    // Fork a branch-scoped ctx so the viz can render each L2 subtask
    // (and its downstream L1 tree) as its own lane.
    const branchId = randomUUID();
    const branchInfo = {
      branchId,
      ...(ctx.currentBranchId ? { parentBranchId: ctx.currentBranchId } : {}),
      index: idx,
      total,
      aggregationMode,
      label: subtask.description,
      actorName: this.name,
      actorTier: 3 as const,
    };
    ctx.recordBranch?.({ op: 'start', ...branchInfo });
    const branchCtx = forkBranch(ctx, branchId);
    try {
      return await superviseLoop<L2Atom>(this, l2, subTask, branchCtx, hooks);
    } finally {
      ctx.recordBranch?.({ op: 'end', ...branchInfo });
    }
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
      // A previous subtask of THIS plan already resolved the same invented
      // name — reuse its L2 instead of minting a same-labelled clone.
      const aliased = this.planChildAliases.get(subtask.preferredChild);
      if (aliased) {
        const type = this.registry.getByName(aliased);
        if (type && type.tier === 2) {
          ctx.logger.info(
            `[${this.name}] subtask #${idx} preferredChild "${subtask.preferredChild}" → reusing ${aliased} created earlier in this plan`
          );
          return type;
        }
      }
      // Planner hallucination (same failure mode as in L2.resolveL1ForSubtask):
      // fallback to auto-creation instead of crashing the whole fan-out.
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} preferredChild "${subtask.preferredChild}" not in registry — auto-creating a fresh L2`
      );
      const created = this.createSubtaskL2(subtask, strategy, parentTask);
      this.planChildAliases.set(subtask.preferredChild, created.name);
      return created;
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
      strategy.seed ?? ({ tools: [], params: {} });
    const mergedTools = mergeTools(this.tools, (seed.tools ?? []));
    // Registry description is a CAPABILITY label, not a task narrative —
    // see `src/atoms/capability.ts` for why. Same motivation as
    // `L2Atom.createSubtaskL1`: prevent per-task L2 singletons from
    // poisoning L3's prefilter catalog.
    return this.registry.create(2, {
      description: resolveCreationDescription(seed.description, mergedTools, 2),
      systemPrompt:
        seed.systemPrompt ??
        [
          `You are an L2 cell created by ${this.name}.`,
          `Decompose sub-tasks into L1 molecules and supervise them.`,
          `Subtask you were handed: ${subtask.description}`,
          `Parent task (for context only): ${parentTask.description}`,
        ].join('\n'),
      tools: mergedTools,
      params: (seed.params ?? this.params),
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
          const fresh = L2Atom.fromType(patched, this.registry, this.l2Peers, this.skillRegistry);
          return fresh;
        }
        const branched = this.registry.branch(
          child.name,
          verdict.modifications,
          this.name,
          verdict.branchName
        );
        ctx.logger.info(`[${this.name}] branched L2 ${child.name} → ${branched.name}`);
        const fresh = L2Atom.fromType(branched, this.registry, this.l2Peers, this.skillRegistry);
        this.l2Peers.push(fresh);
        return fresh;
      },
      branchOnEscalation: async (child, trace, reason) => {
        // Reset the L2's system prompt so it's aligned with THIS subtask's
        // domain rather than inherited from the parent that failed.
        // BUCKET-AWARE: buildNarrowL2Prompt reads childTools so the
        // narrow prompt's closing hint matches the downstream bucket
        // (fix #8b). DIAGNOSTIC INJECTION: pass the extracted
        // validator rejection reasonings into the narrow prompt so
        // the branched L2 can target the specific failure (#1).
        const childType = this.registry.getByName(child.name);
        const childTools = childType?.tools ?? [];
        const diagnostic = extractBranchDiagnostic(trace);
        const narrowPrompt = buildNarrowL2Prompt(
          subtaskDescription,
          childTools,
          diagnostic
        );
        // Capability-first description — match the rule enforced in
        // createSubtaskL2. The task narrative lives in narrowPrompt
        // (systemPromptReplace); the registry must stay tier/tool-
        // scoped so prefilter cross-domain reuse stays clean.
        // Atom.tools is protected — pull the tool signature via the
        // registry, which is the authoritative source anyway.
        const narrowDesc = resolveCreationDescription(undefined, childTools, 2);
        const branched = this.registry.branch(
          child.name,
          {
            systemPromptReplace: narrowPrompt,
            descriptionReplace: narrowDesc,
            additionalContext:
              `Branched after escalation. Prior L2 flow failed because the inherited prompt was` +
              ` misaligned with this subtask.` +
              (diagnostic.length > 0
                ? `\nVALIDATOR DIAGNOSIS (injected into the new system prompt too):\n${diagnostic}`
                : ''),
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
        return L2Atom.fromType(branched, this.registry, [], this.skillRegistry);
      },
      onApproved: async (child, _result) => {
        this.registry.recordSuccess(child.name, this.name);
      },
      onFailed: async (child, _reason) => {
        this.registry.recordFailure(child.name, this.name);
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
    const evidence = subResults.flatMap((result) => result.evidence ?? []);
    const evidenceField = evidence.length > 0 ? { evidence } : {};
    if (aggregation.mode === 'sequential') {
      // For phased pipelines, the FINAL phase's result is the deliverable.
      // The earlier phases produced intermediate state on disk that the
      // final phase consumed and validated. We keep their summaries in
      // the wrapper summary so the trace stays auditable.
      const last = subResults[subResults.length - 1]!;
      const phaseSummaries = subResults
        .map((r, i) => `phase #${i + 1} (${r.producedBy.name}): ${r.summary}`)
        .join(' | ');
      return {
        output: last.output,
        summary: `${subResults.length} sequential phases — final: ${last.summary}. Trace: ${phaseSummaries}`,
        trace: [],
        producedBy: { tier: 3, name: this.name, viaFallback: false },
        ...evidenceField,
      };
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
        ...evidenceField,
      };
    }
    const userContent = [
      `You are tissue "${this.name}" (tier 3). Synthesise a single result from ${subResults.length} sub-results.`,
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
    const resp = await ctx.llm.complete(
      this.toLlmRequest('execute', {
        userContent,
        params: this.params,
        signal: ctx.signal,
      })
    );
    const { output, summary } = parsePayloadTolerant(resp.text);
    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 3, name: this.name, viaFallback: false },
      ...evidenceField,
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
      `You are tissue "${this.name}" (tier 3) in FALLBACK: do the task yourself, no delegation.`,
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
    const resp = await ctx.llm.complete(
      this.toLlmRequest('fallback-plan', {
        userContent,
        params: this.params,
        signal: ctx.signal,
      })
    );
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
      `You are tissue "${this.name}" (tier 3) in FALLBACK: L2/L1 supervision failed, you are now the executor.`,
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
    const resp = await ctx.llm.complete(
      this.toLlmRequest('fallback-execute', {
        // A tool-bearing last resort still needs the sandboxed L1 transport.
        // Tier-3 Codex can plan this fallback but cannot safely execute tools.
        model: hasTools ? modelForTier(1) : this.model,
        userContent,
        ...(hasTools ? { tools: [...this.tools], executor: ctx.tools } : {}),
        params: this.params,
        signal: ctx.signal,
        maxToolIterations: capToolIterations(hasValidator ? 40 : 24, ctx.deadlineAt),
      })
    );
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
    // Prefilter fast-path — see L2Atom.validatePlan for full rationale.
    // Same decision, one tier up: a viaPrefilter plan is Haiku's own
    // capability-match short-circuit, not a Sonnet/Opus strategy, and
    // a second Haiku pass on it is redundant signal that was observed
    // in production to reject freshly-bootstrapped canonicals.
    if (plan.viaPrefilter) {
      return {
        approved: true,
        reasoning: `prefilter fast-path: plan was synthesised by Haiku's capability-match decision on child "${child.name}", no separate validator pass needed`,
      };
    }
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
    // Mirror of L2.validateResult: the trust fast-path skips the LLM
    // validator but NOT the ground-truth probe — it costs no tokens, and a
    // trusted type is exactly the one nobody watches any more. A contradiction
    // or mechanically broken evidence interface hands the decision to the LLM
    // validator (with the block passed along so the probe doesn't run twice),
    // never to an outright reject.
    const payload = { output: result.output, summary: result.summary };
    let trustedProbe: GroundTruthCheck | null = null;
    if (type && shouldTrustType(type)) {
      trustedProbe = await checkGroundTruth({
        ctx,
        subject: 'RESULT',
        payload,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        child,
      });
      if (!trustedProbe.requiresReview) {
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
      const reviewReason = trustedProbe.contradiction
        ? 'ground-truth evidence contradicts the RESULT'
        : 'the probe manifest is malformed';
      ctx.logger.warn(
        `[${this.name}] trust fast-path OVERRIDDEN for ${child.name} (${type.successes}✓/${type.failures}✗): ${reviewReason} — falling through to a full verdict`
      );
    }
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 3,
      subject: 'RESULT',
      child,
      task,
      payload,
      ...(result.evidence ? { evidence: result.evidence } : {}),
      ...(trustedProbe ? { groundTruthBlock: trustedProbe.block } : {}),
    });
  }
}
