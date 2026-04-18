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

export const verdictSchema = z.discriminatedUnion('approved', [
  z.object({ approved: z.literal(true), reasoning: z.string() }),
  z.object({
    approved: z.literal(false),
    reasoning: z.string(),
    modifications: atomModificationsSchema,
    scope: z.enum(['ephemeral', 'branch', 'patch']),
    // LLMs sometimes emit `"branchName": null` instead of omitting the key;
    // accept null and coerce to undefined so the runtime type stays
    // `string | undefined`.
    branchName: z
      .string()
      .nullish()
      .transform((v) => v ?? undefined),
  }),
]);

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
