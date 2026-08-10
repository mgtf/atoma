import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PREFILTER_CACHE_MAX_ENTRIES,
  prefilterCacheClear,
  prefilterCacheGet,
  prefilterCacheKey,
  prefilterCachePut,
  prefilterCacheStats,
  resetPrefilterCacheForTests,
} from '../src/atoms/prefilterCache.js';
import { prefilterStrategy} from '../src/atoms/cost.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Prefilter decision cache (FrugalGPT completion-cache analog). The
 * decision is a pure function of (system prompt × model × task ×
 * exclusions × catalog) at temperature 0 — a repeat pair is served from
 * disk for zero tokens and, under claude-cli, zero subprocess spawns.
 * The vitest config pins ATOMA_PREFILTER_CACHE='0' globally so mock
 * call-count tests stay deterministic; these tests re-enable it with a
 * temp path per test.
 */

const BASE = {
  systemPrompt: 'SYS',
  model: 'claude-haiku-4-5',
  taskDescription: 'build a thing',
  excluded: [] as string[],
  catalogLines: ['  - Hydrogen: web builder'],
};

describe('prefilterCacheKey', () => {
  it('is deterministic and sensitive to every decision input', () => {
    expect(prefilterCacheKey(BASE)).toBe(prefilterCacheKey({ ...BASE }));
    expect(prefilterCacheKey({ ...BASE, model: 'other' })).not.toBe(prefilterCacheKey(BASE));
    expect(prefilterCacheKey({ ...BASE, taskDescription: 'x' })).not.toBe(prefilterCacheKey(BASE));
    expect(prefilterCacheKey({ ...BASE, excluded: ['Hydrogen'] })).not.toBe(prefilterCacheKey(BASE));
    expect(
      prefilterCacheKey({ ...BASE, catalogLines: ['  - Hydrogen: web builder (5✓/0✗)'] })
    ).not.toBe(prefilterCacheKey(BASE));
    expect(prefilterCacheKey({ ...BASE, constraints: ['fast'] })).not.toBe(prefilterCacheKey(BASE));
  });

  it('normalises exclusion order', () => {
    expect(prefilterCacheKey({ ...BASE, excluded: ['A', 'B'] })).toBe(
      prefilterCacheKey({ ...BASE, excluded: ['B', 'A'] })
    );
  });
});

describe('cache store — a table in the store, bounded, disableable', () => {
  let dir: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-pfcache-'));
    envBefore = process.env['ATOMA_PREFILTER_CACHE'];
    process.env['ATOMA_PREFILTER_CACHE'] = join(dir, 'cache.db');
    resetPrefilterCacheForTests();
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_PREFILTER_CACHE'];
    else process.env['ATOMA_PREFILTER_CACHE'] = envBefore;
    resetPrefilterCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an outcome and persists it', () => {
    const key = prefilterCacheKey(BASE);
    expect(prefilterCacheGet(key)).toBeNull();
    prefilterCachePut(key, { kind: 'reuse', target: 'Hydrogen', reasoning: 'fits', confidence: 'high' });
    expect(prefilterCacheGet(key)).toMatchObject({ kind: 'reuse', target: 'Hydrogen' });
    expect(existsSync(join(dir, 'cache.db'))).toBe(true);
    // A fresh handle (new process simulation) reads the same entry.
    resetPrefilterCacheForTests();
    expect(prefilterCacheGet(key)).toMatchObject({ kind: 'reuse', target: 'Hydrogen' });
  });

  it('a HIT no longer rewrites the whole store — it increments one row', () => {
    // The file form re-serialised all 500 entries (217 KB measured) on every
    // get, purely to bump `hits`. This is the operation it wanted.
    const key = prefilterCacheKey(BASE);
    prefilterCachePut(key, { kind: 'reuse', target: 'Hydrogen', reasoning: 'fits', confidence: 'high' });
    prefilterCacheGet(key);
    prefilterCacheGet(key);
    const s = prefilterCacheStats();
    expect(s.entries).toBe(1);
    expect(s.hits).toBe(2);
    expect(s.reused).toBe(1);
  });

  it('clear empties it and reports what it removed', () => {
    prefilterCachePut(prefilterCacheKey(BASE), { kind: 'escalate', reasoning: 'x' });
    expect(prefilterCacheClear()).toBe(1);
    expect(prefilterCacheStats().entries).toBe(0);
  });

  it("'0' disables both directions", () => {
    process.env['ATOMA_PREFILTER_CACHE'] = '0';
    resetPrefilterCacheForTests();
    const key = prefilterCacheKey(BASE);
    prefilterCachePut(key, { kind: 'escalate', reasoning: 'x' });
    expect(prefilterCacheGet(key)).toBeNull();
  });

  it('expires stale entries', () => {
    const key = prefilterCacheKey(BASE);
    prefilterCachePut(key, { kind: 'escalate', reasoning: 'old decision' });
    // Age the row past the max age, then force a re-read.
    resetPrefilterCacheForTests();
    const conn = new Database(join(dir, 'cache.db'));
    conn
      .prepare('UPDATE prefilter_cache SET at = ? WHERE key = ?')
      .run(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), key);
    conn.close();
    resetPrefilterCacheForTests();
    expect(prefilterCacheGet(key)).toBeNull();
  });

  it('evicts by WRITE ORDER, not by timestamp — the newest survives a same-ms burst', () => {
    // A run writes several prefilter decisions inside one millisecond, so
    // `at` ties and the tie-break decides — arbitrarily — whether the entry
    // just written is the one thrown away. Ordering by rowid is what makes
    // "oldest-written first" mean what it says. The file form got this free
    // from V8's stable sort; SQL had to be told.
    const keys: string[] = [];
    for (let i = 0; i <= PREFILTER_CACHE_MAX_ENTRIES + 20; i++) {
      const k = prefilterCacheKey({ ...BASE, taskDescription: `burst${i}` });
      keys.push(k);
      prefilterCachePut(k, { kind: 'escalate', reasoning: `${i}` });
    }
    expect(prefilterCacheStats().entries).toBe(PREFILTER_CACHE_MAX_ENTRIES);
    // Every one of the last 50 written is still there; the first 20 are gone.
    for (const k of keys.slice(-50)) expect(prefilterCacheGet(k)).not.toBeNull();
    for (const k of keys.slice(0, 20)) expect(prefilterCacheGet(k)).toBeNull();
  });

  it('evicts oldest-written entries past the cap', () => {
    for (let i = 0; i <= PREFILTER_CACHE_MAX_ENTRIES + 4; i++) {
      prefilterCachePut(prefilterCacheKey({ ...BASE, taskDescription: `t${i}` }), {
        kind: 'escalate',
        reasoning: `${i}`,
      });
    }
    expect(prefilterCacheStats().entries).toBeLessThanOrEqual(PREFILTER_CACHE_MAX_ENTRIES);
    // The newest entry survived.
    expect(
      prefilterCacheGet(
        prefilterCacheKey({ ...BASE, taskDescription: `t${PREFILTER_CACHE_MAX_ENTRIES + 4}` })
      )
    ).not.toBeNull();
  });
});

