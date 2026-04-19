import { z } from 'zod';
import { ValidationError } from '../core/errors.js';

/**
 * Extract the first JSON object or array from a string. LLMs sometimes wrap JSON
 * in prose or fences; this recovers the payload.
 *
 * Resilient to truncation: if the LLM response is cut off mid-string (common
 * with `max_tokens` limits), we attempt a best-effort repair by closing any
 * unterminated string and balancing brackets before parsing again.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) {
    return tryParseJson(fenced[1]);
  }

  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) start = Math.min(firstBrace, firstBracket);
  else if (firstBrace !== -1) start = firstBrace;
  else if (firstBracket !== -1) start = firstBracket;

  if (start === -1) {
    throw new ValidationError(`no JSON found in response: ${trimmed.slice(0, 200)}`);
  }
  const lastBrace = trimmed.lastIndexOf('}');
  const lastBracket = trimmed.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);
  if (end <= start) {
    // No closing bracket — most likely a truncated response.
    return tryParseJson(trimmed.slice(start));
  }
  // First try a clean slice up to the last visible closing bracket. If that
  // fails (e.g. the response is truncated with extra partial content past the
  // last balanced close), fall back to repairing the full tail.
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return tryParseJson(trimmed.slice(start));
  }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const repaired = repairTruncatedJson(raw);
    if (repaired === null) {
      throw new ValidationError(
        `JSON parse failed: ${(err as Error).message} (first 200 chars: ${raw.slice(0, 200)}… last 120 chars: …${raw.slice(-120)})`
      );
    }
    try {
      return JSON.parse(repaired);
    } catch (err2) {
      throw new ValidationError(
        `JSON parse failed even after repair: ${(err2 as Error).message} (first 200 chars: ${raw.slice(0, 200)}…)`
      );
    }
  }
}

/**
 * Best-effort repair of a truncated JSON payload: scans the string while
 * tracking whether we're inside a JSON string literal, then closes any open
 * string and balances the bracket stack.
 *
 * Returns `null` if repair is not applicable (e.g. the JSON is clearly
 * malformed in structure rather than truncated).
 */
export function repairTruncatedJson(raw: string): string | null {
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (!inString && stack.length === 0) return null;

  let out = raw;
  // If the last character is a trailing escape inside a string, drop it so we
  // don't leave a dangling backslash.
  if (escape) out = out.slice(0, -1);
  // Strip a trailing incomplete token like `,` or `:` that can't be closed.
  out = out.replace(/[,:\s]+$/, '');
  if (inString) out += '"';
  while (stack.length > 0) {
    const open = stack.pop()!;
    out += open === '{' ? '}' : ']';
  }
  return out;
}

