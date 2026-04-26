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
import {
  bucketIdForTools,
  CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES,
  extractBranchDiagnostic,
  resolveCreationDescription,
} from './capability.js';
import type { Skill } from '../skills/types.js';
import type { SkillRegistry } from '../skills/registry.js';

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

/** Kebab-case id check (lowercase letters, digits, single dashes). */
export function isSafeSkillId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length >= 3 && id.length <= 60;
}

/**
 * Parse a Sonnet skill-draft response. The model is instructed to
 * emit ONE JSON object; we tolerate prose-with-fenced-json the
 * same way `extractJson` does for plan parsing. Returns null for
 * unparseable / structurally-incomplete drafts so the caller can
 * skip silently — auto-creation is best-effort.
 *
 * Accepts both `when_to_use` (snake-case, what the prompt asks for)
 * and `whenToUse` (camelCase, in case the model normalises) so a
 * minor naming drift does not throw away the draft.
 */
export function parseSkillDraft(text: string): {
  id: string;
  description: string;
  whenToUse: string;
  body: string;
} | null {
  if (!text || text.trim().length === 0) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof obj['id'] === 'string' ? (obj['id'] as string).trim() : null;
  const description =
    typeof obj['description'] === 'string' ? (obj['description'] as string).trim() : null;
  const whenToUseRaw =
    typeof obj['when_to_use'] === 'string'
      ? (obj['when_to_use'] as string)
      : typeof obj['whenToUse'] === 'string'
        ? (obj['whenToUse'] as string)
        : null;
  const whenToUse = whenToUseRaw ? whenToUseRaw.trim() : null;
  const body = typeof obj['body'] === 'string' ? (obj['body'] as string).trim() : null;
  if (!id || !description || !whenToUse || !body) return null;
  return { id, description, whenToUse, body };
}

/**
 * Render a skill body as a context block injected into the L1's
 * effective system prompt. Branch on kind:
 *
 *   - `kind: 'llm'` (default): the body is a recipe of natural-
 *     language steps; the L1 follows them with its normal tool-use
 *     loop. Same shape we've shipped since C2a.
 *
 *   - `kind: 'script'`: the body IS executable code in `language`.
 *     The injected block instructs the L1 to write_file the body
 *     verbatim to a sandbox-local `_skill_<id>.<ext>`, run it via
 *     `run_shell <interpreter> <file> [args...]`, capture stdout,
 *     and return that as its result. Single LLM call + 2 tool
 *     calls regardless of script length — strictly cheaper than
 *     an LLM-driven recipe on tasks whose deliverable is fully
 *     deterministic.
 *
 * The clear delimiters help the model parse "this is a recipe to
 * follow" vs the rest of its prompt, and they also make traces
 * easier to grep when debugging which skill was active on a given
 * run.
 */
export function skillContextBlock(skill: {
  id: string;
  body: string;
  kind?: 'llm' | 'script';
  language?: 'node' | 'python' | 'bash';
}): string {
  if (skill.kind === 'script') {
    if (!skill.language) {
      throw new Error(`skillContextBlock: kind:"script" requires language`);
    }
    const ext = scriptExtension(skill.language);
    const interpreter = skill.language === 'python' ? 'python3' : skill.language;
    const filename = `_skill_${skill.id}.${ext}`;
    return [
      `== ACTIVE SKILL: ${skill.id} (kind: script, language: ${skill.language}) ==`,
      `This skill ships an EXECUTABLE script (below). Your task is NOT to`,
      `interpret the script — it is to RUN IT. Concretely:`,
      ``,
      `  1. Extract the script's CLI arguments from the current subtask`,
      `     description (the script's source documents what it expects).`,
      `  2. write_file ${filename} with the script body VERBATIM (do not`,
      `     edit, summarise, or paraphrase — the body is canonical).`,
      `  3. run_shell { command: "${interpreter}", args: ["${filename}", ...your-args] }`,
      `  4. Read the run_shell result. Stdout is your deliverable; stderr`,
      `     surfaces error messages if the script throws.`,
      `  5. Return JSON {"output": <stdout-summary>, "summary": "<one sentence>"}.`,
      ``,
      `Do NOT improvise additional tool calls. The script body is canonical;`,
      `your role is to wire CLI args into it and return its output.`,
      ``,
      `== SCRIPT BODY ==`,
      skill.body.trim(),
      ``,
      `== END ACTIVE SKILL ==`,
    ].join('\n');
  }
  return [
    `== ACTIVE SKILL: ${skill.id} ==`,
    `Follow this recipe step-by-step for the current subtask. The recipe was`,
    `learned from prior successful runs and is the FASTEST path to a clean`,
    `result. Deviate only when the subtask explicitly asks for something the`,
    `recipe does not cover.`,
    ``,
    skill.body.trim(),
    ``,
    `== END ACTIVE SKILL ==`,
  ].join('\n');
}

