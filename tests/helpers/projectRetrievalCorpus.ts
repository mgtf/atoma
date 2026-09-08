import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectRetrievalScope } from '../../src/contracts/projectRetrieval.js';
import { prepareProjectRetrievalCorpus, projectRetrievalHash, type PreparedProjectRetrievalCorpus } from '../../src/projects/retrievalCorpus.js';

export function retrievalContext(timeoutMs = 30_000, signal = new AbortController().signal) {
  return { signal, deadlineAt: Date.now() + timeoutMs };
}

export function documentManifest(root: string, files: Record<string, string | Buffer>) {
  const documents = Object.entries(files).map(([path, content]) => {
    const bytes = Buffer.from(content);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: projectRetrievalHash(bytes), bytes: bytes.length };
  });
  return { version: 1 as const, corpusId: 'docs', snapshotId: 'snapshot-1',
    snapshotSha256: projectRetrievalHash(JSON.stringify(documents)), documents };
}

export async function prepareTestCorpus(root: string, files: Record<string, string | Buffer>) {
  return prepareProjectRetrievalCorpus(root, documentManifest(root, files), retrievalContext());
}

export function corpusScope(corpus: PreparedProjectRetrievalCorpus, overrides: Partial<ProjectRetrievalScope> = {}): ProjectRetrievalScope {
  return { kind: 'tenant', runId: 'run-1', orgId: 'org-a', projectId: 'project-a', principalId: 'principal-a',
    corpusId: corpus.manifest.corpusId, snapshotId: corpus.manifest.snapshotId,
    snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation, ...overrides };
}