export function parseWith<T>(schema: z.ZodSchema<T>, text: string): T {
  const raw = extractJson(text);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(`schema validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Scan forward from `start` (which must point at `{` or `[`) and return the
 * index of its matching close bracket, honouring string literals and escapes.
 * Returns -1 if the bracket is never closed.
 */
export function findBalancedEnd(s: string, start: number): number {
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
 * Parse an LLM response that is expected to contain two back-to-back JSON
 * payloads: a `[strategy, plan]` array, two fenced code blocks, or two
 * successive top-level objects. Includes a best-effort repair for truncated
 * responses — if the array closes are missing, we repair the tail and accept
 * a single-object array by synthesising a placeholder plan so the supervise
 * loop can still move forward.
 */
export function parseTwoJson(text: string): [unknown, unknown] {
  const trimmed = text.trim();

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
      const sliced = trimmed.slice(firstBracket);
      const repaired = repairTruncatedJson(sliced);
      if (repaired) {
        try {
          const arr = JSON.parse(repaired);
          if (Array.isArray(arr) && arr.length >= 2) return [arr[0], arr[1]];
          if (Array.isArray(arr) && arr.length === 1) {
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

  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  if (fences.length >= 2) {
    return [JSON.parse(fences[0]![1]!), JSON.parse(fences[1]![1]!)];
  }

  const start1 = trimmed.indexOf('{');
  if (start1 === -1) {
    throw new Error(`parseTwoJson: no JSON object found (head: ${trimmed.slice(0, 200)})`);
  }
  const end1 = findBalancedEnd(trimmed, start1);
  if (end1 === -1) {
    throw new Error(`parseTwoJson: unterminated first JSON (head: ${trimmed.slice(0, 200)})`);
  }
  const first = JSON.parse(trimmed.slice(start1, end1 + 1));
  const rest = trimmed.slice(end1 + 1);
  const start2 = rest.indexOf('{');
  if (start2 === -1) {
    throw new Error(`parseTwoJson: missing second JSON (head: ${trimmed.slice(0, 200)})`);
  }
  const end2 = findBalancedEnd(rest, start2);
  if (end2 === -1) {
    throw new Error(`parseTwoJson: unterminated second JSON (head: ${trimmed.slice(0, 200)})`);
  }
  return [first, JSON.parse(rest.slice(start2, end2 + 1))];
}

/**
 * Tolerant parser for self-execute result payloads. Tries the strict
 * `{output, summary}` schema first, then falls back to wrapping the raw text
 * as output. Used by L2/L3 fallback self-exec where Opus/Sonnet sometimes
 * ignore the JSON envelope and dump content directly.
 */
export function parsePayloadTolerant(text: string): {
  output: unknown;
  summary: string;
} {
  try {
    const p = parseWith(resultPayloadSchema, text);
    return { output: p.output, summary: p.summary };
  } catch {
    const trimmed = text.trim();
    return {
      output: trimmed,
      summary: `fallback produced non-JSON output (${trimmed.length} chars)`,
    };
  }
}

export const planSchema = z.object({
  reasoning: z.string(),
  proposedAction: z.string(),
  toolCalls: z
    .array(z.object({ name: z.string(), args: z.record(z.unknown()) }))
    .optional(),
  expectedOutput: z.string(),
});

export const resultPayloadSchema = z.object({
  output: z.unknown(),
  summary: z.string(),
});

export const atomModificationsSchema = z.object({
  systemPromptAppend: z.string().optional(),
  systemPromptReplace: z.string().optional(),
  addTools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()),
      })
    )
    .optional(),
  removeTools: z.array(z.string()).optional(),
  params: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
      topP: z.number().optional(),
    })
    .partial()
    .optional(),
  additionalContext: z.string().optional(),
});

/**
 * True when `mods` contains no actionable change — every field is either
 * absent, nullish, or an empty string/array/object. Kept exported because both
 * the verdict refinement (below) and downstream consumers use the same
 * definition of "empty" to stay in sync.
 */
export function isEffectivelyEmptyMods(
  mods: z.infer<typeof atomModificationsSchema> | undefined
): boolean {
  if (!mods) return true;
  if (typeof mods.systemPromptReplace === 'string' && mods.systemPromptReplace.length > 0) return false;
  if (typeof mods.systemPromptAppend === 'string' && mods.systemPromptAppend.length > 0) return false;
  if (typeof mods.additionalContext === 'string' && mods.additionalContext.length > 0) return false;
  if (Array.isArray(mods.addTools) && mods.addTools.length > 0) return false;
  if (Array.isArray(mods.removeTools) && mods.removeTools.length > 0) return false;
  if (mods.params && Object.keys(mods.params).length > 0) return false;
  return true;
}

export const verdictSchema = z
  .discriminatedUnion('approved', [
    z.object({ approved: z.literal(true), reasoning: z.string() }),
    z.object({
      approved: z.literal(false),
      reasoning: z.string(),
      modifications: atomModificationsSchema,
      scope: z.enum(['ephemeral', 'branch', 'patch']),
      // LLMs sometimes emit `"branchName": null` instead of omitting the key;
      // nullish() tolerates that at runtime. Output type stays
      // `string | null | undefined` because zod v3 doesn't narrow through a
      // discriminated union; the consumer (`llmVerdict`) normalises to
      // `string | undefined` before returning.
      branchName: z.string().nullish(),
    }),
  ])
  // A rejected verdict targeting the canonical type (`patch` or `branch`)
  // MUST carry at least one concrete modification — otherwise the LLM is
  // merely diagnosing without prescribing, and we'd mutate the registry for
  // nothing. `ephemeral` is exempt: it's a pure retry of the current
  // instance, which is occasionally legit (e.g. transient flake).
  .superRefine((v, ctx) => {
    if (v.approved) return;
    if (v.scope === 'ephemeral') return;
    if (isEffectivelyEmptyMods(v.modifications)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modifications'],
        message:
          `scope "${v.scope}" requires at least one non-empty field in "modifications" ` +
          '(systemPromptAppend/Replace, additionalContext, addTools, removeTools, or params). ' +
          'Use scope "ephemeral" when you only have a diagnostic without a concrete fix.',
      });
    }
  });

const toolObjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});

/**
 * LLMs often return `tools` as an array of strings (tool names they want
 * inherited) instead of full Tool objects. We tolerate both: strings are
 * silently dropped here — the parent atom's tools will be merged back in by
 * `mergeTools` at the call site, so mentioning them by name is a no-op.
 */
const lenientToolArraySchema = z.preprocess((raw) => {
  if (!Array.isArray(raw)) return raw;
  return raw.filter(
    (t) =>
      t && typeof t === 'object' && !Array.isArray(t) &&
      typeof (t as { name?: unknown }).name === 'string'
  );
}, z.array(toolObjectSchema).default([]));

const seedSchema = z
  .object({
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
    tools: lenientToolArraySchema,
    params: z
      .object({
        temperature: z.number().optional(),
        maxTokens: z.number().optional(),
        topP: z.number().optional(),
      })
      .default({}),
  });

/**
 * LLMs frequently emit an empty `seed: {}` even when choosing `reuse`.
 * Pre-strip the seed in that case so schema validation succeeds, and only
 * enforce the full seed shape when the strategy actually creates a child.
 */
function stripSeedWhenReuse(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (obj['strategy'] === 'reuse' || obj['strategy'] === 'mutualize') {
    const { seed: _drop, ...rest } = obj;
    void _drop;
    return rest;
  }
  return raw;
}

export const l2StrategySchema = z.preprocess(
  stripSeedWhenReuse,
  z.object({
    strategy: z.enum(['reuse', 'create', 'mutualize']),
    target: z.string().optional(),
    seed: seedSchema.optional(),
    reasoning: z.string(),
  })
);

export type L2Strategy = z.infer<typeof l2StrategySchema>;

export const l3StrategySchema = z.preprocess(
  stripSeedWhenReuse,
  z.object({
    strategy: z.enum(['reuse', 'create']),
    target: z.string().optional(),
    seed: seedSchema.optional(),
    reasoning: z.string(),
  })
);

export type L3Strategy = z.infer<typeof l3StrategySchema>;
