import { z } from 'zod';
import { jsonSchemaFromZod } from './jsonSchema.js';

/**
 * THE ANALYST'S VERDICT — one per analysed run (supervisor stage 2,
 * `docs/supervisor-design.md`).
 *
 * v1 answers TWO INDEPENDENT QUESTIONS, because v0 conflated them and the
 * 2026-08-21 calibration broke on it: two runs came back `ok` while carrying a
 * `mechanism_candidate`, and both readings were right about different things.
 * `runAssessment` says how THIS run went; `findings` say what should CHANGE;
 * routing (backlog, alerts, the mender) reads findings only, and the harness
 * derives a worst-finding kind for logs instead of asking the model for a
 * global verdict.
 *
 * `proposedFix.checkedIntentionalChoices` is REQUIRED on every proposal: the
 * calibration caught the analyst re-proposing a remedy `src/tools/AGENTS.md`
 * records as tried and rejected, so asking it to read intentional choices was
 * measurably not enough. A proposal that cannot name the file it checked is
 * not a proposal.
 *
 * Every string a model wrote here is UNTRUSTED downstream: quoted as evidence,
 * never followed, never rendered into a journal summary or a push body.
 */
export const SUPERVISOR_VERDICT_SCHEMA_TAG = 'atoma.supervisor.verdict/v1';

export const verdictRunStatusSchema = z.enum(['delivered', 'failed', 'cancelled', 'unknown']);
export const verdictGradeSchema = z.enum(['sound', 'wasteful', 'deficient']);
export const findingKindSchema = z.enum([
  /** A net bug in atoma with a mechanism in `src/`; the mender may take it. */
  'defect',
  /** Wants a NEW gate, heuristic, rule or threshold — cooling-off backlog, never same-day. */
  'mechanism_candidate',
  /** Injection, exfiltration, sandbox or egress anomaly — an alert for a person. */
  'security_incident',
  /** Notable, true, demands nothing. */
  'observation',
]);
export const findingConfidenceSchema = z.enum(['low', 'medium', 'high']);

export const verdictEvidenceSchema = z
  .object({
    /** `path:line` into the digest, the trace, or a `src/` file. */
    ref: z.string().min(1).max(300),
    /** ≤ 200 chars verbatim from that line. Untrusted. */
    quote: z.string().max(400).optional(),
  })
  .strict();

/** Coverage is a model-authored assessment, never proof of tool execution. */
export const stageReviewSchema = z.object({
  status: z.enum(['reviewed', 'insufficient_evidence', 'not_applicable']),
  summary: z.string().min(1).max(2000),
  evidence: z.array(verdictEvidenceSchema).min(1),
}).strict();

export const stageReviewsSchema = z.object({
  planning: stageReviewSchema,
  delegation: stageReviewSchema,
  execution: stageReviewSchema,
  validation: stageReviewSchema,
  recovery: stageReviewSchema,
  learning: stageReviewSchema,
}).strict();

export const proposedFixSchema = z
  .object({
    where: z.string().min(1).max(300),
    what: z.string().min(1).max(2000),
    checkedIntentionalChoices: z.string().min(1).max(1000),
  })
  .strict();

export const verdictFindingSchema = z
  .object({
    kind: findingKindSchema,
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(4000),
    evidence: z.array(verdictEvidenceSchema),
    proposedFix: proposedFixSchema.optional(),
    confidence: findingConfidenceSchema,
  })
  .strict();

export const supervisorVerdictSchema = z
  .object({
    schema: z.enum([SUPERVISOR_VERDICT_SCHEMA_TAG]),
    runId: z.string().min(1).max(128),
    runStatus: verdictRunStatusSchema,
    runAssessment: z
      .object({
        grade: verdictGradeSchema,
        summary: z.string().min(1).max(4000),
      })
      .strict(),
    findings: z.array(verdictFindingSchema),
    // Historical v1 verdicts remain readable; new analyses require coverage below.
    stageReviews: stageReviewsSchema.optional(),
  })
  .strict();

