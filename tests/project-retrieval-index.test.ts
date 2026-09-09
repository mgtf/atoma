import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_RETRIEVAL_LIMITS, parseProjectRetrievalQuery, type ProjectRetrievalScope } from '../src/contracts/projectRetrieval.js';
import { ProjectRetrievalIndex } from '../benchmark/haystack/sqliteBaseline.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import { corpusScope, documentManifest, prepareTestCorpus, retrievalContext } from './helpers/projectRetrievalCorpus.js';

let root: string, db: Database.Database, index: ProjectRetrievalIndex;
const query = (text = 'price') => parseProjectRetrievalQuery({ query: text }, DEFAULT_PROJECT_RETRIEVAL_LIMITS)!;
function activeTable(connection = db): string {
  const row = connection.prepare('SELECT active_table FROM project_retrieval_namespaces_v1 WHERE active_table IS NOT NULL').get() as { active_table: string };
  return `project_retrieval_fts_v1_${row.active_table}`;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-index-'));
  db = new Database(':memory:');
  db.exec('CREATE TABLE product_state (value TEXT); INSERT INTO product_state VALUES (\'preserved\')');
  index = new ProjectRetrievalIndex(db);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('project-private SQLite FTS5 backend', () => {
  it('builds and searches original passages in the existing database, with stable BM25 ties', async () => {
    const corpus = await prepareTestCorpus(root, { 'b.md': '# Price\nAnnual price is 190 euros.\n', 'a.md': '# Price\nAnnual price is 190 euros.\n' });
    const scope = corpusScope(corpus);
    await index.build(scope, corpus, retrievalContext());
    const first = index.search(scope, query(), retrievalContext());
    expect(first).toMatchObject({ ok: true, generation: corpus.generation, passages: [{ path: 'a.md' }, { path: 'b.md' }] });
    expect(index.search(scope, query(), retrievalContext())).toEqual(first);
    expect(db.prepare('SELECT value FROM product_state').pluck().get()).toBe('preserved');
    expect(db.pragma('database_list')).toEqual([expect.objectContaining({ name: 'main', file: '' })]);
    await index.build(scope, corpus, retrievalContext());
    expect(index.search(scope, query(), retrievalContext())).toEqual(first);
  });

  it('keeps ranking statistics, candidates and identical paths private to each project and operator namespace', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': 'price alpha\n', 'b.md': 'price beta beta\n' });
    const scope = corpusScope(corpus);
    await index.build(scope, corpus, retrievalContext());
    const before = index.search(scope, query(), retrievalContext());
    const foreign = await prepareTestCorpus(root, { 'a.md': 'SECRET price '.repeat(1000), 'b.md': 'Other private price\n' });
    for (const overrides of [{ orgId: 'org-b' }, { projectId: 'project-b' }, { kind: 'operator' as const }]) {
      const scoped: ProjectRetrievalScope = overrides.kind === 'operator' ? {
        kind: 'operator', runId: scope.runId, corpusId: foreign.manifest.corpusId,
        snapshotId: foreign.manifest.snapshotId, snapshotSha256: foreign.manifest.snapshotSha256, generation: foreign.generation,
      } : corpusScope(foreign, overrides);
      await index.build(scoped, foreign, retrievalContext());
      const privateResult = index.search(scoped, query('SECRET'), retrievalContext());
      expect(privateResult.ok).toBe(true);
      if (privateResult.ok) {
        expect(privateResult.passages.length).toBeGreaterThan(0);
        expect(privateResult.passages.every(p => p.path === 'a.md' && p.excerpt.includes('SECRET'))).toBe(true);
      }
    }
    expect(index.search(scope, query(), retrievalContext())).toEqual(before);
    expect(index.search(scope, query('SECRET'), retrievalContext())).toMatchObject({ ok: true, passages: [] });
    expect(db.prepare('SELECT count(*) FROM project_retrieval_namespaces_v1').pluck().get()).toBe(4);
  });

  it('quotes FTS operators and punctuation as words instead of accepting an FTS expression', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': 'literal OR NEAR word\n', 'b.md': 'unrelated content\n', 'c.md': 'Décision café\n' });
    const scope = corpusScope(corpus);
    await index.build(scope, corpus, retrievalContext());
    for (const term of ['OR', 'NEAR()', '"OR" *', 'OR"; DROP TABLE product_state; --']) {
      expect(index.search(scope, query(term), retrievalContext())).toMatchObject({ ok: true, passages: [expect.objectContaining({ path: 'a.md' })] });
    }
    expect(index.search(scope, query('cafe'), retrievalContext())).toMatchObject({ ok: true, passages: [expect.objectContaining({ path: 'c.md' })] });
    expect(db.prepare('SELECT count(*) FROM product_state').pluck().get()).toBe(1);
  });

  it('distinguishes empty results from missing, stale or wrongly bound indexes', async () => {
    const corpus = await prepareTestCorpus(root, {});
    const scope = corpusScope(corpus);
    expect(index.search(scope, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
    await index.build(scope, corpus, retrievalContext());
    expect(index.search(scope, query(), retrievalContext())).toMatchObject({ ok: true, passages: [], truncated: false });
    for (const wrong of [{ generation: 'f'.repeat(64) }, { snapshotId: 'wrong' }, { corpusId: 'wrong' }, { snapshotSha256: 'f'.repeat(64) }]) {
      expect(index.search({ ...scope, ...wrong }, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
    }
    await expect(index.build({ ...scope, generation: 'f'.repeat(64) }, corpus, retrievalContext())).rejects.toThrow('binding mismatch');
  });

  it('bounds candidates/results, retains separate source spans, and drops whole oversize quotes', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': Array.from({ length: 20 }, (_, n) => `# Section ${n}\nprice ${'long '.repeat(100)}\n`).join('') });
    const scope = corpusScope(corpus);
    await index.build(scope, corpus, retrievalContext());
    const result = index.search(scope, { ...query(), limit: 2, maxCandidates: 3 }, retrievalContext());
    expect(result).toMatchObject({ ok: true, passages: [expect.anything(), expect.anything()], truncated: true });
    if (result.ok) expect(new Set(result.passages.map(p => p.startByte)).size).toBe(2);
    expect(index.search(scope, { ...query(), maxExcerptBytes: 128 }, retrievalContext())).toMatchObject({ ok: true, passages: [], truncated: true });
  });

  it('keeps the old generation readable until an atomic publication and never serves half a new one', async () => {
    const old = await prepareTestCorpus(root, { 'a.md': 'Old price\n' });
    const oldScope = corpusScope(old);
    await index.build(oldScope, old, retrievalContext());
    const next = await prepareTestCorpus(root, { 'a.md': '# New price\nnew price\n'.repeat(300) });
    const nextScope = corpusScope(next);
    const build = index.build(nextScope, next, retrievalContext());
    await setImmediate();
    expect(index.search(oldScope, query(), retrievalContext())).toMatchObject({ ok: true });
    expect(index.search(nextScope, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
    await build;
    expect(index.search(oldScope, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
    expect(index.search(nextScope, query(), retrievalContext())).toMatchObject({ ok: true });
    expect(index.collectGarbage(Date.now() + 1)).toBe(1);
    expect(index.search(nextScope, query(), retrievalContext())).toMatchObject({ ok: true });
  });

  it('does not let a staged build resurrect an invalidated namespace', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': '# Price\nprice\n'.repeat(300) });
    const scope = corpusScope(corpus);
    const build = index.build(scope, corpus, retrievalContext());
    const failure = expect(build).rejects.toThrow('superseded');
    await setImmediate();
    index.invalidate(scope);
    await failure;
    expect(index.search(scope, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
    expect(index.collectGarbage(Date.now() + 1)).toBe(1);
  });

  it('publishes only one of two competing builds', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': '# Price\nprice\n'.repeat(300) });
    const scope = corpusScope(corpus);
    const builds = await Promise.allSettled([index.build(scope, corpus, retrievalContext()), index.build(scope, corpus, retrievalContext())]);
    expect(builds.filter(b => b.status === 'fulfilled')).toHaveLength(1);
    expect(builds.filter(b => b.status === 'rejected')).toHaveLength(1);
    expect(index.search(scope, query(), retrievalContext())).toMatchObject({ ok: true });
  });

  it('cancels a build between bounded batches without publishing its table', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': '# Price\nprice\n'.repeat(300) });
    const scope = corpusScope(corpus);
    const abort = new AbortController();
    const build = index.build(scope, corpus, retrievalContext(30_000, abort.signal));
    const failure = expect(build).rejects.toThrow();
    await setImmediate(); abort.abort(); await failure;
    expect(index.search(scope, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
    expect(index.collectGarbage(Date.now() + 1)).toBe(1);
  });

  it.each(['malformed', 'changed', 'missing-row', 'missing-table', 'wrong-metadata'])('fails closed for a corrupt cache: %s', async corruption => {
    const corpus = await prepareTestCorpus(root, { 'a.md': 'price is private\n' });
    const scope = corpusScope(corpus);
    await index.build(scope, corpus, retrievalContext());
    const table = activeTable();
    if (corruption === 'malformed') db.exec(`UPDATE ${table} SET evidence = '{'`);
    if (corruption === 'changed') db.exec(`UPDATE ${table} SET excerpt = 'changed price'`);
    if (corruption === 'missing-row') db.exec(`DELETE FROM ${table}`);
    if (corruption === 'missing-table') db.exec(`DROP TABLE ${table}`);
    if (corruption === 'wrong-metadata') db.exec("UPDATE project_retrieval_generations_v1 SET config_json = '{}'");
    expect(index.search(scope, query(), retrievalContext())).toEqual({ ok: false, status: 'unavailable' });
  });

  it('enforces cancellation/deadlines, current authority and exact run/principal pins through the real host element', async () => {
    const corpus = await prepareTestCorpus(root, { 'a.md': 'price is private\n' });
    const scope = corpusScope(corpus);
    await index.build(scope, corpus, retrievalContext());
    const authority = vi.fn(async () => true);
    const service = index.createService(scope, authority);
    const tool = createProjectRetrievalTool({ scope, service }, retrievalContext());
    expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true });
    expect(await service.authorize({ ...scope, principalId: 'other' } as ProjectRetrievalScope, retrievalContext())).toBe(false);
    authority.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await tool.execute({ query: 'price' })).toEqual({ ok: false, status: 'denied' });
    expect(index.search(scope, query(), retrievalContext(-1))).toEqual({ ok: false, status: 'timed_out' });
    expect(index.search(scope, query(), retrievalContext(1000, AbortSignal.abort()))).toEqual({ ok: false, status: 'cancelled' });
    await tool.close();
    expect(await service.authorize(scope, retrievalContext())).toBe(false);
    expect(db.open).toBe(true);
  });

  it('yields during contention on the same product file, respects deadline, and restores connection policy', async () => {
    const file = join(root, 'product.db');
    const writer = new Database(file), reader = new Database(file);
    try {
      writer.pragma('journal_mode = WAL');
      const shared = new ProjectRetrievalIndex(reader);
      const corpus = await prepareTestCorpus(root, { 'a.md': 'price\n' });
      writer.exec('BEGIN IMMEDIATE');
      let heartbeat = false;
      const turn = setImmediate().then(() => { heartbeat = true; });
      const started = Date.now();
      await expect(shared.build(corpusScope(corpus), corpus, retrievalContext(60))).rejects.toThrow('deadline');
      await turn;
      expect(heartbeat).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(reader.pragma('busy_timeout', { simple: true })).toBe(5000);
      writer.exec('ROLLBACK');
      await shared.build(corpusScope(corpus), corpus, retrievalContext());
    } finally { writer.close(); reader.close(); }
  });

  it('recovers after a process exits with a committed partial build, using the same on-disk product store', async () => {
    const manifest = documentManifest(root, { 'a.md': '# Price\nprice\n'.repeat(300) });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    const file = join(root, 'crash.db');
    const code = `
      import Database from 'better-sqlite3';
      import { readFileSync } from 'node:fs';
      import { prepareProjectRetrievalCorpus } from './src/projects/retrievalCorpus.ts';
      import { ProjectRetrievalIndex } from './benchmark/haystack/sqliteBaseline.ts';
      const [root, file] = process.argv.slice(1);
      const db = new Database(file); db.pragma('journal_mode = WAL');
      const index = new ProjectRetrievalIndex(db);
      const context = { signal: new AbortController().signal, deadlineAt: Date.now() + 30000 };
      const corpus = await prepareProjectRetrievalCorpus(root, JSON.parse(readFileSync(root + '/manifest.json', 'utf8')), context);
      const scope = { kind: 'operator', runId: 'run', corpusId: corpus.manifest.corpusId, snapshotId: corpus.manifest.snapshotId,
        snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation };
      setImmediate(() => process.exit(42));
      await index.build(scope, corpus, context);
      process.exit(1);
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, root, file], { cwd: resolve('.'), encoding: 'utf8', timeout: 10_000 });
    expect(child.status, child.stderr).toBe(42);
    const recoveredDb = new Database(file);
    try {
      const recovered = new ProjectRetrievalIndex(recoveredDb);
      expect(recoveredDb.prepare('SELECT status FROM project_retrieval_generations_v1').pluck().get()).toBe('building');
      expect(recoveredDb.prepare('SELECT active_table FROM project_retrieval_namespaces_v1').pluck().get()).toBe(null);
      expect(recovered.collectGarbage(Date.now() + 1)).toBe(1);
      const corpus = await prepareTestCorpus(root, { 'a.md': 'price after recovery\n' });
      await recovered.build(corpusScope(corpus), corpus, retrievalContext());
      expect(recovered.search(corpusScope(corpus), query(), retrievalContext())).toMatchObject({ ok: true });
    } finally { recoveredDb.close(); }
  });
});
