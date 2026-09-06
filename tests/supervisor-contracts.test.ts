import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaFromZod } from '../src/contracts/jsonSchema.js';
import { platformEventInputSchema } from '../src/contracts/platformEvents.js';
import {
  EXAMPLE_MEND_REQUEST,
  EXAMPLE_SUPERVISOR_MEND_REPORT,
  mendRequestSchema,
  SUPERVISOR_MEND_JSON_SCHEMA,
  supervisorMendReportSchema,
} from '../src/contracts/supervisorMend.js';
import {
  EXAMPLE_SUPERVISOR_VERDICT,
  SUPERVISOR_VERDICT_JSON_SCHEMA,
  supervisorVerdictSchema,
  worstFindingKind,
} from '../src/contracts/supervisorVerdict.js';
import { mendEvent, verdictEvent } from '../src/supervisor/journal.js';

/**
 * ONE SCHEMA, TWO CONSUMERS. The headless session is held to a JSON Schema
 * and the harness validates with zod; the first is derived from the second,
 * so what these hold is that the derivation says what the zod schema says —
 * and refuses what it cannot say.
 */

describe('jsonSchemaFromZod', () => {
  it('derives strict objects, bounds, enums, arrays and optionals', () => {
    const schema = z
      .object({
        kind: z.enum(['a', 'b']),
        title: z.string().min(1).max(10),
        count: z.number().int().min(0),
        tags: z.array(z.string()),
        note: z.string().optional(),
        flag: z.boolean(),
      })
      .strict();
    expect(jsonSchemaFromZod(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'count', 'tags', 'flag'],
      properties: {
        kind: { enum: ['a', 'b'] },
        title: { type: 'string', minLength: 1, maxLength: 10 },
        count: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
        flag: { type: 'boolean' },
      },
    });
  });

  it('unwraps a refinement and refuses nodes it cannot express', () => {
    const refined = z.object({ a: z.string() }).superRefine(() => {});
    expect(jsonSchemaFromZod(refined)).toMatchObject({ type: 'object', required: ['a'] });
    expect(() => jsonSchemaFromZod(z.union([z.string(), z.number()]))).toThrow(/unsupported zod node/);
    expect(() => jsonSchemaFromZod(z.object({ a: z.string().email() }))).toThrow(/unsupported string check/);
  });
});

describe('the verdict contract', () => {
  it('parses its example and derives the session schema from the same shape', () => {
    expect(supervisorVerdictSchema.parse(EXAMPLE_SUPERVISOR_VERDICT)).toEqual(EXAMPLE_SUPERVISOR_VERDICT);
    expect(SUPERVISOR_VERDICT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'runId', 'runStatus', 'runAssessment', 'findings'],
    });
    const properties = SUPERVISOR_VERDICT_JSON_SCHEMA['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['schema']).toEqual({ enum: ['atoma.supervisor.verdict/v1'] });
    const finding = (properties['findings']!['items'] as Record<string, unknown>);
    expect(finding['required']).toEqual(['kind', 'title', 'detail', 'evidence', 'confidence']);
    const fix = (finding['properties'] as Record<string, Record<string, unknown>>)['proposedFix']!;
    expect(fix['required']).toEqual(['where', 'what', 'checkedIntentionalChoices']);
  });

  it('is strict: an unknown key or a half-cited proposal is refused', () => {
    expect(supervisorVerdictSchema.safeParse({ ...EXAMPLE_SUPERVISOR_VERDICT, extra: 1 }).success).toBe(false);
    const finding = EXAMPLE_SUPERVISOR_VERDICT.findings[0]!;
    const uncited = { ...finding, proposedFix: { where: 'src/x.ts', what: 'y' } };
    expect(supervisorVerdictSchema.safeParse({ ...EXAMPLE_SUPERVISOR_VERDICT, findings: [uncited] }).success).toBe(false);
  });

  it('ranks the worst finding without asking the model', () => {
    const base = EXAMPLE_SUPERVISOR_VERDICT.findings[0]!;
    expect(worstFindingKind([])).toBeNull();
    expect(worstFindingKind([{ ...base, kind: 'observation' }])).toBeNull();
    expect(
      worstFindingKind([{ ...base, kind: 'mechanism_candidate' }, { ...base, kind: 'defect' }, { ...base, kind: 'observation' }])
    ).toBe('defect');
    expect(worstFindingKind([{ ...base, kind: 'defect' }, { ...base, kind: 'security_incident' }])).toBe('security_incident');
  });
});

