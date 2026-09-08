import { randomUUID } from 'node:crypto';
import { setImmediate, setTimeout } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { openStoreHandle, storeDbPath } from '../core/stores.js';
import { PROJECT_RETRIEVAL_BM25, PROJECT_RETRIEVAL_CORPUS_LIMITS, PROJECT_RETRIEVAL_TOKENIZER,
  projectRetrievalIndexConfigSchema } from '../contracts/projectRetrievalCorpus.js';
import { projectDocumentDigestSchema, projectRetrievalPassageSchema, projectRetrievalQuerySchema,
  projectRetrievalScopeSchema, type ProjectRetrievalScope, type ProjectRetrievalQuery,
  type ProjectRetrievalPassage, type ProjectRetrievalResponse } from '../contracts/projectRetrieval.js';
import type { ProjectRetrievalCallContext, ProjectRetrievalService } from '../tools/projectRetrieval.js';
import { assertRetrievalTime, canonicalRetrievalManifest, projectRetrievalHash, retrievalDocumentId,
  retrievalGeneration, retrievalPassageContext, type PreparedProjectRetrievalCorpus } from './retrievalCorpus.js';

/** Disposable v1 tables. A format change gets an explicit rebuild, never a migration. */
export const PROJECT_RETRIEVAL_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS project_retrieval_namespaces_v1 (
  namespace TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0,
  active_table TEXT
);
CREATE TABLE IF NOT EXISTS project_retrieval_generations_v1 (
  table_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  generation TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready')),
  passage_count INTEGER NOT NULL,
  touched_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_retrieval_generations_namespace_v1
  ON project_retrieval_generations_v1(namespace);
`;

interface NamespaceRow { epoch: number; active_table: string | null }
interface GenerationRow {
  table_id: string; namespace: string; generation: string; manifest_json: string;
  config_json: string; status: string; passage_count: number;
}
interface PassageRow { excerpt: string; context: string; evidence: string; checksum: string; score: number }

function namespaceFor(scope: ProjectRetrievalScope): string {
  // An operator corpus cannot alias a tenant corpus. Principal/run rights are re-asked by the service.
  return projectRetrievalHash(JSON.stringify(scope.kind === 'tenant' ?
    [scope.kind, scope.orgId, scope.projectId, scope.corpusId] : [scope.kind, scope.corpusId]));
}

function tableFor(id: string): string {
  // The only interpolated SQL identifier: a host-created hash, checked again on every read/drop.
  return `project_retrieval_fts_v1_${projectDocumentDigestSchema.parse(id)}`;
}

function matchesSource(scope: ProjectRetrievalScope, corpus: PreparedProjectRetrievalCorpus): boolean {
  return scope.generation === corpus.generation && scope.corpusId === corpus.manifest.corpusId &&
    scope.snapshotId === corpus.manifest.snapshotId && scope.snapshotSha256 === corpus.manifest.snapshotSha256;
}

/** Use SQLite's immediate BUSY result, never its default blocking five-second wait. */
function withoutBusyWait<T>(db: Database.Database, operation: () => T): T {
  const previous = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try { return operation(); } finally { db.pragma(`busy_timeout = ${previous}`); }
}

async function writeBatch<T>(db: Database.Database, context: ProjectRetrievalCallContext, operation: () => T): Promise<T> {
  for (;;) {
    assertRetrievalTime(context);
    try {
      return withoutBusyWait(db, () => db.transaction(() => {
        const result = operation();
        assertRetrievalTime(context);
        return result;
      }).immediate());
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'SQLITE_BUSY') throw error;
      await setTimeout(Math.min(10, Math.max(1, context.deadlineAt - Date.now())), undefined, { signal: context.signal });
    }
  }
}

/** Host-only cache over the primary product store. It owns no database lifetime. */
export class ProjectRetrievalIndex {
  constructor(private readonly db: Database.Database) { db.exec(PROJECT_RETRIEVAL_CACHE_DDL); }

  static open(path = storeDbPath()): ProjectRetrievalIndex {
    return new ProjectRetrievalIndex(openStoreHandle(path, PROJECT_RETRIEVAL_CACHE_DDL));
  }

  /** A cancelled/crashed build remains unreachable until explicit garbage collection. */
  async build(inputScope: ProjectRetrievalScope, corpus: PreparedProjectRetrievalCorpus,
    context: ProjectRetrievalCallContext): Promise<{ generation: string; passages: number }> {
    const scope = projectRetrievalScopeSchema.parse(inputScope);
    const manifest = canonicalRetrievalManifest(corpus.manifest);
    const config = projectRetrievalIndexConfigSchema.parse(corpus.config);
    if (!matchesSource(scope, corpus) || retrievalGeneration(manifest, config) !== corpus.generation ||
        corpus.passages.length > PROJECT_RETRIEVAL_CORPUS_LIMITS.passages) {
      throw new Error('project retrieval build binding mismatch');
    }
    const namespace = namespaceFor(scope);
    const id = projectRetrievalHash(JSON.stringify([namespace, corpus.generation, randomUUID()]));
    const table = tableFor(id);
    const epoch = await writeBatch(this.db, context, () => {
      this.db.prepare('INSERT OR IGNORE INTO project_retrieval_namespaces_v1(namespace) VALUES (?)').run(namespace);
      const row = this.namespace(namespace)!;
      this.db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(context, excerpt, evidence UNINDEXED,
        checksum UNINDEXED, tokenize='${PROJECT_RETRIEVAL_TOKENIZER}')`);
      this.db.prepare(`INSERT INTO project_retrieval_generations_v1
        (table_id, namespace, generation, manifest_json, config_json, status, passage_count, touched_ms)
        VALUES (?, ?, ?, ?, ?, 'building', ?, ?)`).run(id, namespace, corpus.generation,
        JSON.stringify(corpus.manifest), JSON.stringify(corpus.config), corpus.passages.length, Date.now());
      return row.epoch;
    });
    const insert = this.db.prepare(`INSERT INTO ${table}(rowid, context, excerpt, evidence, checksum) VALUES (?, ?, ?, ?, ?)`);
    for (let offset = 0; offset < corpus.passages.length; offset += 64) {
      await writeBatch(this.db, context, () => {
        this.assertBuildCurrent(namespace, epoch, id);
        const batch = corpus.passages.slice(offset, offset + 64);
        for (const [i, raw] of batch.entries()) {
          const passage = projectRetrievalPassageSchema.parse(raw);
          const evidence = JSON.stringify(passage);
          insert.run(offset + i + 1, retrievalPassageContext(corpus.manifest, passage), passage.excerpt,
            evidence, projectRetrievalHash(evidence));
        }
        this.db.prepare('UPDATE project_retrieval_generations_v1 SET touched_ms = ? WHERE table_id = ?').run(Date.now(), id);
      });
      await setImmediate(undefined, { signal: context.signal });
    }
    await writeBatch(this.db, context, () => {
      this.assertBuildCurrent(namespace, epoch, id);
      const count = (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      if (count !== corpus.passages.length) throw new Error('incomplete project retrieval index');
      this.db.prepare(`INSERT INTO ${table}(${table}) VALUES ('integrity-check')`).run();
      this.db.prepare("UPDATE project_retrieval_generations_v1 SET status = 'ready', touched_ms = ? WHERE table_id = ?").run(Date.now(), id);
      this.db.prepare('UPDATE project_retrieval_namespaces_v1 SET active_table = ?, epoch = epoch + 1 WHERE namespace = ?').run(id, namespace);
    });
    return { generation: corpus.generation, passages: corpus.passages.length };
  }

  private namespace(namespace: string): NamespaceRow | undefined {
    return this.db.prepare('SELECT epoch, active_table FROM project_retrieval_namespaces_v1 WHERE namespace = ?').get(namespace) as NamespaceRow | undefined;
  }

  private assertBuildCurrent(namespace: string, epoch: number, id: string): void {
    const row = this.namespace(namespace);
    const generation = this.db.prepare('SELECT status FROM project_retrieval_generations_v1 WHERE table_id = ?').get(id) as { status: string } | undefined;
    if (row?.epoch !== epoch || generation?.status !== 'building') throw new Error('project retrieval build superseded');
  }

  /** Invalidate first; deletion/revocation must not wait for physical table cleanup. */
  invalidate(inputScope: ProjectRetrievalScope): void {
    const namespace = namespaceFor(projectRetrievalScopeSchema.parse(inputScope));
    withoutBusyWait(this.db, () => this.db.prepare(`INSERT INTO project_retrieval_namespaces_v1(namespace, epoch)
      VALUES (?, 1) ON CONFLICT(namespace) DO UPDATE SET active_table = NULL, epoch = epoch + 1`).run(namespace));
  }

  /** At most 20 old, unreferenced tables per call. May also reap abandoned builds. */
  collectGarbage(beforeMs: number, limit = 20): number {
    if (!Number.isSafeInteger(beforeMs) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('invalid project retrieval retention');
    }
    return withoutBusyWait(this.db, () => this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT g.table_id FROM project_retrieval_generations_v1 g
        LEFT JOIN project_retrieval_namespaces_v1 n ON n.namespace = g.namespace
        WHERE g.touched_ms < ? AND (n.active_table IS NULL OR n.active_table <> g.table_id)
        ORDER BY g.touched_ms, g.table_id LIMIT ?`).all(beforeMs, limit) as { table_id: string }[];
      for (const row of rows) {
        this.db.exec(`DROP TABLE IF EXISTS ${tableFor(row.table_id)}`);
        this.db.prepare('DELETE FROM project_retrieval_generations_v1 WHERE table_id = ?').run(row.table_id);
      }
      return rows.length;
    }).immediate());
  }

  /** This low-level lookup accepts a trusted host scope, never model arguments. */
  search(inputScope: ProjectRetrievalScope, inputQuery: ProjectRetrievalQuery,
    context: ProjectRetrievalCallContext): ProjectRetrievalResponse {
    const stopped = (): ProjectRetrievalResponse | null => context.signal.aborted ? { ok: false, status: 'cancelled' } :
      !Number.isFinite(context.deadlineAt) || Date.now() >= context.deadlineAt ? { ok: false, status: 'timed_out' } : null;
    const expired = stopped();
    if (expired) return expired;
    try {
      const scope = projectRetrievalScopeSchema.parse(inputScope);
      const query = projectRetrievalQuerySchema.parse(inputQuery);
      const response = withoutBusyWait(this.db, () => this.db.transaction((): ProjectRetrievalResponse => {
        const namespace = namespaceFor(scope);
        const row = this.db.prepare(`SELECT g.* FROM project_retrieval_generations_v1 g
          JOIN project_retrieval_namespaces_v1 n ON n.active_table = g.table_id AND n.namespace = g.namespace
          WHERE n.namespace = ? AND g.generation = ? AND g.status = 'ready'`).get(namespace, scope.generation) as GenerationRow | undefined;
        if (!row) return { ok: false, status: 'unavailable' };
        const manifest = canonicalRetrievalManifest(JSON.parse(row.manifest_json));
        const config = projectRetrievalIndexConfigSchema.parse(JSON.parse(row.config_json));
        if (!matchesSource(scope, { manifest, config, generation: row.generation, passages: [] }) ||
            retrievalGeneration(manifest, config) !== row.generation || row.passage_count > PROJECT_RETRIEVAL_CORPUS_LIMITS.passages) {
          throw new Error('invalid index identity');
        }
        const table = tableFor(row.table_id);
        // Quoted phrases joined by a fixed operator: OR/NEAR/column names remain literal words.
        const match = query.terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
        const count = (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
        if (count !== row.passage_count) throw new Error('incomplete index');
        const rows = this.db.prepare(`SELECT context, excerpt, evidence, checksum,
          bm25(${table}, ${PROJECT_RETRIEVAL_BM25.contextWeight}, ${PROJECT_RETRIEVAL_BM25.textWeight}) AS score
          FROM ${table} WHERE ${table} MATCH ? ORDER BY score, rowid LIMIT ?`).all(match, query.maxCandidates + 1) as PassageRow[];
        const passages: ProjectRetrievalPassage[] = [];
        let truncated = rows.length > query.maxCandidates;
        for (const hit of rows.slice(0, query.maxCandidates)) {
          if (projectRetrievalHash(hit.evidence) !== hit.checksum) throw new Error('corrupt passage');
          const passage = projectRetrievalPassageSchema.parse(JSON.parse(hit.evidence));
          const document = manifest.documents.find(d => d.path === passage.path && d.sha256 === passage.sha256);
          if (!document || passage.endByte > document.bytes ||
              passage.documentId !== retrievalDocumentId(document.path, document.sha256) ||
              hit.excerpt !== passage.excerpt || hit.context !== retrievalPassageContext(manifest, passage) || !Number.isFinite(hit.score)) {
            throw new Error('corrupt passage provenance');
          }
          if (passages.length >= query.limit || Buffer.byteLength(passage.excerpt) > query.maxExcerptBytes) {
            truncated = true; continue;
          }
          passages.push({ ...passage, score: hit.score });
        }
        return { ok: true, status: 'ok', corpusId: scope.corpusId, snapshotId: scope.snapshotId,
          snapshotSha256: scope.snapshotSha256, generation: scope.generation, passages, truncated };
      })());
      // Native SQLite statements are synchronous. A late statement can never return a late success.
      return stopped() ?? response;
    } catch { return stopped() ?? { ok: false, status: 'unavailable' }; }
  }

  /** Run-owned adapter. The existing host element owns the before/after authority checks. */
  createService(inputScope: ProjectRetrievalScope, authority: ProjectRetrievalService['authorize']): ProjectRetrievalService {
    if (typeof authority !== 'function') throw new Error('project retrieval requires a current authority');
    const scope = projectRetrievalScopeSchema.parse(inputScope);
    const pin = JSON.stringify(scope);
    let closed = false;
    const matches = (candidate: ProjectRetrievalScope) => !closed && JSON.stringify(projectRetrievalScopeSchema.parse(candidate)) === pin;
    return {
      authorize: async (candidate, context) => {
        try { return matches(candidate) && await authority(scope, context) === true; } catch { return false; }
      },
      search: async (candidate, query, context) => {
        if (!matches(candidate)) return { ok: false, status: 'denied' };
        return this.search(scope, query, context);
      },
      dispose: async () => { closed = true; },
    };
  }
}
