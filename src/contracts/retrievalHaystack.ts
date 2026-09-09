import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { projectDocumentDigestSchema } from './projectRetrieval.js';

export const HAYSTACK_VERSION = '3.1.1';
export const HAYSTACK_FRAME_BYTES = 32 * 1024 * 1024;
export const HAYSTACK_REPLY_BYTES = 32 * 1024;
const localPath = z.string().min(1).refine(isAbsolute, 'expected a host absolute path');
/** Host configuration only. Model files must be provisioned before a run. */
export const haystackSettingsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bm25') }).strict(),
  z.object({ mode: z.literal('hybrid-rerank'), embeddingPath: localPath, rerankerPath: localPath,
    queryPrefix: z.string().max(1000),
    embeddingRevision: projectDocumentDigestSchema, rerankerRevision: projectDocumentDigestSchema }).strict(),
]);
export const HAYSTACK_LAUNCH_ENV = 'ATOMA_PROJECT_RETRIEVAL_HAYSTACK';
export const haystackLaunchSchema = z.object({ python: localPath, settings: haystackSettingsSchema,
  runtimeSha256: projectDocumentDigestSchema }).strict();
export type HaystackLaunch = z.infer<typeof haystackLaunchSchema>;
export type HaystackSettings = z.infer<typeof haystackSettingsSchema>;
export const haystackReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), id: z.literal(0), version: z.literal(HAYSTACK_VERSION),
    documents: z.number().int().nonnegative(), runtimeSha256: projectDocumentDigestSchema.optional() }).strict(),
  z.object({ kind: z.literal('result'), id: z.number().int().positive(),
    hits: z.array(z.object({ id: projectDocumentDigestSchema, score: z.number().finite() }).strict()).max(100) }).strict(),
  z.object({ kind: z.literal('error'), id: z.number().int().nonnegative() }).strict(),
]);
export type HaystackReply = z.infer<typeof haystackReplySchema>;
