import { z } from 'zod';
import type { AtomType } from '../registry/atomRegistry.js';
import type {
  GenerationParams,
  PositiveVerdict,
  RunContext,
  Task,
  Tier,
} from '../core/types.js';
import { modelForTier } from '../core/models.js';
import { parseWith } from './json.js';
import { prefilterCacheGet, prefilterCacheKey, prefilterCachePut } from './prefilterCache.js';

/**
 * A child type is "trusted" when it has accumulated enough clean successes to
 * skip the validator LLM call. Any failure resets trust until the counter
 * passes the threshold again.
 *
 * Bumping this raises safety at the cost of paying validator calls longer;
 * lowering it saves money but lets a newer type coast on thinner evidence.
 */
export const TRUST_THRESHOLD_SUCCESSES = 3;

/**
 * Operator overrides for the three lifecycle thresholds, read at CALL time
 * so a single run can be made more (or less) cautious without a rebuild:
 *   ATOMA_TRUST_THRESHOLD   → successes before validators are skipped (3)
 *   ATOMA_PROMOTE_THRESHOLD → successes before llm→script compilation (3)
 *   ATOMA_DEMOTE_AFTER      → deterministic failures before demotion (2)
 * Invalid or non-positive values fall back to the default rather than
 * disabling a safety gate — a typo must never make the system LESS careful.
 * The constants above remain the documented defaults and the values tests
 * assert against.
 */
