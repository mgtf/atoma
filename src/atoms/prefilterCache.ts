import { openStoreHandle, storeDbPath } from '../core/stores.js';
import type { PrefilterOutcome } from './cost.js';

/**
 * PREFILTER DECISION CACHE — FrugalGPT's completion cache mapped onto
 * atoma's cheapest LLM slot. Prefilter calls are temperature 0 with a
 * CONSTANT system prompt: identical inputs produce (near-)identical
 * routing decisions, so a repeat (task × catalog × exclusions × model)
 * pair can be served for $0 — and, under claude-cli, without the 2-5s
 * subprocess spawn that made five Haiku prefilters 35% of a warm run's
 * wall time.
 *
 * Correctness comes from the KEY, not from invalidation logic: it
 * hashes the system prompt, the model id, and the canonical decision
 * inputs (task description + constraints + excluded names + catalog
 * lines). Any registry evolution that changes a description, adds an
 * entry, or bumps counters INTO the catalog text changes the key and
 * misses naturally. The tier-aware trace-attribution preamble
 * (`You are molecule|cell|tissue …`)
 * is deliberately NOT in the key — two supervisors consulting the same
 * catalog about the same task deserve the same answer.
 *
 * A TABLE IN THE STORE, not a sibling JSON file, since 2026-08-09. It was
 * `./atoma-prefilter-cache.json`, and the file form had the whole cache
 * re-serialised on every get AND every put — 217 KB rewritten per prefilter
 * call, including on a HIT, just to increment a counter. It was also
 * last-writer-wins across processes on the WHOLE file, so two concurrent runs
 * discarded each other's entries wholesale. `INSERT OR REPLACE` and
 * `hits = hits + 1` are the operations this actually wanted.
 *
 * NOT MIGRATED, deliberately: a cache that gets an importer is being treated
 * as data. It refills from use, and the measured value of the 500 entries at
 * the time of the move was 11 hits.
 *
 * Two deliberate bounds:
 *   - entries expire after PREFILTER_CACHE_MAX_AGE_MS (model pins are
 *     stable strings but subscription-served model versions shift
 *     behind them — a stale routing decision should not outlive the
 *     model that made it by long);
 *   - the store is capped at PREFILTER_CACHE_MAX_ENTRIES, evicting
 *     oldest-written first.
 * MEASURED, so the bounds are not theoretical: after three days the store sat
 * AT the 500 cap with entries spanning 2026-08-07..09, meaning the cap evicts
 * long before the 7-day expiry can ever fire. Whether either bound is the
 * right one is a live question — `registry cache` exists to answer it, and
 * the honest current number is 9 entries of 500 ever re-read (1.8%).
 *
 * Error-path escalates (LLM failure, bad JSON) are NEVER cached — only
 * parsed outcomes are (including genuine `escalate` decisions, which
 * are stable answers for identical inputs).
 *
 * Config: `ATOMA_PREFILTER_CACHE` — '0' disables; any other non-empty
 * value overrides the DB path (default: the one store). vitest pins it to
 * '0'. Fail-open: a cache error can never take down a prefilter call.
 */