function scriptExtension(language: 'node' | 'python' | 'bash'): string {
  if (language === 'node') return 'js';
  if (language === 'python') return 'py';
  return 'sh';
}

/**
 * Fresh narrow-responsibility system prompt used when `branchOnEscalation`
 * spawns a new L1 after the parent type couldn't solve a task. The parent
 * is kept intact; the NEW branch gets this prompt written fresh so it
 * doesn't carry forward any domain bias (e.g. "You are Nitrogen, a WebGL
 * platformer builder" bleeding into a dashboard task). The branched
 * atom's rebrandPersona pass at `registry.branch` time will then swap in
 * the branch's actual taxonomy name on the "You are {Name}" line.
 *
 * BUCKET-AWARE: the tool-sequence body is keyed on the child's tool
 * signature. A branch of an HTTP L1 (start_node_server + fetch_url) no
 * longer gets the web/validate_html flow + SMOKE_DESIGN_GUIDANCE —
 * because the guidance taught the model to REACH FOR validate_html as
 * a "smoke primitive" even when the atom's declared tools didn't
 * include it, then the executor happily ran it (observed in the
 * Node/REST run: Helium-branch atoms calling validate_html against a
 * JSON API, result rejection, cascade of escalations). The branch of
 * an HTTP atom now gets the HTTP canonical sequence; the branch of a
 * web atom still gets the validate_html loop + smoke guidance; an
 * unknown-bucket branch falls back to a domain-neutral tools-only
 * template.
 */
export function buildNarrowL1Prompt(
  subtaskDescription: string,
  childTools: readonly Tool[] = [],
  diagnostic: string = ''
): string {
  const header: string[] = [
    `You are an L1 element builder with ONE narrow responsibility.`,
    `Your current subtask: ${subtaskDescription}`,
    ``,
    `Do NOT import assumptions from other domains — the parent type you`,
    `were branched from may have been narrowly specialised for a`,
    `different problem (platformer, minesweeper, HTTP API, etc.);`,
    `IGNORE its domain and focus SOLELY on this subtask as stated.`,
    ``,
  ];
  // Diagnostic injection (#1): when the supervise loop passes us the
  // parent's trace, surface the validator's last rejection reasoning(s)
  // verbatim so the branched L1 knows the CONCRETE fix it has to land
  // (e.g. "GROUND-TRUTH EVIDENCE: validate_html reported 404 on URL"),
  // rather than retrying the whole deliverable from scratch.
  if (diagnostic.length > 0) {
    header.push(`== PRIOR ATTEMPT DIAGNOSIS (act on this, do NOT ignore) ==`);
    header.push(diagnostic);
    header.push(``);
    header.push(
      `Your first move should diagnose and fix the exact issue cited above.`
    );
    header.push(
      `Do NOT rewrite the entire deliverable until you have verified the root`
    );
    header.push(`cause of that specific failure.`);
    header.push(``);
  }

  const bucket = bucketIdForTools(childTools);
  let bucketBody: string[];
  if (bucket === 'http-server-build+probe') {
    // HTTP sequence + LISTENING_ON_PORT contract, mirror of the
    // canonical HTTP L1 prompt (single source of truth).
    bucketBody = [...CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES];
  } else if (bucket === 'web-artefact-build+validate') {
    bucketBody = [
      `Call tools sequentially to produce the deliverable:`,
      `  1. write_file the complete source`,
      `  2. start_static_server to serve it (port 0 = OS-assigned is fine)`,
      `  3. validate_html on the returned URL with appropriate interactions`,
      `     and a smoke check that asserts the key state transitions`,
      `  4. if validation fails: read_file, diagnose, write_file with the`,
      `     fix, re-validate. Up to 4 iterations.`,
      `  5. return JSON {"output": <url or summary>, "summary": "<one sentence>"}`,
      ``,
      SMOKE_DESIGN_GUIDANCE,
    ];
  } else {
    // Unknown bucket — keep a generic tools-only template. DO NOT append
    // SMOKE_DESIGN_GUIDANCE here: the smoke discipline is web-bucket
    // specific and leaking it teaches the model to invoke validate_html
    // even when the atom's declared tools don't include it.
    bucketBody = [
      `Call tools sequentially to produce the deliverable. Use ONLY the`,
      `tools you were handed — do NOT invoke anything that isn't in your`,
      `declared tool list. Return JSON {"output": <...>, "summary": "<...>"}`,
      `once the work is done.`,
    ];
  }

  return [...header, ...bucketBody].join('\n');
}

