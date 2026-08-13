import { Atom, type Peerable, type Supervisor } from '../core/atom.js';
import type {
  GenerationParams,
  NegativeVerdict,
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Tool,
  Verdict,
} from '../core/types.js';
import { eventSkillBlock, matchEventSkill } from '../skills/events.js';
import {
  extractRecordedProbes,
  recordedProbesFromWitnesses,
} from '../contracts/witness.js';
import { hostAllowsLoopbackNetwork, scanScriptBody } from '../skills/scriptScan.js';
import {
  stripBranchProvenance,
  type AtomRegistry,
  type AtomType,
} from '../registry/atomRegistry.js';
import { modelForTier } from '../core/models.js';
import { INTERNAL_VALIDATION_FAILED_PREFIX, L1Atom } from './L1Atom.js';
import {
  type L2Strategy,
  l2StrategySchema,
  NON_JSON_PAYLOAD_SUMMARY_PREFIX,
  parsePayloadTolerant,
  parsePlanWithFallback,
  parseTwoJson,
  planSchema,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { forkBranch } from '../core/branchCtx.js';
import { randomUUID } from 'node:crypto';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';
import {
  prefilterStrategy,
  shouldTrustSkill,
  shouldTrustType,
  trustedApproval,
  STRATEGY_MAX_TOKENS,
  TaskChildrenMemo,
} from './cost.js';
import {
  bucketIdForTools,
  CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES,
  extractBranchDiagnostic,
  GROUND_TRUTH_EVIDENCE_LINES,
  lastResultVerdictSkillFollowed,
  resolveCreationDescription,
} from './capability.js';
import {
  checkGroundTruth,
  DURABLE_HTTP_PORT_LITERAL_RE,
  type GroundTruthCheck,
} from './groundTruth.js';
import {
  PROBE_MANIFEST_FILENAME,
  smokeOkIncludesStyling,
  smokeResultIncludesStyling,
} from '../contracts/probeManifest.js';
export {
  checkGroundTruth,
  extractResultFileClaims,
  extractResultFilePaths,
  extractResultUrl,
  type GroundTruthCheck,
} from './groundTruth.js';
export { extractRecordedProbes } from '../contracts/witness.js';
import { SkillLifecycle, resultHasSuccessfulToolAction } from '../skills/lifecycle.js';
import { llmVerdict, undeclaredToolMentions} from './verdict.js';
import { dispatchWithAggregation } from './dispatch.js';
export { llmVerdict, VALIDATION_SYSTEM_PROMPT } from './verdict.js';
import { skillContextBlock } from '../skills/lifecycle.js';
export {
  isSafeSkillId,
  parseSkillDraft,
  parseSkillDrafts,
  skillContextBlock,
  type SkillDraft,
} from '../skills/lifecycle.js';
import {
  HTTP_PORTABLE_DOC_GUIDANCE,
  LITERAL_CONTRACT_PRESERVATION_GUIDANCE,
  MUTATING_SUBTASK_FILE_GUIDANCE,
  preservePlanLiteralContracts,
  SMOKE_DESIGN_GUIDANCE,
  stripLiteralContractBlock,
} from './prompts.js';
export { SMOKE_DESIGN_GUIDANCE } from './prompts.js';
// Compatibility re-exports: tests and the skills CLI historically import
// these from L2Atom; the definitions now live in src/contracts/ and
// src/skills/compilePrompt.ts.
export { buildCompileSkillPrompt, COMPILE_PROMPT_GENERATION } from '../skills/compilePrompt.js';
export { validateProbeManifest } from '../contracts/probeManifest.js';
export { scriptDeclaresEnvelope } from '../contracts/scriptEnvelope.js';
import type { Skill } from '../skills/types.js';
import type { SkillRegistry } from '../skills/registry.js';
import { visibleSkillNamespaces } from '../skills/visibility.js';








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
    `You are an L1 molecule builder with ONE narrow responsibility.`,
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
      `  4. if validation fails: read_file, diagnose, apply the fix with`,
      `     edit_file (exact str_replace — no whole-file rewrite), re-validate.`,
      `     Up to 4 iterations.`,
      `  5. return JSON {"output": <url or summary>, "summary": "<one sentence>"}`,
      ``,
      SMOKE_DESIGN_GUIDANCE,
    ];
  } else {
    // Unknown bucket — keep a generic tools-only template. DO NOT append
    // SMOKE_DESIGN_GUIDANCE here: the smoke discipline is web-bucket
    // specific and leaking it teaches the model to invoke validate_html
    // even when the atom's declared tools don't include it. The generic
    // GROUND-TRUTH evidence contract, however, is bucket-neutral and
    // REQUIRED: without it, non-web/http L1s return narrative-only
    // summaries that the validator correctly rejects as unverifiable
    // (the wc-cli README rejection loop).
    bucketBody = [
      `Call tools sequentially to produce the deliverable. Use ONLY the`,
      `tools you were handed — do NOT invoke anything that isn't in your`,
      `declared tool list.`,
      ``,
      ...GROUND_TRUTH_EVIDENCE_LINES,
    ];
  }

  return [...header, ...bucketBody].join('\n');
}

export function webStylingEvidenceMissing(task: Task, result: Result): boolean {
  if (!/\b(?:conditional\s+styl|styling|style|class|colou?r)\b/i.test(task.description)) {
    return false;
  }
  if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
    return true;
  }
  const probes = (result.output as Record<string, unknown>)['probes'];
  if (!Array.isArray(probes)) return true;
  let milestoneStyling = false;
  let resetStyling = false;
  for (const probe of probes) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
    const entry = probe as Record<string, unknown>;
    const smoke = typeof entry['smoke'] === 'string' ? entry['smoke'] : '';
    const smokeResult =
      entry['smokeResult'] && typeof entry['smokeResult'] === 'object'
        ? JSON.stringify(entry['smokeResult'])
        : '';
    const hasStyling =
      /(?:class|style|colou?r|getComputedStyle)/i.test(smoke) &&
      smokeResultIncludesStyling(entry['smokeResult']) &&
      smokeOkIncludesStyling(smoke);
    if (!hasStyling) continue;
    const evidenceText = `${smoke}\n${smokeResult}`;
    if (/(?:milestone|afterIncrement|afterClick|streak.?3)/i.test(evidenceText)) {
      milestoneStyling = true;
    }
    if (/(?:reset|final)/i.test(evidenceText)) resetStyling = true;
  }
  return !(milestoneStyling && resetStyling);
}

function recordedJsonShapeMismatchFromProbes(
  task: Task,
  probes: readonly unknown[]
): string | null {
  const expectsObject = /\bJSON\s+object\b/i.test(task.description);
  const expectsArray = /\bJSON\s+array\b/i.test(task.description);
  if (expectsObject === expectsArray) return null;
  if (probes.length === 0) return null;

  let observed = 0;
  let matching = 0;
  for (const probe of probes) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
    const entry = probe as Record<string, unknown>;
    if (entry['exitCode'] !== 0 || typeof entry['stdout'] !== 'string') continue;
    const stdout = entry['stdout'].trim();
    if (!stdout) continue;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      observed++;
      const isArray = Array.isArray(parsed);
      const isObject = parsed !== null && typeof parsed === 'object' && !isArray;
      if ((expectsObject && isObject) || (expectsArray && isArray)) matching++;
    } catch {
      // Non-JSON stdout is silent here; the normal validator decides whether
      // mixed/logged output satisfies the task.
    }
  }
  if (observed === 0 || matching > 0) return null;
  return expectsObject
    ? 'the task requires JSON object output, but every parseable successful probe returned a JSON array'
    : 'the task requires JSON array output, but every parseable successful probe returned a JSON object';
}

