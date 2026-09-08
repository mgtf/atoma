import { z } from 'zod';
import { projectDocumentDigestSchema } from './projectRetrieval.js';

/** Evaluation-only contracts. These do not declare an L1 search element. */
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const retrievalDigestSchema = projectDocumentDigestSchema;
const relativePath = z.string().min(1).max(240).refine(
  value => /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'expected a normalized relative path'
);
const file = z.object({
  path: relativePath,
  sha256: retrievalDigestSchema,
  bytes: z.number().int().positive().max(256_000),
}).strict();

export const retrievalSnapshotSchema = z.object({
  id,
  orgId: id,
  projectId: id,
  split: z.enum(['development', 'held-out', 'isolation']),
  root: relativePath,
  sha256: retrievalDigestSchema,
  documents: z.array(file).min(1).max(200),
  assets: z.array(file).max(20),
}).strict();

export const retrievalCorpusSchema = z.object({
  version: z.literal(1),
  provenance: z.literal('synthetic; authored for Atoma; no tenant data'),
  license: z.literal('AGPL-3.0-only'),
  snapshots: z.array(retrievalSnapshotSchema).min(1).max(30),
}).strict();

/** Zero-based UTF-8 byte offsets into original source, independent of chunking. */
export const retrievalEvidenceSchema = z.object({
  path: relativePath,
  sha256: retrievalDigestSchema,
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
}).strict().refine(span => span.endByte > span.startByte, 'empty evidence span');

const factValue = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const expectation = z.object({
  key: id,
  value: factValue,
  evidence: z.array(retrievalEvidenceSchema).min(1).max(8),
}).strict();

export const retrievalQuestionSchema = z.object({
  id,
  snapshotId: id,
  category: z.enum(['exact', 'paraphrase', 'cross-language', 'superseded', 'multi-source', 'absent', 'maintenance']),
  language: z.enum(['en', 'fr']),
  prompt: z.string().min(10).max(4000),
  requestedFacts: z.array(z.object({
    key: id,
    valueType: z.enum(['string', 'number', 'boolean', 'null']),
  }).strict()).min(1).max(12),
  answerable: z.boolean(),
  expected: z.array(expectation).max(12),
  maintenance: z.object({
    configPath: relativePath,
    probePath: relativePath,
    referencePath: relativePath,
    referenceSha256: retrievalDigestSchema,
    expectedPreview: z.record(z.unknown()),
  }).strict().optional(),
}).strict().superRefine((q, ctx) => {
  const unique = new Set(q.requestedFacts.map(f => f.key));
  if (unique.size !== q.requestedFacts.length ||
      new Set(q.expected.map(f => f.key)).size !== q.expected.length ||
      (q.answerable && (q.expected.length !== unique.size || q.expected.some(f =>
        !unique.has(f.key) || q.requestedFacts.find(r => r.key === f.key)?.valueType !==
          (f.value === null ? 'null' : typeof f.value)))) ||
      (!q.answerable && q.expected.length !== 0) ||
      (q.category === 'maintenance') !== Boolean(q.maintenance) ||
      ((q.category === 'absent') !== !q.answerable)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent question specification' });
  }
});

export const retrievalQuestionsSchema = z.object({
  version: z.literal(1),
  questions: z.array(retrievalQuestionSchema).min(1).max(500),
}).strict();

export const retrievalAnswerSchema = z.object({
  questionId: id,
  snapshotId: id,
  snapshotSha256: retrievalDigestSchema,
  status: z.enum(['answered', 'not_found']),
  facts: z.array(z.object({
    key: id,
    value: factValue,
    citations: z.array(z.object({
      path: relativePath,
      sha256: retrievalDigestSchema,
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      quote: z.string().min(1).max(8000),
    }).strict()).min(1).max(8),
  }).strict()).max(12),
}).strict();

/** Instrument lock, not a registration of an unexecuted live campaign. */
export const retrievalInstrumentLockSchema = z.object({
  version: z.literal(1),
  status: z.literal('instruments-frozen; live campaign not registered'),
  corpusSha256: retrievalDigestSchema,
  questionsSha256: retrievalDigestSchema,
}).strict();

export type RetrievalSnapshot = z.infer<typeof retrievalSnapshotSchema>;
export type RetrievalCorpus = z.infer<typeof retrievalCorpusSchema>;
export type RetrievalQuestion = z.infer<typeof retrievalQuestionSchema>;
export type RetrievalAnswer = z.infer<typeof retrievalAnswerSchema>;
export type RetrievalEvidence = z.infer<typeof retrievalEvidenceSchema>;

export const retrievalScoreSchema = z.object({
  questionId: id, full: z.boolean(),
  checks: z.array(z.object({ id: z.string(), ok: z.boolean() }).strict()),
}).strict();
export type RetrievalScore = z.infer<typeof retrievalScoreSchema>;
export type RetrievalCheck = RetrievalScore['checks'][number];
