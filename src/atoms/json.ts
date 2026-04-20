import { z } from 'zod';
import { jsonrepair, JSONRepairError } from 'jsonrepair';
import { ValidationError } from '../core/errors.js';

/**
 * Strip stray `}` / `]` tokens that close the OUTER aggregate too early,
 * when subsequent `, "key": value` fragments should have been kept inside.
 * This pattern shows up in Haiku verdict output — the model emits:
 *     { "approved": false, "reasoning": "..."
 *     },
 *     "scope": "ephemeral"
 *     }
 * where the first `}` is a hallucinated premature close. `JSON.parse` fails
 * at the comma after the premature close; `jsonrepair` would salvage it
 * into an array and lose the `scope` field. We handle the case explicitly:
 * if on a left-to-right depth walk we find a `}` (or `]`) that brings us
 * back to depth 0 but there is still non-whitespace content after it, drop
 * that bracket (plus an immediate trailing `,`) and retry.
 *
 * Returns the repaired string, or `null` when no premature close is found.
 */
export function repairPrematureClose(raw: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let dropped = false;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        // Look ahead: any non-whitespace, non-comma content means this
        // close was premature. Drop the bracket only — KEEP the comma so
        // the surrounding fields stay correctly delimited as siblings of
        // the outer aggregate.
        const after = raw.slice(i + 1);
        const nonWs = after.match(/^\s*(.)/);
        if (nonWs && nonWs[1] === ',') {
          const afterComma = after.replace(/^\s*,\s*/, '');
          if (afterComma.length > 0 && !/^[\s\}\]]+$/.test(afterComma)) {
            depth++; // undo: we're dropping the bracket, so we're still open
            dropped = true;
            continue; // skip emitting ch; next iterations handle ws + comma
          }
        }
      }
      out += ch;
      continue;
    }
    out += ch;
  }
  return dropped ? out : null;
}

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
    // Three-stage repair, cheapest first:
    //   1. `repairTruncatedJson` — in-house fix for the common
    //      `max_tokens` truncation (unterminated string + missing closing
    //      brackets). Deterministic and targeted.
    //   2. `repairPrematureClose` — strips hallucinated early `}` / `]`
    //      tokens that Haiku sometimes emits before further fields.
    //      Preserves the semantic flat-object shape that `jsonrepair`
    //      would otherwise coerce into an array.
    //   3. `jsonrepair` — last-resort tolerant tokenizer for anything
    //      else (missing commas, unquoted keys, trailing garbage…).
    // If all three fail, surface a helpful excerpt for debugging.
    for (const repair of [repairTruncatedJson, repairPrematureClose]) {
      const repaired = repair(raw);
      if (repaired === null) continue;
      try {
        return JSON.parse(repaired);
      } catch {
        /* try next strategy */
      }
    }
    try {
      const repaired = jsonrepair(raw);
      return JSON.parse(repaired);
    } catch (err2) {
      const msg = err2 instanceof JSONRepairError ? err2.message : (err2 as Error).message;
      throw new ValidationError(
        `JSON parse failed: ${(err as Error).message} (repair also failed: ${msg}) (first 200 chars: ${raw.slice(0, 200)}… last 120 chars: …${raw.slice(-120)})`
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
  let primaryErr: unknown = null;
  try {
    const raw = extractJson(text);
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    primaryErr = new ValidationError(
      `schema validation failed: ${parsed.error.message}`
    );
  } catch (err) {
    // extractJson can throw on malformed JSON (e.g. a greedy first-`{` to
    // last-`}` slice that scooped up prose from the middle of the text).
    // We still want to try the candidate-scan fallback below.
    primaryErr = err;
  }

  // Fallback: scan every balanced top-level {…}/[…] in the text and keep
  // the LAST one that parses AND validates. Rationale: build-app runs
  // occasionally have an L1 that writes a narrative with
  // `{ score, level, state }`-style pseudo-JSON snippets embedded in
  // prose before ending with the real `{"output":…, "summary":…}`
  // payload. `extractJson` greedily grabs from the first `{` to the last
  // `}`, mixing prose into the slice. Scanning candidates rescues those
  // runs; the "prefer last" order matches the typical
  // "narration-then-final-answer" pattern.
  const candidates = findAllJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!);
      const again = schema.safeParse(obj);
      if (again.success) return again.data;
    } catch {
      continue;
    }
  }
  if (primaryErr instanceof ValidationError) throw primaryErr;
  throw new ValidationError(
    `schema validation failed: ${
      primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    }`
  );
}

