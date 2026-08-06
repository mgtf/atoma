import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prefilterStrategy } from '../src/atoms/cost.js';
import { resetPrefilterCacheForTests } from '../src/atoms/prefilterCache.js';
import { forkBranch } from '../src/core/branchCtx.js';
import type { CacheHitInfo } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * A cache hit REPLACES an LLM call, so without an observer event the
 * timeline shows one fewer call and the run looks cheaper for no stated
 * reason. These pin the observer contract: fires only on a hit, carries
 * the replayed decision, and survives `forkBranch` (the skill prefilter
 * runs per subtask, i.e. inside forked contexts — that is where most
 * cache hits happen).
 */

const CATALOG = [{ name: 'Hydrogen', description: 'web builder' }];

describe('prefilter cache — observer event', () => {
  let dir: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-cache-ev-'));
    envBefore = process.env['ATOMA_PREFILTER_CACHE'];
    process.env['ATOMA_PREFILTER_CACHE'] = join(dir, 'cache.json');
    resetPrefilterCacheForTests();
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_PREFILTER_CACHE'];
    else process.env['ATOMA_PREFILTER_CACHE'] = envBefore;
    resetPrefilterCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays silent on a MISS and fires on the HIT, carrying the decision', async () => {
    const hits: CacheHitInfo[] = [];
    const ctx = { ...makeCtx(), recordCacheHit: (i: CacheHitInfo) => hits.push(i) };
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'web shape' })
    );

    await prefilterStrategy({ ctx, task: { description: 'build a page' }, catalog: CATALOG });
    expect(hits).toHaveLength(0); // live call — nothing replayed

    await prefilterStrategy({ ctx, task: { description: 'build a page' }, catalog: CATALOG });
    expect(ctx.llm.calls).toHaveLength(1); // served from disk
    expect(hits).toHaveLength(1);
    expect(hits[0]!.outcome).toBe('reuse Hydrogen');
    expect(hits[0]!.reasoning).toBe('web shape');
    expect(hits[0]!.model).toMatch(/haiku/);
  });

  it('records an escalate replay too, and carries actor attribution', async () => {
    const hits: CacheHitInfo[] = [];
    const ctx = { ...makeCtx(), recordCacheHit: (i: CacheHitInfo) => hits.push(i) };
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no clear match' }));
    const args = {
      ctx,
      task: { description: 't' },
      catalog: CATALOG,
      actor: { name: 'Water', tier: 2 as const },
    };
    await prefilterStrategy(args);
    await prefilterStrategy(args);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.outcome).toBe('escalate');
    expect(hits[0]!.actorName).toBe('Water');
    expect(hits[0]!.actorTier).toBe(2);
  });

  it('survives forkBranch and gets the branch id stamped', async () => {
    // Regression guard: forkBranch rebuilds the ctx field by field, so a
    // hook it forgets is silently dropped — and the skill prefilter runs
    // inside forked contexts, so that would lose most cache hits.
    const hits: CacheHitInfo[] = [];
    const root = { ...makeCtx(), recordCacheHit: (i: CacheHitInfo) => hits.push(i) };
    const branched = forkBranch(root, 'branch-abc');
    expect(branched.recordCacheHit).toBeDefined();

    root.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'r' })
    );
    await prefilterStrategy({ ctx: branched, task: { description: 'x' }, catalog: CATALOG });
    await prefilterStrategy({ ctx: branched, task: { description: 'x' }, catalog: CATALOG });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.branchId).toBe('branch-abc');
  });

  it('does not fire when the cache is disabled', async () => {
    process.env['ATOMA_PREFILTER_CACHE'] = '0';
    resetPrefilterCacheForTests();
    const hits: CacheHitInfo[] = [];
    const ctx = { ...makeCtx(), recordCacheHit: (i: CacheHitInfo) => hits.push(i) };
    for (let i = 0; i < 2; i++) {
      ctx.llm.enqueueText(
        jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'r' })
      );
    }
    await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    await prefilterStrategy({ ctx, task: { description: 't' }, catalog: CATALOG });
    expect(ctx.llm.calls).toHaveLength(2);
    expect(hits).toHaveLength(0);
  });
});
