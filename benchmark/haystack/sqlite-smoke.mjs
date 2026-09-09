// Historical benchmark backend with compiled source ingestion and host element; no provider calls.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeStoreHandles, openStoreHandle } from '../../dist/core/stores.js';
import { prepareProjectRetrievalCorpus, projectRetrievalHash } from '../../dist/projects/retrievalCorpus.js';
import { ProjectRetrievalIndex } from './sqliteBaseline.ts';
import { createProjectRetrievalTool } from '../../dist/tools/projectRetrieval.js';

const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-release-'));
const store = join(root, 'product.db');
const context = { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 };
const source = '# Pricing\r\nAnnual price: 190 euros.\r\n';
let tool;
try {
  writeFileSync(join(root, 'pricing.md'), source);
  const corpus = await prepareProjectRetrievalCorpus(root, {
    version: 1, corpusId: 'release-docs', snapshotId: 'release-1', snapshotSha256: projectRetrievalHash(source),
    documents: [{ path: 'pricing.md', sha256: projectRetrievalHash(source), bytes: Buffer.byteLength(source) }],
  }, context);
  const scope = { kind: 'tenant', orgId: 'org-a', projectId: 'project-a', principalId: 'principal-a', runId: 'run-a',
    corpusId: corpus.manifest.corpusId, snapshotId: corpus.manifest.snapshotId,
    snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation };
  const index = new ProjectRetrievalIndex(openStoreHandle(store, ''));
  await index.build(scope, corpus, context);
  let allowed = true;
  tool = createProjectRetrievalTool({ scope, service: index.createService(scope, async () => allowed) }, context);
  const result = await tool.execute({ query: 'annual price' });
  assert.equal(result.ok, true);
  assert.equal(result.passages[0].excerpt, source);
  assert.equal(result.passages[0].endByte, Buffer.byteLength(source));
  allowed = false;
  assert.deepEqual(await tool.execute({ query: 'annual price' }), { ok: false, status: 'denied' });
  const db = openStoreHandle(store, '');
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(db.prepare('SELECT count(*) FROM project_retrieval_namespaces_v1').pluck().get(), 1);
  console.log(`Historical SQLite FTS5 benchmark smoke passed (${process.version})`);
} finally {
  await tool?.close();
  closeStoreHandles();
  rmSync(root, { recursive: true, force: true });
}