function envThreshold(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Successes (with zero failures) before a type/skill skips validation. */
export function trustThreshold(): number {
  return envThreshold('ATOMA_TRUST_THRESHOLD', TRUST_THRESHOLD_SUCCESSES);
}

/** Successes (with zero failures) before an llm skill attempts compilation. */
export function promoteThreshold(): number {
  return envThreshold('ATOMA_PROMOTE_THRESHOLD', TRUST_PROMOTE_THRESHOLD_SUCCESSES);
}

/** Consecutive deterministic failures before a script skill is demoted. */
export function demoteAfter(): number {
  return envThreshold('ATOMA_DEMOTE_AFTER', DIRECT_DISPATCH_DEMOTE_AFTER);
}

/**
 * When an `kind: 'llm'` skill crosses this many SUCCESSES with zero
 * recorded failures, the supervisor will attempt to PROMOTE it to a
 * deterministic `kind: 'script'` body via a Sonnet compile call. The
 * promoted skill executes via a single LLM round-trip + write_file +
 * run_shell instead of a full LLM-driven recipe each time, cutting
 * Haiku tool-loop spend on stable patterns. Demotion (any future
 * failure on the script form) restores the original llm body from a
 * sidecar `_fallback.md` and increments `failures`; the `failures > 0`
 * gate then blocks re-promotion until the operator manually resets the
 * counters or deletes the skill. Five was the original pick (matching
 * the trust level observed on the LoL-SSR run's
 * `scaffold-node-ssr-sqlite-api` skill, 5/2 lifetime); lowered to THREE
 * after the 2026-08-07 threshold experiment (batches 14-15, run under
 * ATOMA_PROMOTE_THRESHOLD=3): across every compile attempt of the
 * campaign the success count NEVER changed the compiler's verdict —
 * compilable recipes compiled at their first attempt and irreducible-
 * reasoning recipes were refused with the same rationale at any count —
 * so the extra two runs only delayed the outcome (~$0.60-1 + two runs of
 * latency per lineage) while the downstream gates (compiler refusal,
 * static scan, generation-stamped anti-thrash, post-promotion counter
 * RESET + re-earned trust, deliverable gate, demotion streak) carry the
 * actual safety. The count still matters as a match-surface sample for
 * LEARNED skills; three matched-and-credited runs proved sufficient to
 * expose a bad surface in practice (free-ride gap + `skills stats`).
 */
export const TRUST_PROMOTE_THRESHOLD_SUCCESSES = 3;

/**
 * Consecutive DETERMINISTIC dispatch failures (non-zero exit or missing
 * stdout envelope) after which a `kind: script` skill is demoted back to
 * its llm fallback. Deterministic failures deliberately do NOT bump the
 * trust failure counter (they fall back to the validated LLM loop, which
 * usually still delivers), but without this bound a structurally brittle
 * script — one whose extraction logic cannot survive real input variance —
 * fails on EVERY match forever: it never escalates (so `demoteToLlm` on
 * the onFailed path is unreachable) and never improves, and each match
 * pays two wasted tool calls plus the full LLM fallback. Demonstrated by
 * the slugify rehearsal run (2026-07-28): the compiled reverify script
 * amputated quoted CLI arguments, deduped four documented invocations
 * into one bare command, and reported a phantom mismatch — it would have
 * done so on every future CLI README as well. Reset by a deterministic
 * SUCCESS (not by an LLM-loop success, which proves nothing about the
 * script).
 */
export const DIRECT_DISPATCH_DEMOTE_AFTER = 2;

/**
 * Own abort budget for POST-APPROVAL bookkeeping LLM calls (skill
 * distillation in `learnSkillFromRun`, llm→script compilation in
 * `compileSkillToScript`) — deliberately DECOUPLED from the run's
 * deadline signal. By the time these calls fire, the deliverable is
 * already approved: killing a compile to protect the run budget
 * protects nothing, and it kept happening — three separate incidents
 * of the run deadline landing mid-compile under the claude-cli
 * transport, the last one leaving a run HUNG with no endedAt after
 * the aborted subprocess (http-ping closer, 2026-08-03). The
 * trade-off is explicit: a run may extend past its deadline by at
 * most this budget while bookkeeping completes. `improveSkillBody`
 * deliberately KEEPS the run signal — it gates an escalation retry,
 * i.e. the deliverable itself.
 */
export const POST_APPROVAL_LLM_TIMEOUT_MS = 240_000;

/**
 * BUDGETS PER CONCERN (P4). A run carries several kinds of work whose
 * abort semantics differ, and sharing one deadline caused three live
 * incidents (a compile killed mid-flight left a run hung with no
 * endedAt). The taxonomy:
 *   - DELIVERABLE work (plans, executions, validations, escalation
 *     retries incl. improveSkillBody) rides ctx.signal — the run
 *     deadline gates the deliverable.
 *   - POST-APPROVAL BOOKKEEPING (distillation, compilation) rides
 *     THIS signal: by the time it fires the deliverable is approved,
 *     so the run budget protects nothing there and killing the work
 *     only discards paid-for learning.
 *   - VERIFICATION probes are local fs/network reads that honour
 *     ctx.signal (they gate the deliverable's verdict).
 * Trade-off, explicit: a run may extend past its deadline by at most
 * POST_APPROVAL_LLM_TIMEOUT_MS while bookkeeping completes. A hard
 * process kill still reaps everything — this signal only decouples the
 * SOFT deadline. Always obtain the signal through this helper so the
 * decoupling stays visible and greppable at every call site.
 */
export function postApprovalSignal(): AbortSignal {
  return AbortSignal.timeout(POST_APPROVAL_LLM_TIMEOUT_MS);
}

/**
 * Cap on output tokens for supervisor-tier strategy/plan calls (L2.plan /
 * L3.plan on non-fallback path). The response is a JSON pair [strategy, plan]
 * + a list of subtasks with descriptions. Sized to fit a 3-5 phase PHASED
 * plan from Opus with detailed phase descriptions; before phasing landed a
 * 1500-token cap was enough but multi-phase plans on stack tasks (SSR app
 * with SQLite + external API + UI) blew past it and produced truncated
 * `expectedOutput` fields that crashed the planSchema parse.
 * `expectedOutput` and `aggregation` are now also defaulted in planSchema
 * (defence in depth) — but the right place to fix it is at the source.
 *
 * 8000, not the historical 3000: Opus 5 / Sonnet 5 run ADAPTIVE THINKING
 * by default and `max_tokens` caps thinking + response TOGETHER — a
 * 3000 cap can be consumed entirely by thinking before a single plan
 * token is emitted. This is a CAP, not a target: you only pay for what
 * the model actually generates, and the plan call sites pin
 * `effort: 'medium'` which keeps thinking volume modest.
 *
 * Fallback / self-exec calls still use the atom's configured maxTokens
 * because they may produce actual content, not routing JSON.
 */
export const STRATEGY_MAX_TOKENS = 8000;

export function shouldTrustType(type: AtomType): boolean {
  return type.failures === 0 && type.successes >= trustThreshold();
}

/**
 * Same trust contract, applied to a SKILL's own counters. Gates the
 * deterministic dispatch of `kind: 'script'` skills in `L2.runSubtask`:
 * a trusted script runs via write_file + run_shell with ZERO LLM calls
 * (no L1 plan/execute, no validators). Note that promotion already
 * requires TRUST_PROMOTE_THRESHOLD_SUCCESSES (3) clean runs, so every
 * freshly promoted script qualifies immediately; hand-written scripts
 * must first earn 3 clean runs through the normal LLM loop.
 */
export function shouldTrustSkill(skill: { successes: number; failures: number }): boolean {
  return skill.failures === 0 && skill.successes >= trustThreshold();
}

/** Synthetic verdict returned by the trust fast-path in place of an LLM call. */
export function trustedApproval(type: AtomType): PositiveVerdict {
  return {
    approved: true,
    reasoning: `trust fast-path: ${type.name} has ${type.successes} successes / ${type.failures} failures`,
  };
}

/**
 * One shared system prompt for all prefilter calls — constant across tiers and
 * tasks so prompt caching short-circuits the input bill. This is the cheapest
 * atom doing the cheapest decision: "is there a clear catalog match?"
 *
 * Note on stability: this string is a cache key for Haiku. Trimming it below
 * the 4096-token threshold silently disables caching (see AGENTS.md). When
 * adding rules here, prefer appending terse lines over rewriting — the total
 * mass preserves cache hits across runs.
 */
export const PREFILTER_SYSTEM_PROMPT = [
  'You pre-filter catalog lookups for a three-tier LLM orchestrator.',
  'Given a task and a catalog of child atom types, pick ONE that clearly fits,',
  'or declare that no clear match exists.',
  'You do NOT design new types, you do NOT call tools, you do NOT produce plans.',
  'Bias strongly toward escalation when in doubt — escalation to the supervisor',
  'is cheap relative to selecting a wrong type and burning a full supervision cycle.',
  '',
  'HARD RULE on single-candidate catalogs:',
  '  A catalog with only ONE candidate is NOT a reason to pick it. The',
  '  candidate must CLEARLY share the task\'s structural capability (e.g. the',
  '  task needs an HTTP server builder, the candidate\'s description explicitly',
  '  names HTTP server building). If the single candidate\'s description names',
  '  a different structural capability than the task requires (HTML rendering',
  '  vs HTTP API, file scribe vs validation loop, etc.), escalate. Never',
  '  force-match just because the catalog is small.',
  '',
  'L1-affinity rule (applies to L2/L3 catalogs):',
  '  A catalog entry may include a "REACHABLE L1 CHILDREN" block listing',
  '  the lower-tier atoms that entry can dispatch to. When present, those',
  '  children\'s capabilities count for the MATCH decision — an L2 whose own',
  '  description names a narrow bucket (e.g. "HTTP server orchestrator") can',
  '  STILL be a valid "reuse" pick if its REACHABLE L1 CHILDREN cover the',
  '  task\'s needs (e.g. a file-scribe L1 child matches a README/JSON-writing',
  '  task, even though the parent L2 is HTTP-flavoured). Do NOT escalate on',
  '  "L2 description too narrow" when the children fill the gap.',
  '',
  'Confidence self-check:',
  '  When you choose "reuse", label your OWN confidence in the fit:',
  '    - "high" — candidate description and task share the SAME structural',
  '      capability (tool signature + workflow shape). The candidate can',
  '      plausibly execute this task end-to-end without domain reprogramming.',
  '    - "low"  — you picked it because it was the closest available, but',
  '      the fit is approximate (different domain, missing capability, or',
  '      genuine doubt). The caller will treat "low" AS escalate — so if',
  '      you would label it "low" anyway, prefer emitting "escalate" directly.',
  '  Missing confidence is treated as "low" (conservative default).',
  '',
  'Decomposability hint (reuse only):',
  '  The default caller behaviour on "reuse" is to hand the ENTIRE task to',
  '  the chosen child as a single subtask (skipping the full supervisor',
  '  plan call). That is correct for atomic tasks AND for composite tasks',
  '  whose artefacts are mutually coupled.',
  '  Set "decomposable": false (or omit) when ANY of:',
  '    - the task is a single artefact (one file, one page, one service).',
  '    - the artefacts share imports or references: e.g. a test file',
  '      imports the library under test, a package.json "scripts.test"',
  '      points at the test file, a README documents the exported API.',
  '      These are STRUCTURALLY COUPLED — building them in parallel on',
  '      separate L1 instances forces each instance to guess the same',
  '      API surface, risks divergence, and typically produces less',
  '      code than a single sequential L1 that writes all files in one',
  '      tool-loop. Rule of thumb: if the artefacts are part of ONE',
  '      coherent project deliverable (library + tests + docs, server',
  '      + client code that imports it, config + code that reads it),',
  '      they are COUPLED → decomposable=false.',
  '  Set "decomposable": true ONLY when the artefacts are GENUINELY',
  '  ORTHOGONAL — no shared types, no cross-references, no depends-on.',
  '  Example decomposable:true cases: "build three unrelated puzzle',
  '  games in three index.html files", "scrape three separate websites',
  '  and save each dataset to its own JSON". Be CONSERVATIVE — default',
  '  is false, and the caller will still decompose via its full Sonnet/',
  '  Opus plan call when true independence is present in the task shape.',
  '',
  'Respond with ONE JSON object, no prose, no markdown, starting with "{":',
  '  {"kind": "reuse", "target": "<exact catalog name>", "confidence": "high"|"low", "decomposable": true|false, "reasoning": "<one short sentence>"}',
  'OR',
  '  {"kind": "escalate", "reasoning": "<one short sentence>"}',
].join('\n');

/**
 * Dedicated system prompt for the SKILL prefilter (L2.matchSkill). Constant
 * for the same prompt-caching reason as PREFILTER_SYSTEM_PROMPT.
 *
 * Why not reuse PREFILTER_SYSTEM_PROMPT: that prompt is written for ATOM
 * catalogs and carries a HARD RULE against single-candidate force-matching
 * (an atom mismatch burns a full supervision cycle). For skills the economics
 * are inverted — a young skill library usually has exactly ONE recipe, and
 * that recipe exists precisely because a task like this one succeeded before.
 * Under the atom prompt, Haiku escalated on single-skill catalogs, the run
 * lost the injection, and the "learn" branch then paid a Sonnet call to
 * distill a skill that already existed (deduped only after the money was
 * spent). The L1-affinity and decomposable clauses are likewise meaningless
 * for skills, so they're gone here. The confidence self-check stays: the
 * low→escalate guard in `prefilterStrategy` applies uniformly to both prompts.
 */
export const SKILL_PREFILTER_SYSTEM_PROMPT = [
  'You match a subtask against a catalog of learned skills — reusable how-to',
  'recipes attached to the worker atom that will execute the task.',
  'Pick the ONE skill whose recipe would genuinely guide this task, or declare',
  'that none fits.',
  'You do NOT design new skills, you do NOT call tools, you do NOT produce plans.',
  '',
  'What a match means: the matched skill body is INJECTED into the worker\'s',
  'system prompt as an active recipe. A fitting recipe saves the worker from',
  're-deriving a known workflow; a WRONG recipe actively misleads it.',
  '"escalate" simply means the worker runs unguided — safe, but wasteful when',
  'a fitting recipe exists.',
  '',
  'Single-candidate catalogs are NORMAL here: a young skill library often has',
  'exactly one recipe, and that recipe usually exists BECAUSE a task like this',
  'one succeeded before. "Only one candidate" is NOT a reason to escalate —',
  'judge the fit on its own merits, exactly as you would among ten candidates.',
  '',
  'Match on WORKFLOW SHAPE, not on surface domain words:',
  '  - "reuse" when the recipe\'s steps (files to write, tools to run, checks',
  '    to perform) transfer to this task even if the topic differs — a recipe',
  '    learned on a movie API applies to a book API.',
  '  - "escalate" when the recipe\'s workflow is structurally different — it',
  '    scaffolds an HTTP server but the task writes a static page; it seeds a',
  '    database but the task scrapes a website.',
  '',
  'Confidence self-check:',
  '  When you choose "reuse", label your OWN confidence in the fit:',
  '    - "high" — the recipe\'s workflow clearly covers this task end-to-end',
  '      or nearly so.',
  '    - "low"  — closest available, but the fit is approximate. The caller',
  '      treats "low" AS escalate — if you would label "low" anyway, prefer',
  '      emitting "escalate" directly.',
  '  Missing confidence is treated as "low" (conservative default).',
  '',
  'Respond with ONE JSON object, no prose, no markdown, starting with "{":',
  '  {"kind": "reuse", "target": "<exact skill id>", "confidence": "high"|"low", "reasoning": "<one short sentence>"}',
  'OR',
  '  {"kind": "escalate", "reasoning": "<one short sentence>"}',
].join('\n');

const PREFILTER_PARAMS: GenerationParams = { temperature: 0, maxTokens: 256 };

export const prefilterResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reuse'),
    target: z.string(),
    // Haiku labels its own certainty in the fit. Missing / anything
    // non-"high" is normalised to "low" at the parse boundary so the
    // caller can treat "low" as an escalate (the HARD RULE on single-
    // candidate catalogs plus the confidence self-check in the prompt
    // push Haiku to produce this label, but we want the parser to be
    // tolerant of older / smaller models that may drop it).
    confidence: z.enum(['high', 'low']).optional(),
    // Hint from Haiku: does the task enumerate multiple orthogonal
    // artefacts that warrant decomposition at the supervisor tier, or
    // can the chosen child handle it end-to-end as a single subtask?
    // Omitted / false keeps the existing short-circuit behaviour (one
    // subtask, skip the full supervisor plan call). True makes the
    // caller fall through to the full Sonnet/Opus plan, with Haiku's
    // reuse target preserved as a routing hint. Default is false (most
    // single-artefact tasks).
    decomposable: z.boolean().optional(),
    reasoning: z.string(),
  }),
  z.object({ kind: z.literal('escalate'), reasoning: z.string() }),
]);