export class L2Atom extends Atom implements Supervisor<L1Atom>, Peerable<L2Atom> {
  readonly tier: Tier = 2;
  readonly model: string;
  readonly validationModel: string;
  readonly peers: L2Atom[] = [];

  private registry: AtomRegistry;
  private pendingStrategy: L2Strategy | null = null;
  private triedChildren = new TaskChildrenMemo();
  /**
   * Optional skill store — when present, every runSubtask runs a
   * skill-prefilter against the resolved L1's skills before entering
   * the supervise loop. The L1's effective system prompt is augmented
   * with the matched skill body via injectContext, and trust counters
   * on the skill are bumped via the onApproved / onFailed hooks. When
   * absent, the supervise loop runs as before — skill matching is
   * strictly opt-in. Threaded from L3.fromType down through
   * L2Atom.fromType so a single SkillRegistry instance is shared
   * across every atom in a run.
   */
  readonly skillRegistry: SkillRegistry | null;

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
    skillRegistry?: SkillRegistry | null;
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
    this.skillRegistry = args.skillRegistry ?? null;
    if (args.peers) this.peers.push(...args.peers);
  }

  static fromType(
    type: AtomType,
    registry: AtomRegistry,
    peers: L2Atom[] = [],
    skillRegistry: SkillRegistry | null = null
  ): L2Atom {
    if (type.tier !== 2) throw new Error(`L2Atom.fromType requires tier=2`);
    return new L2Atom({
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      peers,
      skillRegistry,
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

    // Prefilter may either short-circuit the plan (single-subtask reuse)
    // or drop a hint that survives into the Sonnet plan call. The
    // "decomposable" flag controls which: if Haiku sees a composite
    // task, it picks a reusable child AND flags the task as needing
    // decomposition — we then fall through to Sonnet with the target
    // as a preferred-child hint, so Sonnet can emit a multi-subtask
    // plan that routes each leaf to the same reused child instead of
    // collapsing the whole task onto one L1 run.
    let prefilterHint: { target: string; reasoning: string } | null = null;
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
        if (!prefilter.decomposable) {
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
          //
          // viaPrefilter=true marks this plan as Haiku-synthesised so the
          // supervisor's validatePlan skips the redundant second Haiku
          // vet on it (see validatePlan + planSchema docs for why).
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
            viaPrefilter: true,
          };
        }
        // Decomposable reuse: fall through to the Sonnet plan with
        // the target as a hint. Do NOT mark triedChildren — the child
        // hasn't been consumed yet, and we want Sonnet to freely set
        // it as preferredChild on the decomposed subtasks.
        prefilterHint = { target: prefilter.target, reasoning: prefilter.reasoning };
        ctx.logger.debug(
          `[${this.name}] prefilter flagged decomposable reuse of ${prefilter.target} — deferring to Sonnet plan`,
          { reasoning: prefilter.reasoning }
        );
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
      // Prefilter hint from the decomposable short-circuit. Haiku has
      // already identified a reusable child but flagged the task as
      // multi-artefact — we preserve that signal so Sonnet sets
      // preferredChild on each leaf subtask instead of picking an
      // unrelated child or minting a new one.
      prefilterHint
        ? [
            `== PREFILTER HINT ==`,
            `A lightweight prefilter identified "${prefilterHint.target}" as the reusable L1`,
            `for the leaf work (${prefilterHint.reasoning}). It also flagged this task as`,
            `decomposable. Prefer setting "preferredChild": "${prefilterHint.target}" on each`,
            `leaf subtask, unless one subtask genuinely needs a different capability — in`,
            `which case still split, but use a different child there.`,
            ``,
          ].join('\n')
        : '',
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

    // Fan-out: run each subtask in parallel. Hooks are created INSIDE
    // runSubtask now (after the skill prefilter attempt) so they know
    // whether a skill drove the run — that info gates the C3 skill
    // auto-creation path on the onApproved hook.
    const subResults = await Promise.all(
      subtasks.map((subtask, idx) =>
        this.runSubtask({ subtask, strategy, parentTask: task, idx, ctx })
      )
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
    ctx: RunContext;
  }): Promise<Result> {
    const { subtask, strategy, parentTask, idx, ctx } = args;
    const l1Type = this.resolveL1ForSubtask(subtask, strategy, parentTask, idx, ctx);
    this.triedChildren.mark(l1Type.name);
    const l1 = L1Atom.fromType(l1Type);
    const subTask: Task = subtask.inputs
      ? { description: subtask.description, inputs: subtask.inputs }
      : { description: subtask.description };

    // Skill prefilter (C2a). When a SkillRegistry is wired and the
    // child has at least one persisted skill, run a Haiku
    // prefilter call against the skill catalog. If it picks one
    // with high confidence, inject the skill body into the L1's
    // effective system prompt via injectContext and tag the
    // instance via setActiveSkill so the hooks can bump the
    // skill's own trust counters on approve / fail.
    //
    // Skill prefilter REUSES `prefilterStrategy` from cost.ts so
    // the prompt + caching + confidence-guard semantics stay
    // identical to the existing tier prefilter — the only change
    // is the catalog (skills instead of children).
    let skillMatchAttempted = false;
    if (this.skillRegistry) {
      skillMatchAttempted = true;
      const skills = await this.matchSkill(l1Type.name, subTask, ctx);
      if (skills) {
        l1.injectContext(
          skillContextBlock({
            id: skills.skill.id,
            body: skills.skill.body,
            kind: skills.skill.kind,
            ...(skills.skill.language ? { language: skills.skill.language } : {}),
          })
        );
        l1.setActiveSkill(skills.skill.id);
        ctx.logger.debug(
          `[${this.name}] skill matched: ${skills.skill.id} (kind=${skills.skill.kind}; ${skills.reasoning})`
        );
      }
    }

    // Hooks are built HERE (after the match attempt) so the
    // onApproved hook can decide whether to run the C3 skill-
    // learning path: only fire when the prefilter saw skills but
    // none matched, AND the env flag is on, AND the run succeeded
    // without escalation.
    const hooks = this.makeL1Hooks(ctx, subtask.description, {
      l1Name: l1Type.name,
      subTask,
      skillMatchAttempted,
    });

    // Fork a branch-scoped ctx so every LLM/tool/trust event recorded
    // inside this supervise loop carries a unique branchId. Viz renders
    // each branch as its own lane instead of interleaving them.
    const branchCtx = forkBranch(ctx, randomUUID());
    return superviseLoop<L1Atom>(this, l1, subTask, branchCtx, hooks);
  }

  /**
   * Distill a successful run into a new skill (#3). Called from the
   * onApproved hook when ATOMA_SKILL_LEARN is on, the L1 had no
   * skill matched at prefilter time, and the supervise loop
   * approved the result without escalation. We ask Sonnet to
   * extract a kebab-case skill id, a short description, an
   * activation hint, and a body — all designed to feed back into
   * the skill prefilter on the NEXT run on a similar task.
   *
   * Guardrails:
   *  - Pre-existing skill with the same id: SKIP. The original
   *    skill carries its own trust counters and possibly hand-edits;
   *    auto-creation must not clobber it.
   *  - Malformed JSON: warn + skip. The run is already approved;
   *    the failure to learn isn't a run failure.
   *  - id sanity check: kebab-case, alphanum + dash only. Anything
   *    else is rejected to keep the on-disk filesystem layout safe.
   */
  private async learnSkillFromRun(args: {
    l1Name: string;
    subTask: Task;
    result: Result;
    child: L1Atom;
    ctx: RunContext;
  }): Promise<void> {
    if (!this.skillRegistry) return;
    const userContent = [
      `You are distilling a successful run into a reusable SKILL — a markdown`,
      `recipe attached to a tier-1 element so future runs on a similar task can`,
      `follow it instead of re-discovering the steps.`,
      ``,
      `An L1 element just completed a subtask without escalation. Look at the`,
      `subtask description and the L1's summary, infer the GENERAL PATTERN, and`,
      `output a skill draft.`,
      ``,
      `== L1 ATOM ==`,
      `${args.child.name} (tier 1)`,
      ``,
      `== SUBTASK THAT WAS COMPLETED ==`,
      args.subTask.description,
      ``,
      `== L1 SUMMARY OF WHAT IT DID ==`,
      args.result.summary,
      ``,
      `Output ONLY a JSON object — no fences, no preamble. The first character`,
      `must be "{". Required fields:`,
      `  "id":            kebab-case identifier, 3-6 words, like "write-package-json".`,
      `  "description":   one-line summary, ≤90 chars.`,
      `  "when_to_use":   one-line activation hint, ≤140 chars. Should describe`,
      `                   the SHAPE of the matching task, not its specific theme.`,
      `  "body":          markdown recipe, ≤500 chars total. Concrete steps the`,
      `                   L1 should take, NOT prose. Example shape:`,
      `                     "1. write_file <name>.\\n2. start_static_server.\\n3. validate_html with smoke."`,
      ``,
      `Skip the JSON entirely (return empty) if the run was too task-specific to`,
      `generalise (e.g. it depended on hard-coded numbers a future run wouldn't`,
      `share).`,
    ].join('\n');

    const resp = await args.ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: { ...this.params, maxTokens: 800, temperature: 0 },
      signal: args.ctx.signal,
    });
    const draft = parseSkillDraft(resp.text);
    if (!draft) {
      args.ctx.logger.debug(
        `[${this.name}] skill draft did not parse, skipping; raw=${resp.text.slice(0, 120)}`
      );
      return;
    }
    if (!isSafeSkillId(draft.id)) {
      args.ctx.logger.warn(
        `[${this.name}] skill auto-creation rejected: unsafe id "${draft.id}"`
      );
      return;
    }
    const existing = this.skillRegistry.loadFor(args.l1Name).find((s) => s.id === draft.id);
    if (existing) {
      args.ctx.logger.debug(
        `[${this.name}] skill ${draft.id} already exists for ${args.l1Name}, not overwriting`
      );
      return;
    }
    this.skillRegistry.save(args.l1Name, {
      id: draft.id,
      description: draft.description,
      whenToUse: draft.whenToUse,
      kind: 'llm',
      body: draft.body,
    });
    args.ctx.logger.info(
      `[${this.name}] learned new skill "${draft.id}" for ${args.l1Name}`
    );
  }

  /**
   * Generate an improved skill body via a Sonnet call (this.model).
   * Inputs:
   *   - the failing skill's current body,
   *   - the verbatim validator diagnosis (extractBranchDiagnostic
   *     output) explaining WHY the prior run was rejected,
   *   - the subtask description.
   *
   * The model is instructed to produce a TARGETED revision — fix
   * the cited failure, keep the rest of the recipe stable, do not
   * balloon the length. Output is plain markdown; we trim and
   * return the raw text. A blank or whitespace-only response
   * returns null so the caller can fall back to the legacy branch
   * path instead of saving an empty body.
   *
   * Sonnet (this.model) is the right model here:
   *  - the task is real reasoning (synthesise a fix from a
   *    diagnostic), not yes/no validation;
   *  - Haiku would routinely flatten the body or miss the precise
   *    diagnostic detail;
   *  - Opus would be overkill for the bounded context.
   */
  private async improveSkillBody(args: {
    skill: import('../skills/types.js').Skill;
    diagnostic: string;
    subtaskDescription: string;
    ctx: RunContext;
  }): Promise<string | null> {
    const userContent = [
      `You are revising a SKILL — a reusable how-to recipe attached to a tier-1 element.`,
      `The skill drove a recent run that the supervisor REJECTED. Your job: produce an`,
      `IMPROVED body for the skill that fixes the specific failure, while keeping the`,
      `skill applicable to its general task class. Do NOT rewrite the whole recipe.`,
      ``,
      `== SKILL ID ==`,
      args.skill.id,
      ``,
      `== SKILL DESCRIPTION ==`,
      args.skill.description,
      ``,
      `== CURRENT SKILL BODY ==`,
      args.skill.body,
      ``,
      `== SUBTASK THAT TRIGGERED THE FAILURE ==`,
      args.subtaskDescription,
      ``,
      `== VALIDATOR DIAGNOSIS ==`,
      args.diagnostic,
      ``,
      `Output ONLY the new skill body as plain markdown — no JSON envelope, no fences,`,
      `no preamble. Aim for the same length as the current body, slightly longer at most.`,
      `If the current body already addresses the diagnosis correctly and the failure was`,
      `due to something the recipe cannot fix (e.g. environment issue), return the body`,
      `unchanged.`,
    ].join('\n');

    const resp = await args.ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: { ...this.params, maxTokens: 1500, temperature: 0 },
      signal: args.ctx.signal,
    });
    const text = (resp.text ?? '').trim();
    if (!text) return null;
    return text;
  }

  /**
   * Run a Haiku skill-prefilter for the L1 named `l1Name` and the
   * given subtask. Returns the matched skill + the model's reasoning
   * when a confident match exists, null otherwise (no skills, no
   * registry, or prefilter escalated). The prefilter uses the same
   * confidence-guard + decomposable schema as the tier prefilter,
   * so the safety contract is uniform.
   *
   * The injected userContent labels each catalog entry as
   * "<skillId>: <description>. When to use: <whenToUse>" so Haiku
   * sees BOTH the capability summary and the activation hint.
   */
  private async matchSkill(
    l1Name: string,
    subTask: Task,
    ctx: RunContext
  ): Promise<{ skill: Skill; reasoning: string } | null> {
    if (!this.skillRegistry) return null;
    const skills = this.skillRegistry.loadFor(l1Name);
    if (skills.length === 0) return null;
    const outcome = await prefilterStrategy({
      ctx,
      task: subTask,
      catalog: skills.map((s) => ({
        name: s.id,
        description: `${s.description}. When to use: ${s.whenToUse}`,
      })),
      actor: { name: this.name, tier: 2 },
    });
    if (!outcome || outcome.kind !== 'reuse') return null;
    const matched = skills.find((s) => s.id === outcome.target);
    if (!matched) return null;
    return { skill: matched, reasoning: outcome.reasoning };
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
    // BUCKET-AWARE system prompt: only append SMOKE_DESIGN_GUIDANCE when
    // the merged toolset includes validate_html (the web bucket). An HTTP
    // L1 or a custom-bucket L1 that doesn't own validate_html should not
    // be told about smoke primitives it can't use — that guidance taught
    // earlier runs to INVOKE validate_html anyway via the shared executor
    // (fix #8b). See buildNarrowL1Prompt for the mirror logic on the
    // escalation branch path.
    const hasValidateHtml = mergedTools.some((t) => t.name === 'validate_html');
    return this.registry.create(1, {
      description: resolveCreationDescription(seed.description, mergedTools, 1),
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
          ...(hasValidateHtml ? [SMOKE_DESIGN_GUIDANCE] : []),
        ].join('\n'),
      tools: mergedTools,
      params: (seed.params ?? this.params) as GenerationParams,
      createdBy: this.name,
    });
  }

  private makeL1Hooks(
    ctx: RunContext,
    subtaskDescription: string,
    skillCtx: {
      /** L1 atom-type name for this subtask (skills are namespaced by it). */
      l1Name: string;
      /** The actual subtask Task, needed by skill-learning prompts. */
      subTask: Task;
      /**
       * True when L2 ran a skill-prefilter for this subtask. False
       * when no SkillRegistry was wired (skills disabled). Gates the
       * C3 skill auto-creation path: we only learn a new skill when
       * we DID look for one and didn't find a match — never when
       * skills are disabled wholesale.
       */
      skillMatchAttempted: boolean;
    }
  ): SupervisionHooks<L1Atom> {
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
      branchOnEscalation: async (child, trace, reason) => {
        // Aligned system prompt: start the branch FRESH with the current
        // subtask's domain, not inherited from the parent. Without this
        // reset, a "platformer builder" parent gets branched into a
        // "dashboard builder" child that still introduces itself as a
        // platformer and keeps emitting platformer plans (Frankenstein).
        //
        // BUCKET-AWARE: buildNarrowL1Prompt reads childTools to pick
        // the tool-sequence body (HTTP vs web vs generic) — fix #8b.
        //
        // DIAGNOSTIC INJECTION (#1): we also extract the parent's last
        // validator rejection reasoning(s) from the trace and inject
        // them as a "== PRIOR ATTEMPT DIAGNOSIS ==" block in the narrow
        // prompt. Without this, a branch created after a ground-truth
        // 404 rejection had NO idea the parent hit a 404 — it just saw
        // "previous attempts failed" and re-ran the full deliverable
        // cycle (observed on the backgammon run: Beryllium did 23
        // identical validate_html calls after Hydrogen's 16, never
        // fixing the underlying server/file mismatch).
        //
        // Capability-first registry description: the task narrative
        // stays in the narrow prompt; the registry row stays tier /
        // tool scoped so prefilter cross-domain reuse stays clean.
        // Atom.tools is protected, so we re-resolve the toolset via
        // the registry — the registry is the authoritative source.
        const childType = this.registry.getByName(child.name);
        const childTools = childType?.tools ?? [];
        const diagnostic = extractBranchDiagnostic(trace);

        // Skill update path (C2b). When the failed run was driven by
        // a skill, the cleanest remediation is to UPDATE THE SKILL
        // BODY using the validator's diagnosis — not to branch the
        // atom type. The skill lives in the SkillRegistry; a save
        // here overwrites the body but PRESERVES trust counters
        // (C1's save() contract). We then return a fresh L1
        // instance with the updated body injected, and the
        // supervise-loop's `hasTriedBranch` mechanism gives that
        // instance ONE more clean cycle. If the second pass also
        // fails the loop falls through to the parent fallback path
        // — same as the legacy branch flow.
        //
        // We require BOTH activeSkillId AND a non-empty diagnostic
        // before attempting an update: re-running the same skill
        // body without anything new for the model to act on would
        // just reproduce the previous outcome.
        const activeSkillId = child.activeSkillId();
        if (activeSkillId && this.skillRegistry && diagnostic.length > 0 && childType) {
          const skills = this.skillRegistry.loadFor(child.name);
          const oldSkill = skills.find((s) => s.id === activeSkillId);
          if (oldSkill) {
            try {
              const newBody = await this.improveSkillBody({
                skill: oldSkill,
                diagnostic,
                subtaskDescription,
                ctx,
              });
              if (newBody) {
                this.skillRegistry.save(child.name, {
                  id: oldSkill.id,
                  description: oldSkill.description,
                  whenToUse: oldSkill.whenToUse,
                  kind: oldSkill.kind,
                  ...(oldSkill.language ? { language: oldSkill.language } : {}),
                  body: newBody,
                });
                ctx.logger.warn(
                  `[${this.name}] skill ${activeSkillId} on ${child.name} updated after escalation (${reason}); retrying L1 with new body`
                );
                const fresh = L1Atom.fromType(childType);
                fresh.injectContext(
                  skillContextBlock({
                    id: activeSkillId,
                    body: newBody,
                    kind: oldSkill.kind,
                    ...(oldSkill.language ? { language: oldSkill.language } : {}),
                  })
                );
                fresh.setActiveSkill(activeSkillId);
                return fresh;
              }
            } catch (err) {
              // Sonnet unavailable / parse error / network blip —
              // fall through to the legacy branch path so the run
              // still has a recovery channel.
              ctx.logger.warn(
                `[${this.name}] skill update failed: ${(err as Error).message}; falling back to standard branch`
              );
            }
          }
        }

        const narrowPrompt = buildNarrowL1Prompt(
          subtaskDescription,
          childTools,
          diagnostic
        );
        const narrowDesc = resolveCreationDescription(undefined, childTools, 1);
        const branched = this.registry.branch(
          child.name,
          {
            systemPromptReplace: narrowPrompt,
            descriptionReplace: narrowDesc,
            additionalContext:
              `Branched after escalation. Previous attempts failed because the inherited prompt` +
              ` was misaligned with this task. Prompt has been reset to a narrow template focused` +
              ` on the current subtask.` +
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
        // Return a fresh L1 instance of the branched type so the supervise
        // loop can give it one attempt before falling back to this L2.
        // Without this, the branch was recorded in the registry but never
        // actually tried on the current task — purely a lesson for future
        // runs. By handing the new instance back we let the anti-
        // Frankenstein narrow prompt prove itself in-flight.
        return L1Atom.fromType(branched);
      },
      onApproved: async (child, result) => {
        this.registry.recordSuccess(child.name);
        // Skill trust counter bump (C2a). When the supervise loop
        // approves a result and a skill drove the run, record a
        // success on the skill itself — this is what lets future
        // runs "trust" the skill more, and (in a follow-up) lets
        // the system identify mature skills worth promoting from
        // hand-written to auto-managed.
        const skillId = child.activeSkillId();
        if (skillId && this.skillRegistry) {
          this.skillRegistry.recordSuccess(child.name, skillId);
        } else if (
          // Skill auto-creation (C3). Fires when ALL of:
          //   - L2 attempted a skill match for this subtask;
          //   - no skill matched (the run was novel);
          //   - the run was approved (i.e. it's a clean reusable pattern);
          //   - the env flag ATOMA_SKILL_LEARN is on (off by default
          //     because each learning event costs one Sonnet call,
          //     and not every project wants automatic mutation of
          //     its skills folder).
          !skillId &&
          skillCtx.skillMatchAttempted &&
          this.skillRegistry &&
          process.env['ATOMA_SKILL_LEARN'] === '1'
        ) {
          try {
            await this.learnSkillFromRun({
              l1Name: skillCtx.l1Name,
              subTask: skillCtx.subTask,
              result,
              child,
              ctx,
            });
          } catch (err) {
            ctx.logger.warn(
              `[${this.name}] skill auto-creation failed: ${(err as Error).message}`
            );
          }
        }
      },
      onFailed: async (child, _reason) => {
        this.registry.recordFailure(child.name);
        const skillId = child.activeSkillId();
        if (skillId && this.skillRegistry) {
          this.skillRegistry.recordFailure(child.name, skillId);
        }
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
    // Prefilter fast-path: a plan synthesised by the Haiku prefilter
    // short-circuit is already the product of a capability-match
    // decision — asking another Haiku to vet "delegate leaf task to L1
    // Helium" produces no new signal and regularly rejects the
    // freshly-bootstrapped canonical picks. We short-circuit to
    // approval, which matches the semantic of validatePlan (yes/no on
    // the plan's fitness) without paying the redundant round-trip.
    // Trust counters are NOT used here: an untrusted but prefilter-
    // validated child gets the pass precisely because the prefilter
    // already did the capability-match reasoning.
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
  'L1 PLAN SHAPE (explicit — do NOT reject L1 plans for the wrong reason):',
  '  A correct L1 plan is a DIRECT execution plan. It MAY include a pre-declared',
  '  `toolCalls` array listing the intended tool sequence ("write_file then',
  '  start_node_server then fetch_url"), AND it MAY describe the same intent in',
  '  `proposedAction` prose. Both shapes are valid L1 plan outputs.',
  '  DO NOT reject an L1 plan for "proposing tool invocations directly" — that is',
  '  the L1 plan shape, not a tier violation. The rule "only L1 may invoke tools"',
  '  means L2/L3 must DELEGATE; it does NOT mean L1 plans must hide their tool',
  '  sequence from the validator. Aspirational `toolCalls` entries at plan time',
  '  ("will call fetch_url on /health") are EXPECTED — they state intent, the',
  '  executor phase carries them out. Do not demand a proof of execution at plan',
  '  time; that is the RESULT phase.',
  '  Do not reject an L1 plan because it lists tool calls that need runtime',
  '  data the plan cannot yet know (the OS-assigned port, the server URL that',
  '  start_node_server will return, the probe body echoed back). Placeholders or',
  '  references to "the bound URL from start_node_server" are acceptable — the',
  '  executor resolves them at tool-call time.',
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
  const groundTruthBlock = await probeGroundTruth({
    ctx: args.ctx,
    subject: args.subject,
    payload: args.payload,
    child: args.child,
  });

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
  /**
   * The child atom whose RESULT we are validating. We inspect its
   * declared tool names to decide whether a validate_html ground-truth
   * probe even makes sense: an HTTP-bucket L1 produces a JSON REST API
   * URL, and running Puppeteer against it returns "errors" that the
   * supervisor then (incorrectly) treats as a child failure. The probe
   * is a web-bucket invariant, not a universal one — #9.
   */
  child: import('../core/atom.js').Atom;
}): Promise<string> {
  if (args.subject !== 'RESULT') return '';
  const tools = args.ctx.tools;
  if (!tools || !tools.has('validate_html')) return '';
  // Bucket gate: the probe is a web-artefact sanity check. A child that
  // does NOT declare validate_html cannot have produced a web artefact
  // the probe is designed to verify — probing the result URL with
  // Puppeteer would just generate noise that Haiku reads as "errors
  // contradict the child's claim" and reject a perfectly valid HTTP
  // result. Observed in the Node/REST live run: Helium (HTTP-scope)
  // returned the bound URL; the supervisor ran validate_html against
  // the JSON API, got Puppeteer errors, rejected, cascade of
  // escalations. We require the child itself to advertise
  // validate_html before treating it as a web artefact.
  if (!args.child.toolNames().includes('validate_html')) return '';
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