function resultRecordedProbes(result: Result): unknown[] {
  return [
    ...extractRecordedProbes({ output: result.output }),
    ...recordedProbesFromWitnesses(result.evidence),
  ];
}

export function recordedJsonShapeMismatch(task: Task, result: Result): string | null {
  return recordedJsonShapeMismatchFromProbes(task, resultRecordedProbes(result));
}

async function checkRecordedJsonShape(
  task: Task,
  result: Result,
  ctx: RunContext
): Promise<string | null> {
  const probes = resultRecordedProbes(result);
  const inlineMismatch = recordedJsonShapeMismatchFromProbes(task, probes);
  if (inlineMismatch) return inlineMismatch;
  const expectsShape =
    /\bJSON\s+object\b/i.test(task.description) !==
    /\bJSON\s+array\b/i.test(task.description);
  if (!expectsShape || !ctx.tools?.has('read_file')) {
    return null;
  }
  try {
    const raw = await ctx.tools.execute('read_file', { path: PROBE_MANIFEST_FILENAME });
    const content =
      raw &&
      typeof raw === 'object' &&
      typeof (raw as Record<string, unknown>)['content'] === 'string'
        ? ((raw as Record<string, unknown>)['content'] as string)
        : typeof raw === 'string'
          ? raw
          : '';
    const parsed = content.trim() ? (JSON.parse(content) as unknown) : null;
    const entries =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['entries']
        : undefined;
    if (Array.isArray(entries)) probes.push(...entries);
  } catch {
    // Missing/malformed manifests are handled by the ground-truth health
    // checker. Shape mismatch remains silent when no parseable evidence exists.
  }
  return recordedJsonShapeMismatchFromProbes(task, probes);
}

export function requiredPassingCommands(description: string): string[] {
  const commands = [
    ...description.matchAll(
      /\bnode\s+((?:[\w.-]+\/)*(?:(?:test|probe|verify|check|harness)[\w.-]*|[\w.-]+-(?:test|probe|verify|check|harness))\.(?:m?js|cjs))\b/gi
    ),
  ].map((match) => `node ${match[1]}`);
  return [...new Set(commands)];
}

export function requiredCommandManifestMismatch(
  taskDescription: string,
  manifestRaw: string
): string | null {
  const commands = requiredPassingCommands(taskDescription);
  if (commands.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return null; // Manifest health reports malformed JSON separately.
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = (parsed as Record<string, unknown>)['entries'];
  if (!Array.isArray(entries)) return null;
  for (const command of commands) {
    const matching = entries.filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>)['cmd'] === command
    ) as Array<Record<string, unknown>>;
    const latest = matching.at(-1);
    if (!latest) {
      return `the task requires ${command} to pass, but the probe manifest has no entry for that exact command`;
    }
    if (latest['exitCode'] !== 0) {
      return `the task requires ${command} to pass, but its latest recorded exit code is ${JSON.stringify(latest['exitCode'])}`;
    }
  }
  return null;
}

export function taskRequiresRealBrowser(description: string): boolean {
  const phaseDescription = stripLiteralContractBlock(description);
  return (
    /\b(?:real browser|browser validation|validate_html)\b/i.test(phaseDescription) ||
    /\b(?:confirm|reconfirm|replay|verify)\b[\s\S]{0,100}\bweb probes?\b/i.test(
      phaseDescription
    ) ||
    (/\bselector-based\b/i.test(phaseDescription) &&
      /\b(?:window\.__test|console(?:\.error|\s+errors?)|failed requests?)\b/i.test(
        phaseDescription
      ))
  );
}

async function checkRequiredCommandManifest(
  task: Task,
  ctx: RunContext
): Promise<string | null> {
  if (requiredPassingCommands(task.description).length === 0) return null;
  if (!ctx.tools?.has('read_file')) return null;
  try {
    const raw = await ctx.tools.execute('read_file', { path: PROBE_MANIFEST_FILENAME });
    const content =
      raw &&
      typeof raw === 'object' &&
      typeof (raw as Record<string, unknown>)['content'] === 'string'
        ? ((raw as Record<string, unknown>)['content'] as string)
        : typeof raw === 'string'
          ? raw
          : '';
    if (!content.trim()) {
      return `the task requires ${requiredPassingCommands(task.description).join(', ')} to pass, but the probe manifest is missing or empty`;
    }
    return requiredCommandManifestMismatch(task.description, content);
  } catch {
    return `the task requires ${requiredPassingCommands(task.description).join(', ')} to pass, but the probe manifest could not be read`;
  }
}