export type PrefilterOutcome = z.infer<typeof prefilterResponseSchema>;

export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
}

/**
 * Per-task anti-loop memo: tracks which child atoms this supervisor has
 * already delegated to during the current task, and auto-clears when the task
 * boundary changes. Shared by L2 and L3 so their prefilter can't re-pick a
 * failing child across supervise-loop iterations.
 */
export class TaskChildrenMemo {
  private tried = new Set<string>();
  private lastTask: string | null = null;

  /** Call at the top of `plan()`. Clears memo if the task description changed. */
  beginTask(description: string): void {
    if (this.lastTask !== description) {
      this.tried.clear();
      this.lastTask = description;
    }
  }

  /** Record a child we're about to hand work to. */
  mark(name: string): void {
    this.tried.add(name);
  }

  /** Names to exclude from prefilter catalogs this cycle. */
  excluded(): ReadonlySet<string> {
    return this.tried;
  }
}

/**
 * Ask Haiku whether any catalog entry clearly matches the task.
 *
 * Returns `null` if the catalog is empty (prefilter is pointless). On any
 * error — LLM failure, bad JSON, unknown target — returns an escalate outcome
 * so the caller falls back to the full supervisor call.
 */
export async function prefilterStrategy(args: {
  ctx: RunContext;
  task: Task;
  catalog: CatalogEntry[];
  /**
   * Names already tried and failed during the current supervision cycle.
   * They are filtered out of the catalog before the LLM sees it, so the
   * prefilter cannot loop on a child that just proved itself incapable.
   * If the filtered catalog is empty, we return an escalate outcome so the
   * caller falls back to the full supervisor plan (which can create a new
   * type or mutualize).
   */
  exclude?: ReadonlySet<string>;
  model?: string;
  /**
   * System prompt override. Defaults to PREFILTER_SYSTEM_PROMPT (atom
   * catalogs). The skill prefilter passes SKILL_PREFILTER_SYSTEM_PROMPT —
   * same machinery, same schema, same confidence guard, but without the
   * atom-specific single-candidate HARD RULE that made Haiku escalate on
   * one-skill catalogs. Any override must be a CONSTANT string (prompt
   * caching keys on it).
   */
  systemPrompt?: string;
  /**
   * Optional caller attribution. When provided we prepend a short
   * `You are atom "<name>" (tier <N>) ...` preamble to the userContent so
   * the run trace can attribute this prefilter call to the L2 or L3 that
   * issued it. Without this, prefilter events show up as ownerless in the
   * decomposition report (the shared system prompt intentionally stays
   * constant to preserve prompt caching, so the preamble is the only
   * place where per-caller context can live).
   */
  actor?: { name: string; tier: Tier };
}): Promise<PrefilterOutcome | null> {
  if (args.catalog.length === 0) return null;

  const filtered = args.exclude
    ? args.catalog.filter((c) => !args.exclude!.has(c.name))
    : args.catalog;
  if (filtered.length === 0) {
    return {
      kind: 'escalate',
      reasoning: `all catalog entries already tried and failed: ${args.catalog
        .map((c) => c.name)
        .join(', ')}`,
    };
  }
  const filteredNames = new Set(filtered.map((c) => c.name));

  const catalogLines = filtered.map((c) => `  - ${c.name}: ${c.description}`);
  const userContent = [
    args.actor
      ? `You are atom "${args.actor.name}" (tier ${args.actor.tier}) running a prefilter catalog lookup.`
      : '',
    args.actor ? `` : '',
    `Task: ${args.task.description}`,
    args.task.constraints?.length
      ? `Constraints:\n${args.task.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    args.exclude && args.exclude.size > 0
      ? `Already tried and failed THIS task (do NOT pick these): ${[...args.exclude].join(', ')}`
      : '',
    ``,
    `Catalog:`,
    catalogLines.join('\n'),
  ]
    .filter((l) => typeof l === 'string')
    .join('\n');

  const model = args.model ?? modelForTier(1);
  const systemPrompt = args.systemPrompt ?? PREFILTER_SYSTEM_PROMPT;
  // Decision cache (FrugalGPT completion-cache analog): temperature-0 +
  // constant prompt makes the decision a pure function of these inputs, so
  // a repeat pair is served from disk — zero tokens, and under claude-cli
  // zero subprocess spawn. The key hashes every decision input (NOT the
  // actor preamble, which is trace attribution); see prefilterCache.ts for
  // the expiry/eviction bounds. Only PARSED outcomes are cached — the
  // error-path escalate below never is.
  const cacheKey = prefilterCacheKey({
    systemPrompt,
    model,
    taskDescription: args.task.description,
    ...(args.task.constraints ? { constraints: args.task.constraints } : {}),
    excluded: args.exclude ? [...args.exclude] : [],
    catalogLines,
  });
  const cached = prefilterCacheGet(cacheKey);
  if (cached) {
    const outcome = cached.kind === 'reuse' ? `reuse ${cached.target}` : 'escalate';
    args.ctx.logger.debug(`[prefilter] decision served from cache (${outcome})`);
    // Observer: a cache hit replaces an LLM call, so without an event of
    // its own the timeline just shows one fewer call and the run looks
    // cheaper for no visible reason.
    // branchId is stamped by forkBranch's wrapper, not read here — same
    // contract as recordTrust / recordSkill.
    args.ctx.recordCacheHit?.({
      outcome,
      reasoning: cached.reasoning,
      model,
      ...(args.actor ? { actorName: args.actor.name, actorTier: args.actor.tier } : {}),
    });
    return cached;
  }

  try {
    const resp = await args.ctx.llm.complete({
      model,
      systemPrompt,
      userContent,
      params: PREFILTER_PARAMS,
      signal: args.ctx.signal,
    });
    const outcome = parseWith(prefilterResponseSchema, resp.text);
    // The three parsed-outcome returns below all cache: each is a
    // deterministic function of the model's parsed answer, so serving it
    // again for identical inputs is exactly what the live call would do.
    if (outcome.kind === 'reuse' && !filteredNames.has(outcome.target)) {
      const rewritten: PrefilterOutcome = {
        kind: 'escalate',
        reasoning: `prefilter returned unknown or excluded target "${outcome.target}"`,
      };
      prefilterCachePut(cacheKey, rewritten);
      return rewritten;
    }
    // Force-match guard: if Haiku self-labels the fit as "low" (or omits
    // the field, normalised to low), treat it as an escalate. This
    // closes the hole where a single-candidate catalog tempted Haiku to
    // pick an approximate match (observed in production: Methane L2
    // picked Hydrogen L1 for a Node/REST task because Hydrogen was the
    // only L1 on record, even though its description named HTML-centric
    // validate_html as its capability). The prompt tells Haiku to emit
    // "escalate" directly when it would have labelled "low" anyway — the
    // guard here catches the cases where it still tries to squeeze a
    // reuse through.
    if (outcome.kind === 'reuse' && outcome.confidence !== 'high') {
      const rewritten: PrefilterOutcome = {
        kind: 'escalate',
        reasoning: `prefilter low-confidence reuse of "${outcome.target}" (${outcome.reasoning}) — treated as escalate`,
      };
      prefilterCachePut(cacheKey, rewritten);
      return rewritten;
    }
    prefilterCachePut(cacheKey, outcome);
    return outcome;
  } catch (err) {
    // Error-path escalate: NEVER cached — an LLM hiccup must not become a
    // week of "escalate" answers for this input.
    return {
      kind: 'escalate',
      reasoning: `prefilter failed: ${(err as Error).message}`,
    };
  }
}
