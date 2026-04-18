import { z } from 'zod';
import { ValidationError } from '../core/errors.js';

/**
 * Extract the first JSON object or array from a string. LLMs sometimes wrap JSON
 * in prose or fences; this recovers the payload.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) {
    return JSON.parse(fenced[1]);
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
    throw new ValidationError(`malformed JSON: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
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
    branchName: z.string().optional(),
  }),
]);

export const l2StrategySchema = z.object({
  strategy: z.enum(['reuse', 'create', 'mutualize']),
  target: z.string().optional(),
  seed: z
    .object({
      description: z.string(),
      systemPrompt: z.string(),
      tools: z
        .array(
          z.object({
            name: z.string(),
            description: z.string(),
            inputSchema: z.record(z.unknown()),
          })
        )
        .default([]),
      params: z
        .object({
          temperature: z.number().optional(),
          maxTokens: z.number().optional(),
          topP: z.number().optional(),
        })
        .default({}),
    })
    .optional(),
  reasoning: z.string(),
});

export type L2Strategy = z.infer<typeof l2StrategySchema>;

export const l3StrategySchema = z.object({
  strategy: z.enum(['reuse', 'create']),
  target: z.string().optional(),
  seed: z
    .object({
      description: z.string(),
      systemPrompt: z.string(),
      tools: z
        .array(
          z.object({
            name: z.string(),
            description: z.string(),
            inputSchema: z.record(z.unknown()),
          })
        )
        .default([]),
      params: z
        .object({
          temperature: z.number().optional(),
          maxTokens: z.number().optional(),
          topP: z.number().optional(),
        })
        .default({}),
    })
    .optional(),
  reasoning: z.string(),
});

export type L3Strategy = z.infer<typeof l3StrategySchema>;
