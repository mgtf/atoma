import { z } from 'zod';
import type { AtomType } from '../registry/atomRegistry.js';
import type {
  GenerationParams,
  PositiveVerdict,
  RunContext,
  Task,
  Tier,
} from '../core/types.js';
import { PIN_HAIKU } from '../core/models.js';
import { parseWith } from './json.js';

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
 * Cap on output tokens for supervisor-tier strategy/plan calls (L2.plan /
 * L3.plan on non-fallback path). The response is a JSON pair [strategy, plan]
 * — ~500-1000 tokens in practice. A higher ceiling just invites the model to
 * pad reasoning unnecessarily and raises the per-task output bill.
 *
 * Fallback / self-exec calls still use the atom's configured maxTokens
 * because they may produce actual content, not routing JSON.
 */
export const STRATEGY_MAX_TOKENS = 1500;

export function shouldTrustType(type: AtomType): boolean {
  return type.failures === 0 && type.successes >= TRUST_THRESHOLD_SUCCESSES;
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
 * the 4096-token threshold silently disables caching (see CLAUDE.md). When
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
  '  plan call). That is correct for atomic tasks. For a COMPOSITE task',
  '  that enumerates multiple orthogonal artefacts (e.g. "index.js +',
  '  package.json + tests", "index.html + styles.css + script.js", "server',
  '  + client + schema"), the single-subtask collapse is wrong — the',
  '  supervisor should decompose the task into one subtask per artefact',
  '  and route them in parallel, even if each subtask ends up on the',
  '  same reused child.',
  '  Set "decomposable": true when the task clearly enumerates multiple',
  '  orthogonal artefacts or steps. Set "decomposable": false (or omit)',
  '  for a single-responsibility task the chosen child can handle end-to-',
  '  end. Be CONSERVATIVE — default is false. A task saying "build a chess',
  '  puzzle with 8x8 board" is NOT decomposable (one artefact, even if the',
  '  description is long). A task saying "create package.json AND',
  '  index.js AND a test file" IS decomposable.',
  '',
  'Respond with ONE JSON object, no prose, no markdown, starting with "{":',
  '  {"kind": "reuse", "target": "<exact catalog name>", "confidence": "high"|"low", "decomposable": true|false, "reasoning": "<one short sentence>"}',
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
    filtered.map((c) => `  - ${c.name}: ${c.description}`).join('\n'),
  ]
    .filter((l) => typeof l === 'string')
    .join('\n');

  try {
    const resp = await args.ctx.llm.complete({
      model: args.model ?? PIN_HAIKU,
      systemPrompt: PREFILTER_SYSTEM_PROMPT,
      userContent,
      params: PREFILTER_PARAMS,
      signal: args.ctx.signal,
    });
    const outcome = parseWith(prefilterResponseSchema, resp.text);
    if (outcome.kind === 'reuse' && !filteredNames.has(outcome.target)) {
      return {
        kind: 'escalate',
        reasoning: `prefilter returned unknown or excluded target "${outcome.target}"`,
      };
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
      return {
        kind: 'escalate',
        reasoning: `prefilter low-confidence reuse of "${outcome.target}" (${outcome.reasoning}) — treated as escalate`,
      };
    }
    return outcome;
  } catch (err) {
    return {
      kind: 'escalate',
      reasoning: `prefilter failed: ${(err as Error).message}`,
    };
  }
}