describe('prefilterStrategy — cache integration', () => {
  let dir: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-pfcache-e2e-'));
    envBefore = process.env['ATOMA_PREFILTER_CACHE'];
    process.env['ATOMA_PREFILTER_CACHE'] = join(dir, 'cache.db');
    resetPrefilterCacheForTests();
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_PREFILTER_CACHE'];
    else process.env['ATOMA_PREFILTER_CACHE'] = envBefore;
    resetPrefilterCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const CATALOG = [{ name: 'Hydrogen', description: 'web builder' }];

  it('serves the second identical call from the cache — zero LLM calls', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'fits' })
    );
    const first = await prefilterStrategy({ ctx, task: { description: 'build a page' }, catalog: CATALOG });
    expect(first).toMatchObject({ kind: 'reuse', target: 'Hydrogen' });
    expect(ctx.llm.calls).toHaveLength(1);

    const second = await prefilterStrategy({ ctx, task: { description: 'build a page' }, catalog: CATALOG });
    expect(second).toMatchObject({ kind: 'reuse', target: 'Hydrogen' });
    expect(ctx.llm.calls).toHaveLength(1); // no new call — served from disk
  });

  it('caches the low-confidence → escalate REWRITE, not the raw reuse', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'low', reasoning: 'meh' })
    );
    const first = await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    expect(first?.kind).toBe('escalate');
    const second = await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    expect(second?.kind).toBe('escalate');
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('does NOT cache the error-path escalate (an LLM hiccup must not persist)', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText('not json at all');
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'fits now' })
    );
    const first = await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    expect(first?.kind).toBe('escalate'); // parse failure → escalate, uncached
    const second = await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    expect(second).toMatchObject({ kind: 'reuse', target: 'Hydrogen' }); // retried live
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('a changed catalog misses naturally (key includes the catalog text)', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'catalog changed' }));
    await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    const evolved = [{ name: 'Hydrogen', description: 'web builder — now with smoke discipline' }];
    const second = await prefilterStrategy({ ctx, task: { description: 't' }, catalog: evolved });
    expect(second?.kind).toBe('escalate');
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('respects the anti-loop exclusion in the key', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'fits' })
    );
    await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    // Same task, but Hydrogen was tried and failed: the filtered catalog is
    // empty → deterministic escalate BEFORE the cache/LLM — and critically,
    // NOT the cached "reuse Hydrogen".
    const second = await prefilterStrategy({
      ctx,
      task: { description: 't' },
      catalog: CATALOG,
      exclude: new Set(['Hydrogen']),
    });
    expect(second?.kind).toBe('escalate');
    expect(ctx.llm.calls).toHaveLength(1);
  });
});
