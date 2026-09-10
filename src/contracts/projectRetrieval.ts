import { z } from 'zod';
import { HOST_TOOL_NAMES } from './toolTaxonomy.js';

export const PROJECT_RETRIEVAL_TOOL_NAME = HOST_TOOL_NAMES[0];
export const projectDocumentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const projectRetrievalIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const identity = projectRetrievalIdentitySchema;
const sourceBinding = {
  corpusId: identity,
  snapshotId: identity,
  snapshotSha256: projectDocumentDigestSchema,
  generation: projectDocumentDigestSchema,
};

/** Host construction only. No field of this shape is a model argument. */
export const projectRetrievalScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), runId: identity, ...sourceBinding }).strict(),
  z.object({ kind: z.literal('tenant'), runId: identity, orgId: identity,
    projectId: identity, principalId: identity, ...sourceBinding }).strict(),
]).readonly();
export type ProjectRetrievalScope = z.infer<typeof projectRetrievalScopeSchema>;

export const projectDocumentPathSchema = z.string().min(1).max(512).refine(path =>
  !/[\\:]/.test(path) &&
  !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
'expected a normalized relative document path');
export const PROJECT_DOCUMENT_FORMATS = ['md', 'txt', 'csv', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'] as const;
export const projectDocumentFormatSchema = z.enum(PROJECT_DOCUMENT_FORMATS);
export function projectDocumentFormat(path: string): z.infer<typeof projectDocumentFormatSchema> | null {
  const parsed = projectDocumentFormatSchema.safeParse(path.split('.').at(-1)?.toLowerCase());
  return parsed.success ? parsed.data : null;
}
export function isPlainProjectDocument(path: string): boolean {
  return ['md', 'txt', 'csv'].includes(projectDocumentFormat(path) ?? '');
}

/** Optional narrowing only; authority and snapshot are always host-owned. */
export const projectRetrievalFiltersSchema = z.object({
  paths: z.array(projectDocumentPathSchema).min(1).max(20).optional(),
  directories: z.array(projectDocumentPathSchema).min(1).max(20).optional(),
  formats: z.array(projectDocumentFormatSchema).min(1).max(PROJECT_DOCUMENT_FORMATS.length).optional(),
}).strict();
export type ProjectRetrievalFilters = z.infer<typeof projectRetrievalFiltersSchema>;

export function matchesProjectRetrievalFilters(path: string, filters?: ProjectRetrievalFilters): boolean {
  return !filters || ((!filters.paths || filters.paths.includes(path)) &&
    (!filters.directories || filters.directories.some(directory => path.startsWith(directory + '/'))) &&
    (!filters.formats || filters.formats.some(format => projectDocumentFormat(path) === format)));
}

export const projectRetrievalRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  filters: projectRetrievalFiltersSchema.optional(),
  limit: z.number().int().min(1).max(10).optional(),
  maxExcerptBytes: z.number().int().min(128).max(4096).optional(),
}).strict();
export type ProjectRetrievalRequest = z.infer<typeof projectRetrievalRequestSchema>;

export const projectRetrievalLimitsSchema = z.object({
  maxQueryBytes: z.number().int().min(128).max(2048),
  maxResults: z.number().int().min(1).max(10),
  maxCandidates: z.number().int().min(1).max(100),
  maxExcerptBytes: z.number().int().min(128).max(4096),
  // Below the existing 20,000-character model-facing truncation threshold.
  maxResponseBytes: z.number().int().min(1024).max(16000),
  timeoutMs: z.number().int().min(1).max(30000),
}).strict().refine(l => l.maxCandidates >= l.maxResults, 'candidate limit is below result limit').readonly();
export type ProjectRetrievalLimits = z.infer<typeof projectRetrievalLimitsSchema>;
export const DEFAULT_PROJECT_RETRIEVAL_LIMITS = projectRetrievalLimitsSchema.parse({
  maxQueryBytes: 2048, maxResults: 5, maxCandidates: 50,
  maxExcerptBytes: 1600, maxResponseBytes: 12000, timeoutMs: 2000,
});

/** Materialized backend query; terms are data, never a raw FTS expression. */
export const projectRetrievalQuerySchema = z.object({
  text: projectRetrievalRequestSchema.shape.query,
  filters: projectRetrievalFiltersSchema.optional(),
  terms: z.array(z.string().min(1).max(128)).min(1).max(32).readonly(),
  limit: z.number().int().min(1).max(10),
  maxExcerptBytes: z.number().int().min(128).max(4096),
  maxCandidates: z.number().int().min(1).max(100),
}).strict().readonly();
export type ProjectRetrievalQuery = z.infer<typeof projectRetrievalQuerySchema>;

