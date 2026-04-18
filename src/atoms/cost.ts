import { z } from 'zod';
import type { AtomType } from '../registry/atomRegistry.js';
import type {
  GenerationParams,
  PositiveVerdict,
  RunContext,
  Task,
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
 */
export const PREFILTER_SYSTEM_PROMPT = [
  'You pre-filter catalog lookups for a three-tier LLM orchestrator.',
  'Given a task and a catalog of child atom types, pick ONE that clearly fits,',
  'or declare that no clear match exists.',
  'You do NOT design new types, you do NOT call tools, you do NOT produce plans.',
  'Bias strongly toward escalation when in doubt — escalation to the supervisor',
  'is cheap relative to selecting a wrong type and burning a full supervision cycle.',
  'Respond with ONE JSON object, no prose, no markdown, starting with "{":',
  '  {"kind": "reuse", "target": "<exact catalog name>", "reasoning": "<one short sentence>"}',
  'OR',
  '  {"kind": "escalate", "reasoning": "<one short sentence>"}',
].join('\n');

const PREFILTER_PARAMS: GenerationParams = { temperature: 0, maxTokens: 256 };

export const prefilterResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reuse'), target: z.string(), reasoning: z.string() }),
  z.object({ kind: z.literal('escalate'), reasoning: z.string() }),
]);

export type PrefilterOutcome = z.infer<typeof prefilterResponseSchema>;

export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
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
  model?: string;
}): Promise<PrefilterOutcome | null> {
  if (args.catalog.length === 0) return null;

  const userContent = [
    `Task: ${args.task.description}`,
    args.task.constraints?.length
      ? `Constraints:\n${args.task.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    ``,
    `Catalog:`,
    args.catalog.map((c) => `  - ${c.name}: ${c.description}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await args.ctx.llm.complete({
      model: args.model ?? PIN_HAIKU,
      systemPrompt: PREFILTER_SYSTEM_PROMPT,
      userContent,
      params: PREFILTER_PARAMS,
    });
    const outcome = parseWith(prefilterResponseSchema, resp.text);
    if (outcome.kind === 'reuse') {
      const known = new Set(args.catalog.map((c) => c.name));
      if (!known.has(outcome.target)) {
        return { kind: 'escalate', reasoning: `prefilter returned unknown target "${outcome.target}"` };
      }
    }
    return outcome;
  } catch (err) {
    return {
      kind: 'escalate',
      reasoning: `prefilter failed: ${(err as Error).message}`,
    };
  }
}