/** Same stored shape, with coverage required at the generation boundary. */
export const analystVerdictSchema = supervisorVerdictSchema.extend({
  stageReviews: stageReviewsSchema,
});
export const ANALYST_VERDICT_JSON_SCHEMA = jsonSchemaFromZod(analystVerdictSchema);

export type VerdictRunStatus = z.infer<typeof verdictRunStatusSchema>;
export type VerdictGrade = z.infer<typeof verdictGradeSchema>;
export type FindingKind = z.infer<typeof findingKindSchema>;
export type FindingConfidence = z.infer<typeof findingConfidenceSchema>;
export type VerdictEvidence = z.infer<typeof verdictEvidenceSchema>;
export type ProposedFix = z.infer<typeof proposedFixSchema>;
export type VerdictFinding = z.infer<typeof verdictFindingSchema>;
export type SupervisorVerdict = z.infer<typeof supervisorVerdictSchema>;

/** What the headless session is held to. Derived, never written by hand. */
export const SUPERVISOR_VERDICT_JSON_SCHEMA = jsonSchemaFromZod(supervisorVerdictSchema);

/** Harness-side ordering for logs and routing. Never asked of the model. */
export const FINDING_SEVERITY: Record<FindingKind, number> = {
  observation: 0,
  mechanism_candidate: 1,
  defect: 2,
  security_incident: 3,
};

export function worstFindingKind(findings: readonly VerdictFinding[]): FindingKind | null {
  let worst: FindingKind | null = null;
  for (const finding of findings) {
    if (finding.kind === 'observation') continue;
    if (worst === null || FINDING_SEVERITY[finding.kind] > FINDING_SEVERITY[worst]) {
      worst = finding.kind;
    }
  }
  return worst;
}

/**
 * What the harness records beside a verdict: never the model's word about
 * itself. `modelsServed` is what the session actually consumed, per model, in
 * the same shape a run's `totals.perModel` uses, so an analysis and the run
 * it examined compare field by field — recording the requested alias would
 * name one model and price another, the lie `servedModel` exists to prevent.
 */
export interface ServedModelUsage {
  readonly model: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface VerdictMeta {
  readonly analysedAt: string;
  readonly promptVersion: string;
  readonly modelRequested: string;
  readonly providerBaseUrl: string | null;
  readonly modelsServed: readonly ServedModelUsage[] | null;
  readonly worstFindingKind: FindingKind | null;
  readonly analysisCostUsd: number | null;
  readonly analysisDurationMs: number | null;
  readonly analysisTurns: number | null;
  readonly sessionId: string | null;
}

export type StoredVerdict = SupervisorVerdict & { readonly _meta: VerdictMeta };

/** Schema-validated example, parsed at module load (contracts convention). */
export const EXAMPLE_SUPERVISOR_VERDICT: SupervisorVerdict = analystVerdictSchema.parse({
  stageReviews: Object.fromEntries(Object.keys(stageReviewsSchema.shape).map((stage) => [stage, {
    status: 'insufficient_evidence',
    summary: 'This illustrative verdict does not establish full stage coverage.',
    evidence: [{ ref: 'digest.json:1' }],
  }])),
  schema: SUPERVISOR_VERDICT_SCHEMA_TAG,
  runId: '2026-08-21T11-02-26-148-48faa963',
  runStatus: 'failed',
  runAssessment: {
    grade: 'deficient',
    summary:
      'The run failed after three validator rejections with escalating evidence demands; the smoke never observed the countdown tick.',
  },
  findings: [
    {
      kind: 'defect',
      title: 'validate_html accepts a pre-flight rejection as a pass',
      detail: 'The tool reports ok on a rejected smoke when the body parses.',
      evidence: [{ ref: 'src/tools/browserProbe.ts:88', quote: 'if (parsed) return { ok: true }' }],
      proposedFix: {
        where: 'src/tools/browserProbe.ts',
        what: 'Check the pre-flight verdict before the body.',
        checkedIntentionalChoices:
          'src/tools/AGENTS.md — this is a tool verdict fix, not the rejected prompt-guidance shortcut.',
      },
      confidence: 'high',
    },
  ],
});