describe('the mend report contract', () => {
  it('parses its example and requires a reason to decline', () => {
    expect(supervisorMendReportSchema.parse(EXAMPLE_SUPERVISOR_MEND_REPORT)).toEqual(EXAMPLE_SUPERVISOR_MEND_REPORT);
    const declined = { ...EXAMPLE_SUPERVISOR_MEND_REPORT, outcome: 'declined' };
    expect(supervisorMendReportSchema.safeParse(declined).success).toBe(false);
    expect(supervisorMendReportSchema.safeParse({ ...declined, declineReason: 'needs a mechanism' }).success).toBe(true);
    expect(SUPERVISOR_MEND_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'outcome', 'title', 'summary', 'checkedIntentionalChoices'],
    });
  });
});

describe('the mend request contract', () => {
  it('parses its example, stays under ten top-level keys, and is strict', () => {
    expect(mendRequestSchema.parse(EXAMPLE_MEND_REQUEST)).toEqual(EXAMPLE_MEND_REQUEST);
    expect(Object.keys(EXAMPLE_MEND_REQUEST).length).toBeLessThanOrEqual(10);
    expect(mendRequestSchema.safeParse({ ...EXAMPLE_MEND_REQUEST, trace: 'raw text' }).success).toBe(false);
    expect(mendRequestSchema.safeParse({ ...EXAMPLE_MEND_REQUEST, key: 'zz' }).success).toBe(false);
  });
});

describe('the supervisor journal rows', () => {
  it('are valid platform events that carry facts and never model text', () => {
    const row = verdictEvent({
      runId: 'run-1',
      runStatus: 'failed',
      grade: 'deficient',
      worstFindingKind: 'defect',
      findingKinds: { defect: 1, mechanism_candidate: 0, security_incident: 0, observation: 2 },
      modelRequested: 'glm-5.3',
      modelsServed: ['glm-5.3', 'claude-haiku-4-5-20251001'],
      analysisCostUsd: 0.7,
      verdictPath: 'supervisor/verdicts/run-1.json',
    });
    expect(platformEventInputSchema.safeParse(row).success).toBe(true);
    expect(row.kind).toBe('supervisor.verdict');
    expect(row.summary).toBe('Analyst graded a failed run deficient, worst finding defect');
    expect(JSON.stringify(row)).not.toContain('IGNORE');
  });

  it('write no row for bookkeeping outcomes and cap the reasons they carry', () => {
    const base = { runId: 'run-1', findingIndex: 1, key: 'abc', branch: 'mender/x' } as const;
    expect(mendEvent({ ...base, outcome: 'dry-run' })).toBeNull();
    expect(mendEvent({ ...base, outcome: 'skipped-duplicate' })).toBeNull();
    const refused = mendEvent({ ...base, outcome: 'refused', problems: Array.from({ length: 9 }, (_, i) => `p${i} ` + 'x'.repeat(300)) })!;
    expect(refused.kind).toBe('mender.refused');
    expect(platformEventInputSchema.safeParse(refused).success).toBe(true);
    const problems = refused.detail!['problems'] as string[];
    expect(problems).toHaveLength(5);
    expect(problems[0]!.length).toBe(160);
    for (const outcome of ['pushed-no-pr', 'model-failed', 'invalid-report', 'harness-failed'] as const) {
      expect(mendEvent({ ...base, outcome })!.kind).toBe('mender.failed');
    }
    expect(mendEvent({ ...base, outcome: 'pr-opened', prUrl: 'https://x/pull/1' })!.kind).toBe('mender.pr_opened');
    expect(mendEvent({ ...base, outcome: 'started' })!.kind).toBe('mender.started');
  });
});