/**
 * Return every balanced top-level `{…}` or `[…]` in the text, in source
 * order. Honours string literals (with escapes) so `{…}` inside a JSON
 * string doesn't break the balance walk. Useful when an LLM response
 * mixes prose with the actual JSON payload — callers can then pick the
 * candidate that schema-validates, not just the first one greedily
 * extracted by `extractJson`.
 */
export function findAllJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '{' || ch === '[') {
      const end = findBalancedEnd(text, i);
      if (end === -1) break;
      out.push(text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
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

/**
 * Tolerant plan parser used by L2/L3 fallback `selfPlan`. The supervisor's
 * *regular* plan method primes the LLM to emit `[strategy, plan]` arrays,
 * and that conditioning carries over into fallback mode — even with a
 * fallback-specific user message, Haiku/Sonnet will sometimes still wrap
 * the plan in an array (observed in build-app runs after escalation).
 * Accepts:
 *   - `{reasoning, proposedAction, expectedOutput}` — the canonical shape
 *   - `[strategy, plan]` — two-element array; take element 1
 *   - `[plan]` — single-element array; take element 0
 * Anything else falls through to the strict schema error.
 */
export function parsePlanTolerant(text: string): z.infer<typeof planSchema> {
  const raw = extractJson(text);
  if (Array.isArray(raw)) {
    if (raw.length >= 2) {
      const second = planSchema.safeParse(raw[1]);
      if (second.success) return second.data;
    }
    if (raw.length >= 1) {
      const first = planSchema.safeParse(raw[0]);
      if (first.success) return first.data;
    }
  }
  const parsed = planSchema.safeParse(raw);
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
  descriptionReplace: z.string().optional(),
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
  if (typeof mods.descriptionReplace === 'string' && mods.descriptionReplace.length > 0) return false;
  if (typeof mods.additionalContext === 'string' && mods.additionalContext.length > 0) return false;
  if (Array.isArray(mods.addTools) && mods.addTools.length > 0) return false;
  if (Array.isArray(mods.removeTools) && mods.removeTools.length > 0) return false;
  if (mods.params && Object.keys(mods.params).length > 0) return false;
  return true;
}

/**
 * Fill in the fields LLMs most commonly omit on negative verdicts, before
 * the strict schema runs. Without this a stray Haiku response that returns
 * `{"approved": false, "reasoning": "..."}` (no scope, no modifications)
 * would crash the whole run instead of triggering a normal rejection retry.
 * We default to `scope: "ephemeral"` + empty mods, which is the safest
 * interpretation: "retry as-is, no registry mutation". The repeat-rejection
 * short-circuit built on top of `superviseLoop` still escalates if Haiku
 * keeps misfiring.
 *
 * Kept as a standalone coercion function (rather than wrapping it in
 * `z.preprocess`) because chaining preprocess + discriminatedUnion +
 * superRefine in Zod v3 collapses the inferred output type back to
 * `unknown`, breaking every downstream consumer of
 * `z.infer<typeof verdictSchema>`. Applied at the parseWith boundary
 * via `parseVerdict` below instead.
 */
export function coerceVerdictDefaults(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (obj['approved'] !== false) return raw;
  const out: Record<string, unknown> = { ...obj };
  if (typeof out['scope'] !== 'string') out['scope'] = 'ephemeral';
  if (!out['modifications'] || typeof out['modifications'] !== 'object') {
    out['modifications'] = {};
  }
  if (typeof out['reasoning'] !== 'string') {
    out['reasoning'] = 'rejected without reasoning (coerced)';
  }
  return out;
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

/**
 * Parse an LLM response expected to contain a verdict JSON, tolerating the
 * most common Haiku omissions (missing `scope`, missing `modifications`)
 * via `coerceVerdictDefaults`. Callers should use THIS helper instead of
 * `parseWith(verdictSchema, ...)` at runtime so negative verdicts are
 * always well-formed downstream.
 */
export function parseVerdict(text: string): z.infer<typeof verdictSchema> {
  const raw = extractJson(text);
  const coerced = coerceVerdictDefaults(raw);
  const parsed = verdictSchema.safeParse(coerced);
  if (!parsed.success) {
    throw new ValidationError(`schema validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

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
