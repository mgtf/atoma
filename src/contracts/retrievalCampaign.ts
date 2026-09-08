import { z } from 'zod';
import { containerImageDigestSchema } from './containerImage.js';
import { modelSelectorStringSchema, tryParseModelSelector, transportOf } from './modelSelector.js';
import { retrievalDigestSchema, retrievalScoreSchema } from './retrievalBenchmark.js';
import { runStatsSchema } from './runStats.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const positive = z.number().int().positive();
const hostSubscription = modelSelectorStringSchema.refine(
  value => tryParseModelSelector(value)?.mode === 'sub',
  'the first characterization campaign uses host subscriptions only; API funding is not implemented'
);

export const retrievalArmSchema = z.enum(['atoma', 'frontier-direct']);

/** Characterization only: no treatment or confirmatory gain claim exists yet. */
export const retrievalCampaignSpecSchema = z.object({
  version: z.literal(1),
  id,
  purpose: z.string().min(10).max(2000),
  kind: z.literal('agentic-characterization'),
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
  const selectors = [spec.models.l1, spec.models.l2, spec.models.l3, spec.models.frontier]
    .map(tryParseModelSelector);
  if (selectors.some(s => s === null)) return;
  const transports = selectors.slice(0, 3).map(s => transportOf(s!));
  if (new Set(spec.questionIds).size !== spec.questionIds.length ||
      spec.questionIds.length * spec.repetitions * 2 > 200 || spec.maxWallMs < spec.timeoutMs ||
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
  policy: z.literal('container-no-egress; fresh-prebootstrap-state; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled'),
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
