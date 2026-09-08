import { vi } from 'vitest';
import {
  projectRetrievalScopeSchema, type ProjectRetrievalPassage, type ProjectRetrievalResponse,
  type ProjectRetrievalScope, type ProjectRetrievalQuery,
} from '../../src/contracts/projectRetrieval.js';
import type { ProjectRetrievalCallContext } from '../../src/tools/projectRetrieval.js';

export function retrievalDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export function retrievalTestScope() {
  return projectRetrievalScopeSchema.parse({
    kind: 'operator', runId: 'test-run', corpusId: 'test-corpus', snapshotId: 'test-snapshot',
    snapshotSha256: 'a'.repeat(64), generation: 'b'.repeat(64),
  });
}

export function retrievalTestPassage(excerpt = 'The annual price is 19000 cents.\n'): ProjectRetrievalPassage {
  return { documentId: 'c'.repeat(64), path: 'docs/billing.md', sha256: 'd'.repeat(64),
    startByte: 0, endByte: Buffer.byteLength(excerpt, 'utf8'),
    startLine: 1, endLine: excerpt.split('\n').length - (excerpt.endsWith('\n') ? 1 : 0),
    headingContext: ['Billing'], excerpt };
}

export function retrievalTestResult(passages = [retrievalTestPassage()]): ProjectRetrievalResponse {
  const scope = retrievalTestScope();
  return { ok: true, status: 'ok', corpusId: scope.corpusId, snapshotId: scope.snapshotId,
    snapshotSha256: scope.snapshotSha256, generation: scope.generation, passages, truncated: false };
}

export function retrievalTestBinding() {
  return { scope: retrievalTestScope(), service: {
    authorize: vi.fn(async (_scope: ProjectRetrievalScope, _context: ProjectRetrievalCallContext) => true),
    search: vi.fn(async (_scope: ProjectRetrievalScope, _query: ProjectRetrievalQuery,
      _context: ProjectRetrievalCallContext): Promise<ProjectRetrievalResponse> => retrievalTestResult()),
    dispose: vi.fn(async () => {}),
  } };
}
