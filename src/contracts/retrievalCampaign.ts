import { z } from 'zod';
import { containerImageDigestSchema } from './containerImage.js';
import { modelSelectorStringSchema, tryParseModelSelector, transportOf } from './modelSelector.js';
import { retrievalDigestSchema, retrievalScoreSchema } from './retrievalBenchmark.js';
import { projectRetrievalIndexConfigSchema, PROJECT_RETRIEVAL_BM25 } from './projectRetrievalCorpus.js';
import { projectRetrievalLimitsSchema } from './projectRetrieval.js';
import { haystackLaunchSchema } from './retrievalHaystack.js';
import { runStatsSchema } from './runStats.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const positive = z.number().int().positive();
const hostSubscription = modelSelectorStringSchema.refine(
  value => tryParseModelSelector(value)?.mode === 'sub',
  'retrieval campaigns use host subscriptions only; API funding is not implemented'
);

export const retrievalArmSchema = z.enum(['atoma', 'atoma-bm25', 'atoma-haystack', 'frontier-direct']);

const bm25TreatmentSchema = z.object({
  backend: z.literal('sqlite-fts5'), index: projectRetrievalIndexConfigSchema,
  queryLimits: projectRetrievalLimitsSchema,
  ranking: z.object({ version: z.literal(PROJECT_RETRIEVAL_BM25.version),
    contextWeight: z.literal(PROJECT_RETRIEVAL_BM25.contextWeight), textWeight: z.literal(PROJECT_RETRIEVAL_BM25.textWeight) }).strict(),
}).strict();

export const retrievalTreatmentSchema = z.discriminatedUnion('backend', [bm25TreatmentSchema,
  z.object({ backend: z.literal('haystack'), index: projectRetrievalIndexConfigSchema,
    queryLimits: projectRetrievalLimitsSchema, launch: haystackLaunchSchema }).strict(),
]);

/** A development screening rule; passing it can only justify a new confirmation experiment. */
export const retrievalDecisionSchema = z.object({
  objective: z.literal('paired-full-pass'), minimumGain: z.number().min(0).max(1),
  maxElapsedRatio: z.number().positive(), maxPriceEquivalentRatio: z.number().positive(),
}).strict();
export const retrievalCampaignSpecSchema = z.object({
  version: z.literal(1),
  id,
  purpose: z.string().min(10).max(2000),
  kind: z.enum(['agentic-characterization', 'bm25-development', 'haystack-development']),
  treatment: retrievalTreatmentSchema.optional(),
  decision: retrievalDecisionSchema.optional(),
  questionIds: z.array(id).min(1).max(100),
  repetitions: positive.max(10),
  firstArm: retrievalArmSchema,
  models: z.object({
    l1: hostSubscription, l2: hostSubscription, l3: hostSubscription, frontier: hostSubscription,
  }).strict(),
  workerImage: containerImageDigestSchema,
  timeoutMs: positive.min(1000).max(900_000),
  maxWallMs: positive.max(12 * 60 * 60 * 1000),
  stopAfterConsecutiveInfrastructureFailures: positive.max(3),
  thresholds: z.object({ trust: positive, promote: positive, demote: positive }).strict(),
}).strict().superRefine((spec, ctx) => {
  const expectedBackend = spec.kind === 'bm25-development' ? 'sqlite-fts5' : spec.kind === 'haystack-development' ? 'haystack' : null;
  const expectedArm = spec.kind === 'bm25-development' ? 'atoma-bm25' : 'atoma-haystack';
  if (expectedBackend ? spec.treatment?.backend !== expectedBackend || !spec.decision ||
      (spec.firstArm !== 'atoma' && spec.firstArm !== 'frontier-direct' && spec.firstArm !== expectedArm) :
      spec.treatment !== undefined || spec.decision !== undefined || !['atoma', 'frontier-direct'].includes(spec.firstArm)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'register matching treatment, decision and arm for development comparisons only' });
  }
  const selectors = [spec.models.l1, spec.models.l2, spec.models.l3, spec.models.frontier]
    .map(tryParseModelSelector);
  if (selectors.some(s => s === null)) return;
  const transports = selectors.slice(0, 3).map(s => transportOf(s!));
  if (new Set(spec.questionIds).size !== spec.questionIds.length ||
      spec.questionIds.length * spec.repetitions * (spec.kind === 'agentic-characterization' ? 2 : 3) > 200 || spec.maxWallMs < spec.timeoutMs ||
      !transports.includes(transportOf(selectors[3]!))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate questions, excessive schedule, invalid budget or unconstructed frontier transport' });
  }
});

export const retrievalScheduleEntrySchema = z.object({
  ordinal: positive, questionId: id, repetition: positive, arm: retrievalArmSchema,
}).strict();

export const retrievalRegistrationSchema = z.object({
  version: z.literal(1),
  registeredAt: z.string().datetime(),
  spec: retrievalCampaignSpecSchema,
  source: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), sha256: retrievalDigestSchema }).strict(),
  instrumentsSha256: retrievalDigestSchema,
  runtime: z.object({ node: z.string(), platform: z.enum(['darwin', 'linux']), arch: z.string() }).strict(),
  policy: z.enum([
    'container-no-egress; fresh-prebootstrap-state; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled',
    'project-container-no-egress; fresh-authority-and-registry-per-attempt; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled; bm25-only-treatment',
    'project-container-no-egress; fresh-authority-and-registry-per-attempt; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled; local-haystack-treatment',
  ]),
  schedule: z.array(retrievalScheduleEntrySchema).min(2).max(200),
}).strict();

export const retrievalCampaignResultSchema = z.object({
  entry: retrievalScheduleEntrySchema,
  runId: z.string(),
  startedAt: z.string().datetime(),
  elapsedMs: z.number().nonnegative(),
  runner: runStatsSchema.nullable(),
  infrastructureFailure: z.boolean(),
  score: retrievalScoreSchema,
  full: z.boolean(),
  tracePath: z.string().nullable(),
}).strict();

export type RetrievalCampaignSpec = z.infer<typeof retrievalCampaignSpecSchema>;
export type RetrievalRegistration = z.infer<typeof retrievalRegistrationSchema>;
export type RetrievalScheduleEntry = z.infer<typeof retrievalScheduleEntrySchema>;
export type RetrievalCampaignResult = z.infer<typeof retrievalCampaignResultSchema>;