export function parseProjectRetrievalQuery(
  input: unknown, limits: ProjectRetrievalLimits
): ProjectRetrievalQuery | null {
  const parsed = projectRetrievalRequestSchema.safeParse(input);
  if (!parsed.success || Buffer.byteLength(parsed.data.query, 'utf8') > limits.maxQueryBytes) return null;
  const terms = [...new Set(parsed.data.query.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])];
  const query = projectRetrievalQuerySchema.safeParse({
    text: parsed.data.query.normalize('NFC'),
    ...(parsed.data.filters ? { filters: parsed.data.filters } : {}),
    terms, limit: Math.min(parsed.data.limit ?? limits.maxResults, limits.maxResults),
    maxExcerptBytes: Math.min(parsed.data.maxExcerptBytes ?? limits.maxExcerptBytes, limits.maxExcerptBytes),
    maxCandidates: limits.maxCandidates,
  });
  return query.success ? query.data : null;
}

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const extractedTextSchema = z.object({
  kind: z.literal('extracted-text'), version: z.literal('officeparser-7.8.0-v1'),
  sha256: projectDocumentDigestSchema, bytes: z.number().int().nonnegative().max(1_000_000),
}).strict();

/** Copyable source reference; the quote retains original line endings. */
export const projectRetrievalCitationSchema = z.object({
  path: projectDocumentPathSchema, sha256: projectDocumentDigestSchema,
  extraction: extractedTextSchema.optional(),
  startLine: line, endLine: line, quote: z.string().min(1).max(4096),
}).strict();

export const projectRetrievalPassageSchema = z.object({
  documentId: projectDocumentDigestSchema,
  path: projectDocumentPathSchema,
  sha256: projectDocumentDigestSchema,
  extraction: extractedTextSchema.optional(),
  startByte: offset, endByte: offset,
  startLine: line, endLine: line,
  headingContext: z.array(z.string().max(256)).max(6),
  excerpt: z.string().min(1).max(4096),
  score: z.number().finite().optional(),
  citation: projectRetrievalCitationSchema.optional(),
}).strict().superRefine((p, ctx) => {
  const bytes = Buffer.byteLength(p.excerpt, 'utf8');
  const lines = p.excerpt.split('\n').length - (p.excerpt.endsWith('\n') ? 1 : 0);
  if (bytes > 4096 || p.endByte - p.startByte !== bytes ||
      p.endLine - p.startLine + 1 !== lines || p.excerpt.includes('\0') ||
      Buffer.from(p.excerpt, 'utf8').toString('utf8') !== p.excerpt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent original-source span' });
  }
  if ((!isPlainProjectDocument(p.path) && !p.extraction) ||
      (p.extraction && (isPlainProjectDocument(p.path) || p.endByte > p.extraction.bytes))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing or inconsistent extracted-text reference' });
  }
  if (p.citation && (JSON.stringify(p.citation.extraction) !== JSON.stringify(p.extraction) || p.citation.path !== p.path || p.citation.sha256 !== p.sha256 ||
      p.citation.startLine !== p.startLine || p.citation.endLine !== p.endLine || p.citation.quote !== p.excerpt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'citation differs from original-source span' });
  }
});
export type ProjectRetrievalPassage = z.infer<typeof projectRetrievalPassageSchema>;

export function projectRetrievalCitation(passage: ProjectRetrievalPassage): z.infer<typeof projectRetrievalCitationSchema> {
  return { path: passage.path, sha256: passage.sha256, ...(passage.extraction ? { extraction: passage.extraction } : {}), startLine: passage.startLine,
    endLine: passage.endLine, quote: passage.excerpt };
}

export const projectRetrievalResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: z.literal('ok'), ...sourceBinding,
    passages: z.array(projectRetrievalPassageSchema).max(100), truncated: z.boolean() }).strict(),
  z.object({ ok: z.literal(false),
    status: z.enum(['denied', 'invalid_request', 'unavailable', 'cancelled', 'timed_out']) }).strict(),
]);
export type ProjectRetrievalResponse = z.infer<typeof projectRetrievalResponseSchema>;
export type ProjectRetrievalFailure = Extract<ProjectRetrievalResponse, { ok: false }>;