async function checkRequiredPortableHttpDocs(
  task: Task,
  ctx: RunContext
): Promise<string | null> {
  if (
    !/\bREADME\.md\b/i.test(task.description) ||
    !/(?:<port>|portable|never[^.\n]{0,80}numeric port)/i.test(task.description) ||
    !ctx.tools?.has('read_file')
  ) {
    return null;
  }
  try {
    const raw = await ctx.tools.execute('read_file', { path: 'README.md' });
    const content =
      raw &&
      typeof raw === 'object' &&
      typeof (raw as Record<string, unknown>)['content'] === 'string'
        ? ((raw as Record<string, unknown>)['content'] as string)
        : typeof raw === 'string'
          ? raw
          : '';
    return DURABLE_HTTP_PORT_LITERAL_RE.test(content)
      ? 'the task requires portable README.md port placeholders, but README.md contains a numeric loopback URL or LISTENING_ON_PORT value'
      : null;
  } catch {
    return 'the task requires portable HTTP documentation in README.md, but README.md could not be read';
  }
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
    this.model = args.model ?? modelForTier(2);
    this.validationModel = args.validationModel ?? modelForTier(1);
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
      let prefilter = await prefilterStrategy({
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
      if (prefilter?.kind === 'reuse' && taskRequiresRealBrowser(task.description)) {
        const prefilterTarget = prefilter.target;
        const selected = catalog.find((candidate) => candidate.name === prefilterTarget);
        if (!selected?.tools.some((tool) => tool.name === 'validate_html')) {
          const webCandidate = catalog.find((candidate) =>
            candidate.tools.some((tool) => tool.name === 'validate_html')
          );
          if (webCandidate) {
            ctx.logger.warn(
              `[${this.name}] browser-verification task was prefiltered to ${prefilter.target}, which lacks validate_html — routing to ${webCandidate.name}`
            );
            prefilter = {
              ...prefilter,
              target: webCandidate.name,
              reasoning: `${prefilter.reasoning}; mechanically redirected because real browser verification requires validate_html`,
            };
          }
        }
      }
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
      `You are cell "${this.name}" (tier 2 / cell).`,
      ``,
      `HARD RULE: You NEVER execute tools yourself; those tools are elements. You do NOT write files, run`,
      `shells, start servers, or validate anything. Your role is to DECOMPOSE the`,
      `task into orthogonal subtasks and route each to an L1 molecule (the only`,
      `tier that can call tools).`,
      ``,
      `== DECOMPOSITION DISCIPLINE ==`,
      `Split the task into a LIST of subtasks. Each subtask:`,
      `  - has ONE single-responsibility description ("write the HTML layout",`,
      `    "implement game state machine", "start server + run validation")`,
      `  - is ORTHOGONAL to every other subtask — no subtask reads or depends on`,
      `    another subtask's output. Subtasks run in PARALLEL.`,
      `  - targets a specific L1 molecule via "preferredChild" (required for N>1,`,
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
      `  - "sequential": phases run ONE AT A TIME on the SAME workspace. Each`,
      `    step receives "previousStepSummary" automatically in its inputs. Use`,
      `    when phases share an evolving artefact (build → extend → smoke). The`,
      `    final phase's output is the deliverable; no extra LLM merge call.`,
      `    Rare at L2 (one L1 usually carries a leaf task end-to-end), but`,
      `    valid when a parent L3 already split into a phase you must yourself`,
      `    chain (e.g. "build artefact then run review"); usually L3 owns this.`,
      ``,
      `== VERIFICATION MATCHES THE ARTEFACT ==`,
      `When a subtask verifies work, its description must name the probe`,
      `matching the deliverable: browser-rendered pages → start_static_server`,
      `+ validate_html; HTTP servers/APIs → start_node_server + fetch_url;`,
      `CLI tools / scripts / configs / docs → run_shell executing the`,
      `artefact (node/npm) plus reading files back. NEVER send a non-browser`,
      `artefact into a serve+validate_html loop — the worker would fabricate`,
      `an index.html just to have something to serve.`,
      `A task that explicitly requires a REAL browser must route to an L1 that`,
      `declares validate_html. An HTTP-only child cannot replace browser`,
      `interaction with a Node request harness or static source inspection.`,
      HTTP_PORTABLE_DOC_GUIDANCE,
      `Write subtask descriptions as OUTCOMES, not tool invocations — a`,
      `description hard-naming a tool binds a child that may not declare`,
      `it; children know their own tools.`,
      `When a subtask records or replays the probe manifest`,
      `(.atoma-probes.json), say WHAT to record — never SPELL OUT field names`,
      `or an entry schema in the subtask text: the workers carry the`,
      `canonical contract, and a plan-invented schema makes the validator`,
      `whipsaw the worker between the phantom shape and the real one.`,
      ``,
      MUTATING_SUBTASK_FILE_GUIDANCE,
      ``,
      LITERAL_CONTRACT_PRESERVATION_GUIDANCE,
      ``,
      `== STRATEGY OPTIONS (picks the L1 baseline) ==`,
      `  - "reuse": pick an existing L1 molecule from the catalog that fits`,
      `  - "create": design a new L1 molecule and register it (provide a seed)`,
      `  - "mutualize": delegate to a peer L2 cell when their specialty fits better`,
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
      `  {"reasoning": "...", "subtasks": [{"description": "...", "preferredChild": "<L1-name>"?, "inputs": {}?}, ...], "aggregation": {"mode": "concat"|"llm-synthesize"|"sequential", "instruction": "..."?}, "expectedOutput": "..."}`,
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
      params: { ...this.params, maxTokens: STRATEGY_MAX_TOKENS, effort: 'medium' },
      signal: ctx.signal,
    });

    const pair = parseTwoJson(resp.text);
    this.pendingStrategy = l2StrategySchema.parse(pair[0]);
    const plan = planSchema.parse(pair[1]);
    return preservePlanLiteralContracts(plan, task.description);
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
    const subResults = await this.dispatchSubtasks(subtasks, plan, strategy, task, ctx);
    return this.aggregate(subResults, plan.aggregation, task, ctx);
  }

  /**
   * Mirror of L3Atom.dispatchSubtasks. See that comment for the full
   * rationale; the logic is identical at this tier — sequential phases
   * thread `previousStepSummary` into each next subtask's `inputs`,
   * concat / llm-synthesize fan out via Promise.all. Hooks are created
   * INSIDE runSubtask (after the skill prefilter attempt) so they know
   * whether a skill drove the run — that info gates the C3 skill
   * auto-creation path on the onApproved hook.
   */
  /**
   * hallucinated-preferredChild → actually-created L1 name, scoped to ONE
   * plan dispatch (mirror of L3.planChildAliases). Without it, a Sonnet
   * plan naming a single invented L1 ("Carbon") on N subtasks minted N
   * same-labelled clones in one dispatch — the catalog-pollution class
   * (Ammonia/CarbonDioxide/Glucose series) that splits trust counters,
   * delays the fast-path and fragments skill namespaces. Cleared at each
   * dispatch; resolution happens in the synchronous prefix of runSubtask,
   * so the map is race-free even under the parallel branch.
   */
  private readonly planChildAliases = new Map<string, string>();

  private async dispatchSubtasks(
    subtasks: readonly Plan['subtasks'][number][],
    plan: Plan,
    strategy: L2Strategy,
    task: Task,
    ctx: RunContext
  ): Promise<Result[]> {
    this.planChildAliases.clear();
    return dispatchWithAggregation(subtasks, plan, ctx, (subtask, idx) =>
      this.runSubtask({
        subtask,
        strategy,
        parentTask: task,
        idx,
        total: subtasks.length,
        aggregationMode: plan.aggregation.mode,
        ctx,
      })
    );
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
    total: number;
    aggregationMode: Plan['aggregation']['mode'];
    ctx: RunContext;
  }): Promise<Result> {
    const {
      subtask,
      strategy,
      parentTask,
      idx,
      total,
      aggregationMode,
      ctx,
    } = args;
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
    // Subtask-scoped match identity — distinct from the INSTANCE tag
    // (`child.activeSkillId()`): an escalation branch returns a FRESH
    // instance that carries no tag, and gating the C3 learner on the
    // instance made every skill-driven-but-escalated run read as "novel"
    // — each one distilled near-duplicates of the recipe that had
    // matched (observed: 4 replay-twins in 2 days, all operator-merged).
    let matchedSkillId: string | undefined;
    let visibleNsForHooks: readonly string[] | undefined;
    if (this.skillRegistry) {
      skillMatchAttempted = true;
      // SHARED-CATALOG VISIBILITY (commit B): resolved ONCE per subtask,
      // here where l1Type and its tools are in hand. Donor namespaces are
      // those whose bucket the reader can EXECUTE (required ⊆ reader
      // tools); orphaned namespaces (type gone from the registry) are
      // never offered. Kill switch: ATOMA_SKILL_SHARED_CATALOG=0.
      const readerToolNames = (l1Type.tools ?? []).map((t) => t.name);
      const visibleNs = visibleSkillNamespaces({
        home: l1Type.name,
        readerToolNames,
        namespaces: this.skillRegistry.listNamespaces(),
        toolNamesFor: (ns: string) => {
          const t = this.registry.getByName(ns);
          return t ? (t.tools ?? []).map((x) => x.name) : null;
        },
      });
      visibleNsForHooks = visibleNs;
      let skills = await this.matchSkill(visibleNs, readerToolNames, subTask, ctx);
      // STATIC-SCAN QUARANTINE for kind:script matches. Promotion already
      // refuses flagged compiler output, so this catches hand-authored and
      // legacy scripts. Quarantine means neither path runs the body: the
      // deterministic dispatch would execute it directly, and the injected
      // block instructs the L1 to run it verbatim — falling back to the
      // LLM loop is NOT a mitigation here. The run proceeds skill-less,
      // exactly as if nothing had matched.
      if (skills && skills.skill.kind === 'script') {
        const scanFlags = scanScriptBody(skills.skill.body, {
          allowLoopbackNetwork: hostAllowsLoopbackNetwork(
            (l1Type.tools ?? []).map((t) => t.name)
          ),
        });
        if (scanFlags.length > 0) {
          ctx.logger.warn(
            `[${this.name}] skill "${skills.skill.id}" QUARANTINED — static scan flagged: ${scanFlags.join(', ')}; running WITHOUT it (review the body, then \`skills reset\` or \`skills drop\`)`
          );
          ctx.recordSkill?.({
            op: 'quarantine',
            l1Name: l1Type.name,
            skillId: skills.skill.id,
            actorName: this.name,
            actorTier: 2,
            reasoning: `static scan: ${scanFlags.join(', ')} — ni dispatch ni injection, run sans skill`,
          });
          skills = null;
        }
      }
      if (skills) {
        matchedSkillId = skills.skill.id;
        ctx.logger.debug(
          `[${this.name}] skill matched: ${skills.skill.id} (kind=${skills.skill.kind}; ${skills.reasoning})`
        );
        // Match-history counter for `skills stats` — recorded at match time
        // (before the outcome, on BOTH dispatch paths) so the gap against
        // the trust counters surfaces free-riding matches.
        this.skillRegistry.markMatched(skills.ownerNs, skills.skill.id);
        ctx.recordSkill?.({
          op: 'match',
          l1Name: skills.ownerNs,
          skillId: skills.skill.id,
          actorName: this.name,
          actorTier: 2,
          reasoning: skills.reasoning,
        });

        // Deterministic dispatch (#C4). A TRUSTED `kind: 'script'` skill
        // (3+ clean runs AFTER promotion, zero failures — promotion resets
        // the markdown recipe's counters so the new script earns trust)
        // is executed DIRECTLY
        // via write_file + run_shell: zero LLM calls, no L1 plan/execute,
        // no validators. The script's exit code + envelope contract
        // ({"output", "summary"} as the last stdout line) IS the ground
        // truth. Any deviation — non-zero exit, missing envelope, tool
        // error — falls through to the normal inject-and-supervise path
        // below, so the fast-path can never make a run fail that the LLM
        // loop would have saved. Kill switch: ATOMA_SKILL_DIRECT=0.
        if (
          skills.skill.kind === 'script' &&
          shouldTrustSkill(skills.skill) &&
          ctx.tools &&
          process.env['ATOMA_SKILL_DIRECT'] !== '0'
        ) {
          const direct = await this.runScriptSkillDirect(
            skills.skill,
            skills.ownerNs,
            subTask,
            ctx
          );
          if (direct) {
            // ANTI-REDISPATCH GUARD (epoch-5 run 5, the $1.63 lesson). A
            // trusted script is DETERMINISTIC: same workspace → the
            // byte-identical result. When an upstream validator rejects
            // that result on CONTENT (mechanically the dispatch
            // "succeeded", so no directFailure, no demotion — the skill
            // even got credited), the replan re-matched the same script
            // and re-produced the same rejected result: measured live,
            // SIX identical dispatches, two escalations, three Opus plans
            // in one run. Replans build FRESH L2/L1 instances and reword
            // subtasks, so the memo lives on the run CONTEXT and keys on
            // the OUTPUT: a dispatch whose summary this run has already
            // seen from this skill is a loop, and only the validated LLM
            // loop can adapt. The redundant script run costs two tool
            // calls and zero LLM.
            const memo = (ctx.dispatchedScriptSignatures ??= new Map<string, string[]>());
            const seen = memo.get(skills.skill.id) ?? [];
            // R4: sweep the UNION of all memoised summaries, not just this
            // id's — twin scripts (different ids, same compiledGeneration,
            // same function) coexist in merged catalogs, and the prefilter
            // alternating between them would sidestep an id-keyed memo and
            // re-open the six-identical-dispatches loop through a sibling.
            const seenAnywhere = [...memo.values()].some((list) => list.includes(direct.summary));
            if (seenAnywhere) {
              ctx.logger.info(
                `[${this.name}] skill "${skills.skill.id}" dispatch reproduced an output this run already returned — routing through the validated LLM loop (a deterministic re-run cannot answer a content rejection)`
              );
            } else {
              memo.set(skills.skill.id, [...seen.slice(-7), direct.summary]);
              return direct;
            }
          }
          const matchedScriptId = skills.skill.id;
          const refreshed = this.skillRegistry
            .loadFor(skills.ownerNs)
            .find((candidate) => candidate.id === matchedScriptId);
          if (refreshed) {
            skills = { ...skills, skill: refreshed };
          }
        }

        l1.injectContext(
          skillContextBlock({
            id: skills.skill.id,
            body: skills.skill.body,
            kind: skills.skill.kind,
            ...(skills.skill.language ? { language: skills.skill.language } : {}),
          })
        );
        // The owner namespace rides the instance tag alongside the id —
        // under the lattice it can differ from l1Type.name (donor match).
        l1.setActiveSkill(skills.skill.id, skills.ownerNs);
        // Match + inject are emitted as a paired event sequence so the
        // viz can render either the match decision alone (rare) or the
        // full inject side-effect (common). Keeping them separate also
        // lets a future replay engine elide the inject if it wants to
        // re-run the model with a fresh body.
        ctx.recordSkill?.({
          op: 'inject',
          l1Name: l1Type.name,
          skillId: skills.skill.id,
          actorName: this.name,
          actorTier: 2,
          reasoning: `kind=${skills.skill.kind}${skills.skill.language ? `; language=${skills.skill.language}` : ''}`,
        });
      }
    }

    // Hooks are built HERE (after the match attempt) so the
    // onApproved hook can decide whether to run the C3 skill-
    // learning path: only fire when the prefilter saw skills but
    // none matched, AND the env flag is on, AND the run succeeded
    // without escalation.
    //
    // eventState tracks whether an EVENT-DRIVEN recovery skill got
    // injected during the loop — read by the post-loop learning gate
    // (we only distill a recovery pattern for a NOVEL event, mirroring
    // C3's "we looked and found nothing" rule).
    const eventState = { injected: false };
    const hooks = this.makeL1Hooks(ctx, subtask.description, {
      l1Name: l1Type.name,
      subTask,
      skillMatchAttempted,
      matchedSkillId,
      visibleNamespaces: this.skillRegistry ? visibleNsForHooks : undefined,
      eventState,
    });

    // Fork a branch-scoped ctx so every LLM/tool/trust event recorded
    // inside this supervise loop carries a unique branchId. Viz renders
    // each branch as its own lane instead of interleaving them.
    const branchId = randomUUID();
    const branchInfo = {
      branchId,
      ...(ctx.currentBranchId ? { parentBranchId: ctx.currentBranchId } : {}),
      index: idx,
      total,
      aggregationMode,
      label: subtask.description,
      actorName: this.name,
      actorTier: 2 as const,
    };
    ctx.recordBranch?.({ op: 'start', ...branchInfo });
    const branchCtx = forkBranch(ctx, branchId);
    try {
      const res = await superviseLoop<L1Atom>(this, l1, subTask, branchCtx, hooks);
      // Event-skill distillation (#E1) — a RECOVERED run (rejections in the
      // trace, ultimately approved, not a fallback deliverable) carries the
      // failure→fix delta worth keying on the event signature. Opportunistic:
      // errors are logged and swallowed, the run is already delivered.
      try {
        await this.maybeLearnEventSkill({
          l1Name: l1Type.name,
          subTask,
          res,
          eventSkillInjected: eventState.injected,
          ctx: branchCtx,
        });
      } catch (err) {
        ctx.logger.warn(
          `[${this.name}] event-skill learning attempt errored: ${(err as Error).message}`
        );
      }
      return res;
    } finally {
      ctx.recordBranch?.({ op: 'end', ...branchInfo });
    }
  }


  /** Lazily-built skill lifecycle engine (null when no skill registry). */
  private lifecycleEngine: SkillLifecycle | null = null;
  private lifecycle(): SkillLifecycle | null {
    if (!this.skillRegistry) return null;
    if (!this.lifecycleEngine) {
      this.lifecycleEngine = new SkillLifecycle(
        {
          name: this.name,
          model: this.model,
          params: this.params,
          effectiveSystemPrompt: () => this.effectiveSystemPrompt(),
        },
        this.skillRegistry
      );
    }
    return this.lifecycleEngine;
  }

  private async matchSkill(
    namespaces: readonly string[],
    readerToolNames: readonly string[],
    subTask: Task,
    ctx: RunContext
  ): Promise<{ skill: Skill; ownerNs: string; reasoning: string } | null> {
    return (
      (await this.lifecycle()?.matchSkill(namespaces, readerToolNames, subTask, ctx)) ?? null
    );
  }

  private async learnSkillFromRun(args: {
    l1Name: string;
    subTask: Task;
    result: Result;
    child: L1Atom;
    ctx: RunContext;
    visibleNamespaces?: readonly string[];
  }): Promise<void> {
    await this.lifecycle()?.learnSkillFromRun(args);
  }

  private async improveSkillBody(args: {
    skill: Skill;
    diagnostic: string;
    subtaskDescription: string;
    ctx: RunContext;
  }): Promise<string | null> {
    return (await this.lifecycle()?.improveSkillBody(args)) ?? null;
  }

  /**
   * Post-loop gate for event-skill distillation (#E1). Fires only when
   * ALL of: learning is on (same flag as C3), the run RECOVERED (at
   * least one rejection in the trace, ultimately approved), the
   * deliverable is NOT a parent-fallback (that recovery pattern is
   * "give up and do it yourself" — not guidance worth injecting), and
   * NO event skill was injected during the loop (novel event; if one
   * WAS injected, the recovery is confounded with the existing skill).
   */
  private async maybeLearnEventSkill(args: {
    l1Name: string;
    subTask: Task;
    res: Result;
    eventSkillInjected: boolean;
    ctx: RunContext;
  }): Promise<void> {
    if (process.env['ATOMA_SKILL_LEARN'] !== '1') return;
    if (!this.skillRegistry) return;
    if (args.eventSkillInjected) return;
    if (args.res.producedBy.viaFallback) return;
    if (!resultHasSuccessfulToolAction(args.res)) return;
    const hadRejection = args.res.trace.some(
      (e) =>
        (e.kind === 'verdict-plan' || e.kind === 'verdict-result') &&
        (e.payload as { approved?: boolean } | null)?.approved === false
    );
    if (!hadRejection) return;
    const diagnostic = extractBranchDiagnostic(args.res.trace);
    if (!diagnostic) return;
    await this.lifecycle()?.learnEventSkillFromRecovery({
      l1Name: args.l1Name,
      subTask: args.subTask,
      diagnostic,
      recoverySummary: args.res.summary,
      ctx: args.ctx,
    });
  }

  private async tryPromoteSkill(args: {
    l1Name: string;
    skillId: string;
    subTask: Task;
    result: Result;
    ctx: RunContext;
    hostTools?: readonly string[];
  }): Promise<void> {
    await this.lifecycle()?.tryPromoteSkill(args);
  }

  private async runScriptSkillDirect(
    skill: Skill,
    l1Name: string,
    subTask: Task,
    ctx: RunContext
  ): Promise<Result | null> {
    return (await this.lifecycle()?.runScriptSkillDirect(skill, l1Name, subTask, ctx)) ?? null;
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
      // A previous subtask of THIS plan already resolved the same invented
      // name — reuse its L1 instead of minting a same-labelled clone.
      const aliased = this.planChildAliases.get(subtask.preferredChild);
      if (aliased) {
        const type = this.registry.getByName(aliased);
        if (type && type.tier === 1) {
          ctx.logger.info(
            `[${this.name}] subtask #${idx} preferredChild "${subtask.preferredChild}" → reusing ${aliased} created earlier in this plan`
          );
          return type;
        }
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
      const created = this.createSubtaskL1(subtask, strategy, parentTask);
      this.planChildAliases.set(subtask.preferredChild, created.name);
      return created;
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
      strategy.seed ?? ({ tools: [], params: {} });
    const mergedTools = mergeTools(this.tools, (seed.tools ?? []));
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
    // The GROUND-TRUTH evidence contract is appended to BOTH prompt
    // sources — the planner-authored seed AND the default template. A
    // seed prompt written by Sonnet/Opus never spells out the reporting
    // contract, and an L1 that omits pasted tool outputs gets its
    // (otherwise correct) results rejected by the validator as
    // unverifiable self-reporting (the wc-cli README rejection loop).
    const basePrompt =
      seed.systemPrompt ??
      [
        `You are an L1 molecule with ONE narrow responsibility.`,
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
      ].join('\n');
    return this.registry.create(1, {
      description: resolveCreationDescription(seed.description, mergedTools, 1),
      // Default system prompt emphasises SINGLE-RESPONSIBILITY. A freshly
      // created L1 should be a narrow specialist — one concern, one output
      // shape — not a Swiss-army knife that tries to solve the whole task.
      systemPrompt: [
        basePrompt,
        ``,
        ...GROUND_TRUTH_EVIDENCE_LINES,
        ...(hasValidateHtml ? [``, SMOKE_DESIGN_GUIDANCE] : []),
      ].join('\n'),
      tools: mergedTools,
      params: (seed.params ?? this.params),
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
      /**
       * Id of the skill the prefilter matched for THIS SUBTASK, if any.
       * Subtask-scoped on purpose: `child.activeSkillId()` is an INSTANCE
       * tag that an escalation branch (fresh instance) does not carry, so
       * gating the C3 learner on it alone made every skill-driven-but-
       * escalated run look novel and distill near-duplicates of the very
       * recipe that had matched.
       */
      matchedSkillId?: string;
      /** Visibility-lattice list (home first) — threads to the learn guard (commit C). */
      visibleNamespaces?: readonly string[];
      /** Mutated by the event-skill injector; read by the post-loop learning gate. */
      eventState: { injected: boolean };
    }
  ): SupervisionHooks<L1Atom> {
    // EVENT-DRIVEN recovery injection (#E1). On a rejection (or the
    // escalation branch), match the event text MECHANICALLY (zero LLM —
    // trigger containment, src/skills/events.ts) against the L1's event
    // skills and inject the matched guidance into the next attempt.
    // Namespaced by the ORIGINAL l1 type name so a branched retry keeps
    // access to the recovery catalog its lineage earned. Tracks the
    // instance a skill was injected into: a fresh patch/branch instance
    // loses injected context, so the same skill may re-inject there, but
    // never stacks twice on one instance.
    const injectedEventSkills = new Map<string, L1Atom>();
    const injectEventSkill = (child: L1Atom, eventText: string): void => {
      if (process.env['ATOMA_EVENT_SKILLS'] === '0' || !this.skillRegistry) return;
      if (!eventText.trim()) return;
      const candidates = this.skillRegistry.loadFor(skillCtx.l1Name).filter((s) => s.trigger);
      const match = matchEventSkill(eventText, candidates);
      if (!match || injectedEventSkills.get(match.skill.id) === child) return;
      child.injectContext(eventSkillBlock(match.skill));
      injectedEventSkills.set(match.skill.id, child);
      skillCtx.eventState.injected = true;
      this.skillRegistry.markMatched(skillCtx.l1Name, match.skill.id);
      ctx.logger.info(
        `[${this.name}] event skill "${match.skill.id}" injected into ${child.name} (trigger containment ${match.score.toFixed(2)})`
      );
      ctx.recordSkill?.({
        op: 'inject',
        l1Name: skillCtx.l1Name,
        skillId: match.skill.id,
        actorName: this.name,
        actorTier: 2,
        reasoning: `event-trigger (${match.score.toFixed(2)}): ${eventText.slice(0, 160)}`,
      });
    };
    const rejectionEventText = (verdict: NegativeVerdict): string =>
      [verdict.reasoning, verdict.modifications.additionalContext ?? ''].join('\n');

    return {
      applyByScope: async (child, verdict) => {
        if (verdict.scope === 'ephemeral') {
          child.applyModifications(verdict.modifications);
          injectEventSkill(child, rejectionEventText(verdict));
          return child;
        }
        // patch/branch return a FRESH L1Atom.fromType instance — which
        // starts with NO injected context and a null activeSkillId. When
        // the run was skill-driven, the replacement used to continue
        // WITHOUT the recipe that was steering it (mid-loop amnesia) and,
        // worse, with the attribution cut: onApproved/onFailed read
        // activeSkillId() to bump the SKILL's counters, so the skill that
        // drove a patched run earned nothing (or escaped its failure).
        const carrySkill = (fresh: L1Atom): L1Atom => {
          const skillId = child instanceof L1Atom ? child.activeSkillId() : null;
          if (!skillId) return fresh;
          // Load from the OWNER namespace, not the (possibly branched)
          // child's name — a branched child has no folder of its own and
          // the lookup used to silently miss, cutting the recipe AND the
          // attribution mid-loop.
          const ownerNs =
            (child instanceof L1Atom ? child.activeSkillOwner() : null) ?? child.name;
          const skill = this.skillRegistry?.loadFor(ownerNs).find((k) => k.id === skillId);
          if (skill) {
            fresh.injectContext(skillContextBlock(skill));
            fresh.setActiveSkill(skillId, ownerNs);
          }
          return fresh;
        };
        if (verdict.scope === 'patch') {
          const patched = this.registry.patch(
            child.name,
            verdict.modifications,
            this.name,
            verdict.reasoning
          );
          const fresh = carrySkill(L1Atom.fromType(patched));
          injectEventSkill(fresh, rejectionEventText(verdict));
          return fresh;
        }
        const branched = this.registry.branch(
          child.name,
          verdict.modifications,
          this.name,
          verdict.branchName
        );
        ctx.logger.info(`[${this.name}] branched L1 ${child.name} → ${branched.name}`);
        const freshBranch = carrySkill(L1Atom.fromType(branched));
        injectEventSkill(freshBranch, rejectionEventText(verdict));
        return freshBranch;
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
        //
        // USAGE-CONDITIONED gate: when the last RESULT validator
        // affirmatively observed the child IGNORING the recipe, the
        // diagnosis describes work the skill never drove — a revision
        // against it would corrupt a recipe that was never tried, and
        // the save() would clear the promotion-refusal stamp for a body
        // change the failure never justified. Skip straight to the
        // legacy registry-branch path (which fixes the ATOM, the thing
        // that actually failed).
        const activeSkillId = child.activeSkillId();
        // The revision must target the recipe that actually DROVE the run —
        // the owner namespace. `child.name` diverges from it whenever the
        // child was branched mid-loop (the lookup used to miss and skip the
        // revision silently) and, under the shared catalog, whenever the
        // match came from a donor namespace.
        const activeSkillNs = child.activeSkillOwner() ?? child.name;
        const skillWasIgnored = lastResultVerdictSkillFollowed(trace) === false;
        if (activeSkillId && skillWasIgnored) {
          ctx.logger.info(
            `[${this.name}] skill ${activeSkillId} revision SKIPPED: validator observed the failing run did not follow the recipe — falling through to the registry-branch path`
          );
        }
        if (activeSkillId && !skillWasIgnored && this.skillRegistry && diagnostic.length > 0 && childType) {
          const skills = this.skillRegistry.loadFor(activeSkillNs);
          const oldSkill = skills.find((s) => s.id === activeSkillId);
          if (oldSkill) {
            try {
              const newBody = await this.improveSkillBody({
                skill: oldSkill,
                diagnostic,
                subtaskDescription,
                ctx,
              });
              // An UNCHANGED body is a legitimate answer (the prompt tells
              // the model to return it as-is when the failure was
              // environmental) — but saving it would be actively harmful:
              // `save()` clears the promotion-refusal stamp on the premise
              // that the body changed, and retrying an identical recipe
              // against an identical diagnosis is a guaranteed-identical
              // outcome. Treat it as "no revision available" and let the
              // legacy branch path take over.
              let revised =
                newBody && newBody.trim() !== oldSkill.body.trim() ? newBody : null;
              if (!revised && newBody) {
                ctx.logger.info(
                  `[${this.name}] skill ${activeSkillId} revision returned an UNCHANGED body (environmental failure?) — skipping the save and the retry`
                );
              }
              // F2's filter applies to REVISIONS too (adversarial-review
              // finding): a diagnosis like "the UI was never independently
              // verified" invites Sonnet to append a step using a tool the
              // host cannot call — and save() would both persist the phantom
              // and clear the promotion-refusal stamp. Same fail-open shape
              // as the draft filter: no revision → legacy branch path.
              if (revised) {
                const outOfScope = undeclaredToolMentions(revised, child.toolNames());
                if (outOfScope.length > 0) {
                  ctx.logger.warn(
                    `[${this.name}] skill ${activeSkillId} revision rejected: teaches undeclared tool(s) ${outOfScope.join(', ')} — treating as no revision`
                  );
                  revised = null;
                }
              }
              if (revised) {
                const newBody = revised;
                this.skillRegistry.save(activeSkillNs, {
                  id: oldSkill.id,
                  description: oldSkill.description,
                  whenToUse: oldSkill.whenToUse,
                  kind: oldSkill.kind,
                  ...(oldSkill.language ? { language: oldSkill.language } : {}),
                  body: newBody,
                }, { mechanism: 'revised', model: this.model });
                ctx.logger.warn(
                  `[${this.name}] skill ${activeSkillId} (owner ${activeSkillNs}) updated after escalation (${reason}); retrying L1 with new body`
                );
                ctx.recordSkill?.({
                  op: 'update',
                  l1Name: activeSkillNs,
                  skillId: activeSkillId,
                  actorName: this.name,
                  actorTier: 2,
                  reasoning: diagnostic.slice(0, 400),
                });
                const fresh = L1Atom.fromType(childType);
                fresh.injectContext(
                  skillContextBlock({
                    id: activeSkillId,
                    body: newBody,
                    kind: oldSkill.kind,
                    ...(oldSkill.language ? { language: oldSkill.language } : {}),
                  })
                );
                fresh.setActiveSkill(activeSkillId, activeSkillNs);
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
        const freshBranched = L1Atom.fromType(branched);
        // Event-driven recovery guidance rides along with the diagnostic:
        // the branch prompt says WHAT failed, a matched event skill says
        // what a previous recovery DID about it.
        injectEventSkill(freshBranched, diagnostic);
        return freshBranched;
      },
      onApproved: async (child, result, verdict) => {
        this.registry.recordSuccess(child.name, this.name);
        // Skill trust counter bump (C2a). When the supervise loop
        // approves a result and a skill drove the run, record a
        // success on the skill itself — this is what lets future
        // runs "trust" the skill more, and (in a follow-up) lets
        // the system identify mature skills worth promoting from
        // hand-written to auto-managed.
        //
        // USAGE-CONDITIONED CREDIT: the bump is withheld when the RESULT
        // validator affirmatively reported the child IGNORED the injected
        // recipe (`activeSkillFollowed === false`). A run the skill did not
        // drive proves nothing about the skill, and unearned successes arm
        // the promotion trigger on recipes that never demonstrably
        // worked. `undefined` (no signal — trust fast-path, legacy verdict,
        // model omission) keeps the legacy bump: false is an AFFIRMATIVE
        // observation, absence of evidence is not evidence of free-riding.
        const skillId = child.activeSkillId();
        // Credit lands on the OWNER namespace — where the folder and the
        // counters live. Reading the pair from the INSTANCE (not skillCtx)
        // is the R2 guard: the legacy-branch path returns an untagged
        // instance, so a run the branch delivered without the recipe
        // credits nothing.
        const skillNs = child.activeSkillOwner() ?? child.name;
        if (skillId && this.skillRegistry && verdict?.activeSkillFollowed === false) {
          ctx.logger.info(
            `[${this.name}] skill "${skillId}" credit WITHHELD on ${child.name}: validator observed the run did not follow the recipe`
          );
          ctx.recordSkill?.({
            op: 'credit-withheld',
            l1Name: skillNs,
            skillId,
            actorName: this.name,
            actorTier: 2,
            reasoning: 'succès NON crédité — le validateur a observé que le run n\'a pas suivi la recette',
          });
        } else if (skillId && this.skillRegistry) {
          this.skillRegistry.recordSuccess(skillNs, skillId, { via: child.name });
          ctx.recordSkill?.({
            op: 'success',
            l1Name: skillNs,
            skillId,
            actorName: this.name,
            actorTier: 2,
          });
          // Skill llm→script PROMOTION (#C2c). After bumping the
          // success counter, check whether this skill has crossed the
          // promotion threshold. The eligibility gate inside
          // tryPromoteSkill is cheap (counter read) and short-circuits
          // before any Sonnet call, so this is safe to run on every
          // approved skilled run. Failures inside the helper are
          // logged + swallowed — promotion is opportunistic.
          try {
            await this.tryPromoteSkill({
              l1Name: skillNs,
              skillId,
              subTask: skillCtx.subTask,
              result,
              ctx,
              // R3: the promotion scan is a property of the ARTEFACT+HOME,
              // deterministic across crediting hosts — a permissive reader
              // must not admit a compiled body that its file-scribe owner's
              // scan would refuse (order-dependent bifurcated trust).
              hostTools: (this.registry.getByName(skillNs)?.tools ?? []).map((t) => t.name),
            });
          } catch (err) {
            ctx.logger.warn(
              `[${this.name}] skill promotion attempt errored: ${(err as Error).message}`
            );
          }
        } else if (
          // Skill auto-creation (C3). Fires when ALL of:
          //   - L2 attempted a skill match for this subtask;
          //   - no skill matched (the run was novel);
          //   - the run was approved (i.e. it's a clean reusable pattern);
          //   - the env flag ATOMA_SKILL_LEARN is on. Direct library use is
          //     opt-in; runTask sets it on by default unless disabled because
          //     forgetting the flag was the measured dominant failure mode.
          !skillId &&
          // Both scopes must be empty: no tag on the approved INSTANCE and
          // no match recorded for the SUBTASK. After an escalation branch
          // the instance tag is gone while the subtask fact remains — a run
          // where a recipe matched is not novel, whatever instance finished
          // it (learning there distilled near-duplicate skills that then
          // competed with the matched one in the prefilter).
          !skillCtx.matchedSkillId &&
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
              ...(skillCtx.visibleNamespaces
                ? { visibleNamespaces: skillCtx.visibleNamespaces }
                : {}),
            });
          } catch (err) {
            ctx.logger.warn(
              `[${this.name}] skill auto-creation failed: ${(err as Error).message}`
            );
          }
        }
      },
      onFailed: async (child, _reason, lastResultVerdict) => {
        this.registry.recordFailure(child.name, this.name);
        // USAGE-CONDITIONED BLAME (mirror of onApproved's credit gate, and
        // the more damaging direction): a failure recorded against a skill
        // the child visibly ignored is unearned — and `failures > 0` blocks
        // promotion PERMANENTLY until an operator `skills reset`. Withhold
        // the blame (and the demotion check, whose premise "the script
        // proved fragile" is equally false) when the last RESULT validator
        // affirmatively reported non-adherence. The atom-type failure above
        // still counts: the CHILD did fail, whatever it was following.
        const skillId = child.activeSkillId();
        // Blame lands on the OWNER namespace, symmetric with the credit
        // side (R2): read the pair from the instance, never from context.
        const blameNs = child.activeSkillOwner() ?? child.name;
        if (skillId && this.skillRegistry && lastResultVerdict?.activeSkillFollowed === false) {
          ctx.logger.info(
            `[${this.name}] skill "${skillId}" blame WITHHELD on ${child.name}: validator observed the run did not follow the recipe`
          );
          ctx.recordSkill?.({
            op: 'credit-withheld',
            l1Name: blameNs,
            skillId,
            actorName: this.name,
            actorTier: 2,
            reasoning: 'échec NON imputé — le validateur a observé que le run n\'a pas suivi la recette',
          });
        } else if (skillId && this.skillRegistry) {
          this.skillRegistry.recordFailure(blameNs, skillId, { via: child.name });
          ctx.recordSkill?.({
            op: 'failure',
            l1Name: blameNs,
            skillId,
            actorName: this.name,
            actorTier: 2,
          });
          // Skill DEMOTION (#C2c). If a `kind: 'script'` skill drove
          // the run that just escalated, restore its original llm
          // body from the `_fallback.md` sidecar. The script form
          // proved fragile on this task; reverting to the LLM-driven
          // recipe lets future runs adapt where the fixed script
          // couldn't. The `failures > 0` clause inside tryPromoteSkill
          // then blocks accidental re-promotion until counters are
          // reset by the operator.
          const matched = this.skillRegistry.loadFor(blameNs).find((s) => s.id === skillId);
          if (matched && matched.kind === 'script' && matched.fallbackBody) {
            const restored = this.skillRegistry.demoteToLlm(blameNs, skillId);
            if (restored) {
              ctx.logger.info(
                `[${this.name}] skill "${skillId}" demoted to kind:llm after script failure`
              );
              ctx.recordSkill?.({
                op: 'demote',
                l1Name: blameNs,
                skillId,
                actorName: this.name,
                actorTier: 2,
                reasoning: `script failed; restored ${matched.fallbackBody.length}-char fallback`,
              });
            }
          }
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
    const evidence = subResults.flatMap((result) => result.evidence ?? []);
    const evidenceField = evidence.length > 0 ? { evidence } : {};
    if (aggregation.mode === 'sequential') {
      // Phased pipeline: the FINAL phase carries the deliverable. See
      // L3Atom.aggregate sequential branch for full rationale.
      const last = subResults[subResults.length - 1]!;
      const phaseSummaries = subResults
        .map((r, i) => `phase #${i + 1} (${r.producedBy.name}): ${r.summary}`)
        .join(' | ');
      return {
        output: last.output,
        summary: `${subResults.length} sequential phases — final: ${last.summary}. Trace: ${phaseSummaries}`,
        trace: [],
        producedBy: { tier: 2, name: this.name, viaFallback: false },
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
        producedBy: { tier: 2, name: this.name, viaFallback: false },
        ...evidenceField,
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
      ...evidenceField,
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
      `You are cell "${this.name}" (tier 2) in FALLBACK mode: do the task yourself, no delegation.`,
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
      // Tool-bearing fallback is an L1 execution role even though the
      // supervising object is L2. Codex routes are text-only at tiers 2/3 and
      // structurally refuse tool loops, which turned the final recovery path
      // into an instant provider error on a live web run.
      model: hasTools ? modelForTier(1) : this.model,
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
    // Mechanical toolset pre-check — BEFORE every fast-path on purpose:
    // a trusted OR prefilter-synthesised off-scope plan would otherwise be
    // approved blind. The prefilter copies task text into its skeletal plan,
    // so user-authored undeclared tool names can reach this path too.
    // Zero LLM cost; the F1 fix's cheap half (app-task-tracker run: a plan
    // promised validate_html seven times on an HTTP-bucket child, the
    // validator approved, and the verification phase silently never ran).
    const offScope = undeclaredToolMentions(JSON.stringify(plan), child.toolNames(), {
      minNonNegated: 2,
    }).filter((tool) => {
      // ONE-SHOT per (subtask, tool): a byte-identical mechanical rejection
      // repeated 3× trips the repeat tracker and escalates a healthy child
      // whose subtask text itself carries the tool name (guest-counter
      // retry, 2026-08-08: $2.03 vs $0.40 siblings). After the free coached
      // rejection, the LLM validator — which sees the declared toolset and
      // the echo-vs-intent nuance — takes over.
      const key = `${tool}|${task.description.slice(0, 120)}`;
      if (ctx.mechanicalPlanRejections?.has(key)) return false;
      (ctx.mechanicalPlanRejections ??= new Set()).add(key);
      return true;
    });
    if (offScope.length > 0) {
      const declared = child.toolNames().join(', ') || '(none)';
      ctx.logger.warn(
        `[${this.name}] plan for ${child.name} references undeclared tool(s) ${offScope.join(', ')} — mechanically rejected (0 LLM calls)`
      );
      return {
        approved: false,
        reasoning: `plan references tool(s) outside the child's declared toolset: ${offScope.join(', ')} — the executor would refuse those calls and the work would silently not happen`,
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            `Your ONLY executable tools are: ${declared}. The previous plan referenced ` +
            `${offScope.join(', ')}, which you cannot call. Re-plan using declared tools only, ` +
            `and do not mention undeclared tools at all — not even to defer them. If part of the ` +
            `task seems to require an undeclared tool, do what IS achievable in scope and state ` +
            `the limit explicitly in your result instead of promising the unachievable.`,
        },
      };
    }
    // Prefilter fast-path: after the zero-cost scope gate, a plan synthesised
    // by the Haiku capability match needs no second Haiku verdict.
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
    if (
      ctx.requireObservedToolAction === true &&
      result.toolCallResults !== undefined &&
      !resultHasSuccessfulToolAction(result)
    ) {
      ctx.logger.warn(
        `[${this.name}] result from ${child.name} reports no successful observed tool action — mechanically rejected before trust/LLM validation`
      );
      return {
        approved: false,
        reasoning:
          'the L1 result was produced without any successful tool action observed by the transport, so its file/execution claims are unsupported narrative',
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'No successful tool action was observed. Actually perform the subtask with your declared tools, verify the artefact, and only then return the result JSON. Do not describe intended work as completed.',
        },
      };
    }
    const requiredCommandMismatch = await checkRequiredCommandManifest(task, ctx);
    if (requiredCommandMismatch) {
      return {
        approved: false,
        reasoning: requiredCommandMismatch,
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'Fix the exact required finite test/probe script instead of substituting a different harness. Run it through record_probe until that same command exits 0; its manifest entry must be replaced with the successful observation before returning.',
        },
      };
    }
    const portableDocsMismatch = await checkRequiredPortableHttpDocs(task, ctx);
    if (portableDocsMismatch) {
      return {
        approved: false,
        reasoning: portableDocsMismatch,
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'Replace every durable numeric localhost port and LISTENING_ON_PORT number in README.md with <port>. Keep live numeric URLs only in run evidence, then read README.md back before returning.',
        },
      };
    }
    if (result.summary.startsWith(NON_JSON_PAYLOAD_SUMMARY_PREFIX)) {
      ctx.logger.warn(
        `[${this.name}] result from ${child.name} used the tolerant non-JSON wrapper — mechanically rejected before trust/LLM validation`
      );
      return {
        approved: false,
        reasoning:
          'the L1 completed tool work but did not emit the required final {"output","summary"} JSON envelope',
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'Your tool work may already be complete. Do not call a return/output tool and do not narrate the result as prose. Emit one final JSON object directly as assistant text: {"output": <actual result>, "summary": "<evidence-backed summary>"}.',
        },
      };
    }
    if (result.summary.startsWith(INTERNAL_VALIDATION_FAILED_PREFIX)) {
      ctx.logger.warn(
        `[${this.name}] result from ${child.name} reports an internal validation failure — mechanically rejected before trust/LLM validation`
      );
      return {
        approved: false,
        reasoning:
          'the L1 result explicitly reports that its final validate_html call failed',
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'Your last validate_html result was not ok. Read its exact errors/smokeResult, fix the artefact or the assertion, and re-run validation until ok:true before returning the final JSON.',
        },
      };
    }
    const jsonShapeMismatch = await checkRecordedJsonShape(task, result, ctx);
    if (jsonShapeMismatch) {
      ctx.logger.warn(
        `[${this.name}] result from ${child.name} contradicts the task's requested JSON container shape — mechanically rejected before trust/LLM validation`
      );
      return {
        approved: false,
        reasoning: jsonShapeMismatch,
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'The successful recorded stdout has the wrong JSON container shape. Preserve the verified values and ordering, but emit exactly the requested JSON object or JSON array, then re-run every success probe and return their new real stdout.',
        },
      };
    }
    if (
      child.toolNames().includes('validate_html') &&
      webStylingEvidenceMissing(task, result)
    ) {
      return {
        approved: false,
        reasoning:
          'the task requires conditional styling, but the recorded browser probe contains no class/style/color milestone evidence',
        scope: 'ephemeral',
        modifications: {
          additionalContext:
            'Return milestone and reset snapshots containing the actual class/style/color values, and make ok assert the expected transition. State counters or labels alone do not verify conditional styling.',
        },
      };
    }
    const activeSkillId = child.activeSkillId();
    const activeSkill =
      activeSkillId && this.skillRegistry
        ? this.skillRegistry
            .loadFor(child.activeSkillOwner() ?? child.name)
            .find((s) => s.id === activeSkillId)
        : undefined;
    const activeScriptSkillIgnored =
      activeSkill?.kind === 'script' && result.activeScriptSkillExecuted !== true;
    const type = this.registry.getByName(child.name);
    // The trust fast-path skips the LLM validator — but it must NOT skip the
    // ground-truth probe. The probe costs zero tokens (local fs / one page
    // load), so the cheapest path has no excuse to be the blindest one, and a
    // trusted type is precisely the one nobody is watching any more. Observed
    // on the json-cli run: Lithium at 6/0 and Ammonia at 8/0 meant ZERO
    // validation calls for the whole run, so the read-back probe never fired
    // and a RESULT claiming "exit code 1" shipped while the CLI actually
    // exits 0. Hard contradictions AND mechanically broken evidence
    // interfaces hand the decision to the LLM validator (passing the block
    // along so the probe doesn't run twice) rather than rejecting outright —
    // a path-extraction heuristic or malformed manifest must never fail a run
    // on its own.
    let trustedProbe: GroundTruthCheck | null = null;
    if (type && shouldTrustType(type)) {
      trustedProbe = await checkGroundTruth({
        ctx,
        subject: 'RESULT',
        payload: result,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        child,
      });
      if (!trustedProbe.requiresReview) {
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
        return activeScriptSkillIgnored
          ? { ...approval, activeSkillFollowed: false }
          : approval;
      }
      const reviewReason = trustedProbe.contradiction
        ? 'ground-truth evidence contradicts the RESULT'
        : 'ground-truth evidence requires review (manifest or durable HTTP docs)';
      ctx.logger.warn(
        `[${this.name}] trust fast-path OVERRIDDEN for ${child.name} (${type.successes}✓/${type.failures}✗): ${reviewReason} — falling through to a full verdict`
      );
    }
    // Usage-conditioned skill credit: when a skill drove this run, show the
    // validator the recipe and ask for the `activeSkillFollowed` adherence
    // signal alongside the verdict. The onApproved/onFailed hooks gate the
    // skill's counter bumps on it — a child that ignored the recipe proves
    // nothing about it, and unearned successes arm the promotion trigger.
    const verdict = await llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 2,
      subject: 'RESULT',
      child,
      ...(trustedProbe ? { groundTruthBlock: trustedProbe.block } : {}),
      ...(activeSkill ? { activeSkill: { id: activeSkill.id, body: activeSkill.body } } : {}),
      task,
      payload: { output: result.output, summary: result.summary },
      ...(result.evidence ? { evidence: result.evidence } : {}),
    });
    return activeScriptSkillIgnored
      ? { ...verdict, activeSkillFollowed: false }
      : verdict;
  }
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




