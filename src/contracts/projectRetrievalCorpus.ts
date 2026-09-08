import { z } from 'zod';
import { projectDocumentDigestSchema, projectDocumentPathSchema,
  projectRetrievalIdentitySchema } from './projectRetrieval.js';

export const PROJECT_RETRIEVAL_CORPUS_LIMITS = Object.freeze({
  documents: 200, documentBytes: 256_000, sourceBytes: 8_000_000, passages: 20_000,
});

/** Admission is supplied by the host snapshot owner, never inferred by a crawl. */
export const projectRetrievalManifestSchema = z.object({
  version: z.literal(1),
  corpusId: projectRetrievalIdentitySchema,
  snapshotId: projectRetrievalIdentitySchema,
  // Identity of the authority's snapshot, which may also contain non-indexed assets.
  snapshotSha256: projectDocumentDigestSchema,
  documents: z.array(z.object({
    path: projectDocumentPathSchema.refine(p => /\.(md|txt)$/.test(p), 'expected Markdown or plain text'),
    sha256: projectDocumentDigestSchema,
    bytes: z.number().int().nonnegative().max(PROJECT_RETRIEVAL_CORPUS_LIMITS.documentBytes),
  }).strict().readonly()).max(PROJECT_RETRIEVAL_CORPUS_LIMITS.documents).readonly(),
}).strict().superRefine((m, ctx) => {
  if (new Set(m.documents.map(d => d.path)).size !== m.documents.length ||
      m.documents.reduce((n, d) => n + d.bytes, 0) > PROJECT_RETRIEVAL_CORPUS_LIMITS.sourceBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate paths or oversized corpus' });
  }
}).readonly();
export type ProjectRetrievalManifest = z.infer<typeof projectRetrievalManifestSchema>;

export const projectRetrievalChunkSettingsSchema = z.object({
  maxBytes: z.number().int().min(128).max(4096),
  maxLines: z.number().int().min(1).max(16),
}).strict().readonly();
export type ProjectRetrievalChunkSettings = z.infer<typeof projectRetrievalChunkSettingsSchema>;
export const DEFAULT_PROJECT_RETRIEVAL_CHUNKS = projectRetrievalChunkSettingsSchema.parse({
  maxBytes: 1400, maxLines: 16,
});
export const PROJECT_RETRIEVAL_TOKENIZER = 'unicode61 remove_diacritics 2';

/** Every index-affecting choice is pinned; unsupported future modes fail closed. */
export const projectRetrievalIndexConfigSchema = z.object({
  storageVersion: z.literal(1), extractionVersion: z.literal('utf8-files-v1'),
  chunkerVersion: z.literal('markdown-lines-v1'), chunks: projectRetrievalChunkSettingsSchema,
  contextVersion: z.literal('path-headings-source-v1'),
  tokenizer: z.literal(PROJECT_RETRIEVAL_TOKENIZER),
  normalization: z.literal('original-bytes; no overlap'),
  embedding: z.null(), generatedContext: z.null(),
}).strict().readonly();
export type ProjectRetrievalIndexConfig = z.infer<typeof projectRetrievalIndexConfigSchema>;

// Query-only policy. Changing weights does not rebuild unchanged source passages.
export const PROJECT_RETRIEVAL_BM25 = Object.freeze({ version: 'bm25-or-v1', contextWeight: 1, textWeight: 1 });