export const PREFILTER_CACHE_MAX_ENTRIES = 500;
export const PREFILTER_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const PREFILTER_CACHE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS prefilter_cache (
  key     TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  at      TEXT NOT NULL,
  hits    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prefilter_cache_at ON prefilter_cache(at);
`;

export function prefilterCacheEnabled(): boolean {
  return process.env['ATOMA_PREFILTER_CACHE'] !== '0';
}

/** Which store holds the cache. Defaults to the one store. */
export function prefilterCacheDbPath(): string {
  const v = process.env['ATOMA_PREFILTER_CACHE'];
  return v && v !== '0' ? v : storeDbPath();
}

/** djb2 over the canonical inputs — stable, dependency-free, short keys. */
export function prefilterCacheKey(args: {
  systemPrompt: string;
  model: string;
  taskDescription: string;
  constraints?: readonly string[];
  excluded: readonly string[];
  catalogLines: readonly string[];
}): string {
  const canonical = [
    args.systemPrompt,
    `model:${args.model}`,
    `task:${args.taskDescription}`,
    `constraints:${(args.constraints ?? []).join('|')}`,
    `excluded:${[...args.excluded].sort().join('|')}`,
    `catalog:${args.catalogLines.join('\n')}`,
  ].join(' ');
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  }
  // Two passes with different seeds shrink accidental-collision odds while
  // keeping the key short and deterministic.
  let h2 = 52711;
  for (let i = canonical.length - 1; i >= 0; i--) {
    h2 = ((h2 << 5) + h2 + canonical.charCodeAt(i)) >>> 0;
  }
  return `${h.toString(36)}-${h2.toString(36)}-${canonical.length.toString(36)}`;
}

let warnedOnce = false;

function warnOnce(err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
   
  console.warn(`[prefilterCache] disabled after error (further failures silent): ${(err as Error).message}`);
}

function db(): ReturnType<typeof openStoreHandle> {
  return openStoreHandle(prefilterCacheDbPath(), PREFILTER_CACHE_TABLE_DDL);
}

/** Test hook: drop cached handles so the next call re-opens the path. */
export { closeStoreHandles as resetPrefilterCacheForTests } from '../core/stores.js';

export function prefilterCacheGet(key: string): PrefilterOutcome | null {
  if (!prefilterCacheEnabled()) return null;
  try {
    const conn = db();
    const row = conn
      .prepare('SELECT outcome, at FROM prefilter_cache WHERE key = ?')
      .get(key) as { outcome: string; at: string } | undefined;
    if (!row) return null;
    if (Date.now() - Date.parse(row.at) > PREFILTER_CACHE_MAX_AGE_MS) {
      conn.prepare('DELETE FROM prefilter_cache WHERE key = ?').run(key);
      return null;
    }
    conn.prepare('UPDATE prefilter_cache SET hits = hits + 1 WHERE key = ?').run(key);
    return JSON.parse(row.outcome) as PrefilterOutcome;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

export function prefilterCachePut(key: string, outcome: PrefilterOutcome): void {
  if (!prefilterCacheEnabled()) return;
  try {
    const conn = db();
    conn.transaction(() => {
      conn
        .prepare('INSERT OR REPLACE INTO prefilter_cache (key, outcome, at, hits) VALUES (?, ?, ?, 0)')
        .run(key, JSON.stringify(outcome), new Date().toISOString());
      // Evict oldest-WRITTEN first, in one statement. The file form sorted
      // every key in JS on each put; here SQLite does it.
      //
      // BY ROWID, NOT BY `at`. `at` has millisecond resolution and a run
      // writes several prefilter decisions inside one, so ordering by it ties
      // — and the tie-break would then decide, arbitrarily, whether the entry
      // just written is the one evicted. The file form got insertion order
      // for free from V8's stable sort; `INSERT OR REPLACE` assigns a fresh
      // rowid on every write, so rowid IS write order. (SQLite may reuse a
      // rowid after the highest row is deleted, but eviction only ever
      // removes the LOWEST, so the maximum never falls.) Same reason
      // `lifecycle_events` carries an explicit seq.
      conn
        .prepare(
          `DELETE FROM prefilter_cache WHERE rowid NOT IN (
             SELECT rowid FROM prefilter_cache ORDER BY rowid DESC LIMIT ?
           )`
        )
        .run(PREFILTER_CACHE_MAX_ENTRIES);
    })();
  } catch (err) {
    warnOnce(err);
  }
}

export interface PrefilterCacheStats {
  entries: number;
  /** Entries read back at least once — the number that justifies the cache. */
  reused: number;
  hits: number;
  oldest?: string;
  newest?: string;
}

/** What `registry cache` reports. Zeroes rather than throwing on a bad store. */
export function prefilterCacheStats(): PrefilterCacheStats {
  try {
    const row = db()
      .prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN hits > 0 THEN 1 ELSE 0 END), 0) AS reused,
                COALESCE(SUM(hits), 0) AS hits,
                MIN(at) AS oldest, MAX(at) AS newest
           FROM prefilter_cache`
      )
      .get() as PrefilterCacheStats;
    return row;
  } catch {
    return { entries: 0, reused: 0, hits: 0 };
  }
}

/** Empty the cache. The `rm` that a file had and a table needs a verb for. */
export function prefilterCacheClear(): number {
  try {
    const conn = db();
    const n = (conn.prepare('SELECT COUNT(*) AS n FROM prefilter_cache').get() as { n: number }).n;
    conn.prepare('DELETE FROM prefilter_cache').run();
    return n;
  } catch (err) {
    warnOnce(err);
    return 0;
  }
}
