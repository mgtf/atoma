// Reproducible mechanical capacity probe; no LLM, gold questions or relevance claims.
// Run after build: node --import tsx benchmark/haystack/sqlite-measure.mjs > measurement.json
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { closeStoreHandles, openStoreHandle } from '../../dist/core/stores.js';
import { prepareProjectRetrievalCorpus, projectRetrievalHash } from '../../dist/projects/retrievalCorpus.js';
import { ProjectRetrievalIndex } from './sqliteBaseline.ts';
import { DEFAULT_PROJECT_RETRIEVAL_LIMITS, parseProjectRetrievalQuery } from '../../dist/contracts/projectRetrieval.js';

const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-measure-'));
const store = join(root, 'product.db');
const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 120_000 });
const delay = monitorEventLoopDelay({ resolution: 10 });
const initialRss = process.memoryUsage().rss;
let maxSampledRss = initialRss;
const sampleMemory = () => { maxSampledRss = Math.max(maxSampledRss, process.memoryUsage().rss); };
const sampler = setInterval(sampleMemory, 10);
delay.enable();
let locker;
try {
  const documents = [];
  for (let d = 0; d < 200; d++) {
    const text = Array.from({ length: 100 }, (_, s) =>
      `## Record ${s}\nThe annual price for product sku${d}item${s} is ${100 + s} euros. ` +
      'Delivery uses regional storage. Support replies within two business days.\n').join('');
    const path = `document-${String(d).padStart(3, '0')}.md`;
    writeFileSync(join(root, path), text);
    documents.push({ path, sha256: projectRetrievalHash(text), bytes: Buffer.byteLength(text) });
  }
  const manifest = { version: 1, corpusId: 'capacity-probe', snapshotId: 'synthetic-200x100-v1',
    snapshotSha256: projectRetrievalHash(JSON.stringify(documents)), documents };
  const ingestionStart = performance.now();
  const corpus = await prepareProjectRetrievalCorpus(root, manifest, context());
  const ingestionMs = performance.now() - ingestionStart;
  sampleMemory();
  assert.equal(corpus.passages.length, 20_000);
  const scope = { kind: 'tenant', orgId: 'probe-org', projectId: 'probe-project', principalId: 'probe-principal', runId: 'probe-run',
    corpusId: manifest.corpusId, snapshotId: manifest.snapshotId, snapshotSha256: manifest.snapshotSha256, generation: corpus.generation };
  const index = new ProjectRetrievalIndex(openStoreHandle(store, ''));
  const db = openStoreHandle(store, '');
  const pages = () => db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  const initialStoreBytes = pages();
  const buildStart = performance.now();
  await index.build(scope, corpus, context());
  const buildMs = performance.now() - buildStart;
  const firstIndexAllocatedBytes = pages() - initialStoreBytes;
  const ftsTablesPerGeneration = db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'project_retrieval_fts_v1_%'").pluck().get();
  const samples = [];
  for (const text of ['annual price', 'sku101item42', 'price annual delivery regional storage support replies business days']) {
    const durations = [];
    const query = parseProjectRetrievalQuery({ query: text }, DEFAULT_PROJECT_RETRIEVAL_LIMITS);
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      const result = index.search(scope, query, context());
      durations.push(performance.now() - started);
      assert.equal(result.ok, true);
      assert.ok(result.passages.length > 0);
      await setImmediate();
    }
    durations.sort((a, b) => a - b);
    samples.push({ query: text, n: durations.length, minMs: durations[0], p50Ms: durations[14], p95Ms: durations[28], maxMs: durations[29] });
  }
  const rebuildStart = performance.now();
  await index.build(scope, corpus, context());
  const rebuildMs = performance.now() - rebuildStart;
  assert.equal(index.collectGarbage(Date.now() + 1), 1);
  const otherStart = performance.now();
  await index.build({ ...scope, projectId: 'second-project' }, corpus, context());
  const secondNamespaceBuildMs = performance.now() - otherStart;
  const empty = await prepareProjectRetrievalCorpus(root, { ...manifest, documents: [] }, context());
  const emptyScope = { ...scope, projectId: 'contended-project', generation: empty.generation };
  locker = new Database(store);
  locker.exec('BEGIN IMMEDIATE');
  const release = setTimeout(() => locker.exec('ROLLBACK'), 40);
  const contentionStart = performance.now();
  try { await index.build(emptyScope, empty, context()); } finally { clearTimeout(release); }
  const contendedEmptyBuildMs = performance.now() - contentionStart;
  sampleMemory();
  console.log(JSON.stringify({
    kind: 'mechanical-capacity-probe; synthetic; no relevance or RAG gain claim',
    measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    sqlite: db.prepare('SELECT sqlite_version()').pluck().get(),
    fixture: { generator: 'synthetic-200x100-v1', documents: 200, sourceBytes: documents.reduce((n, d) => n + d.bytes, 0),
      passages: corpus.passages.length, generation: corpus.generation },
    config: corpus.config, queryLimits: DEFAULT_PROJECT_RETRIEVAL_LIMITS,
    ingestionMs, buildMs, rebuildMs, secondNamespaceBuildMs, firstIndexAllocatedBytes, ftsTablesPerGeneration,
    samples, contention: { releaseScheduledAfterMs: 40, contendedEmptyBuildMs },
    memory: { initialRss, maxSampledRss, sampledIncreaseBytes: maxSampledRss - initialRss, samplingMs: 10 },
    eventLoop: { resolutionMs: 10, p95DelayMs: delay.percentile(95) / 1e6, maxDelayMs: delay.max / 1e6 },
    finalNamespaces: db.prepare('SELECT count(*) FROM project_retrieval_namespaces_v1').pluck().get(),
    finalAllocatedStoreBytes: pages(),
  }, null, 2));
} finally {
  clearInterval(sampler); delay.disable(); locker?.close(); closeStoreHandles();
  rmSync(root, { recursive: true, force: true });
}
