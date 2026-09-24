import { describe, expect, it } from 'vitest';
import {
  MAX_CHECKLIST_ITEMS,
  checklistPlanningLines,
  coverAcceptanceChecklist,
  httpCheckMatches,
  parseAcceptanceChecklist,
  renderChecklistCoverage,
} from '../src/contracts/acceptanceChecklist.js';
import { draftAcceptanceChecklist, CHECKLIST_ACTOR } from '../src/atoms/acceptanceChecklist.js';
import { makeCtx, jsonText } from './helpers.js';

describe('parseAcceptanceChecklist', () => {
  it('renumbers ids, normalises the method, and drops only the malformed items', () => {
    const list = parseAcceptanceChecklist({ items: [
      { id: 'x', behaviour: 'lists notes', check: { kind: 'http', method: 'get', path: '/api/notes' } },
      { behaviour: 'invented host', check: { kind: 'http', method: 'GET', path: 'http://evil.test/x' } },
      { behaviour: '', check: { kind: 'review' } },
      { behaviour: 'bad verb', check: { kind: 'http', method: 'FETCH', path: '/x' } },
      { behaviour: 'a page shows them', check: { kind: 'review' } },
      'prose',
    ] });
    expect(list).toEqual([
      { id: 'c1', behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } },
      { id: 'c2', behaviour: 'a page shows them', check: { kind: 'review' } },
    ]);
  });

  it('caps the list and treats anything unusable as empty', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ behaviour: `b${i}`, check: { kind: 'review' } }));
    expect(parseAcceptanceChecklist({ items: many })).toHaveLength(MAX_CHECKLIST_ITEMS);
    for (const raw of [null, 'x', { items: 'x' }, {}]) expect(parseAcceptanceChecklist(raw)).toEqual([]);
  });
});

describe('httpCheckMatches', () => {
  const check = (path: string, status?: number, method = 'GET') =>
    ({ kind: 'http' as const, method: method as 'GET', path, ...(status !== undefined ? { status } : {}) });

  it('matches method, path segments and any 2xx when no status is named', () => {
    expect(httpCheckMatches(check('/api/notes'), { method: 'get', path: '/api/notes', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes/', status: 201 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes?limit=2', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes'), { method: 'POST', path: '/api/notes', status: 201 })).toBe(false);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes', status: 404 })).toBe(false);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes/1', status: 200 })).toBe(false);
  });

  it('matches a named status exactly, :name segments, encoded segments, and a named query exactly', () => {
    expect(httpCheckMatches(check('/api/notes/:id', 404), { method: 'GET', path: '/api/notes/zzz', status: 404 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes/:id', 404), { method: 'GET', path: '/api/notes/zzz', status: 200 })).toBe(false);
    expect(httpCheckMatches(check('/api/notes/:id'), { method: 'GET', path: '/api/notes', status: 200 })).toBe(false);
    expect(httpCheckMatches(check('/files/a b'), { method: 'GET', path: '/files/a%20b', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/search?q=x'), { method: 'GET', path: '/search?q=x', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/search?q=x'), { method: 'GET', path: '/search?q=y', status: 200 })).toBe(false);
    expect(httpCheckMatches(check('/'), { method: 'GET', path: '/', status: 200 })).toBe(true);
  });
});

describe('coverage and rendering', () => {
  const list = parseAcceptanceChecklist({ items: [
    { behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } },
    { behaviour: 'unknown id is 404', check: { kind: 'http', method: 'GET', path: '/api/notes/:id', status: 404 } },
    { behaviour: 'a page shows the list', check: { kind: 'review' } },
  ] });

  it('covers from observations only, and never covers a review item', () => {
    const coverage = coverAcceptanceChecklist(list, [
      { eventId: 'e1', http: { method: 'GET', path: '/api/notes', status: 200 } },
      { eventId: 'e2', http: { method: 'GET', path: '/api/notes/7', status: 200 } },
    ]);
    expect(coverage.map((c) => [c.id, c.status, c.observationRefs])).toEqual([
      ['c1', 'covered', ['e1']], ['c2', 'uncovered', []], ['c3', 'review', []],
    ]);
    const block = renderChecklistCoverage(list, coverage);
    expect(block).toContain('- [OBSERVED] c1 lists notes (GET /api/notes → 2xx)');
    expect(block).toContain('- [NOT OBSERVED] c2 unknown id is 404 (GET /api/notes/:id → 404)');
    expect(block).toContain('- [REVIEW] c3 a page shows the list (judged by review)');
    expect(block).toMatch(/decides nothing by itself/);
    expect(renderChecklistCoverage([], [])).toBe('');
  });

  it('gives the planner one line per item', () => {
    expect(checklistPlanningLines(list)).toEqual([
      'c1: lists notes (GET /api/notes → 2xx)',
      'c2: unknown id is 404 (GET /api/notes/:id → 404)',
      'c3: a page shows the list (judged by review)',
    ]);
  });
});

describe('draftAcceptanceChecklist', () => {
  it('makes one call on the cheapest tier under its own actor and parses the answer', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ items: [{ behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } }] }));
    const list = await draftAcceptanceChecklist(ctx, 'GET /api/notes lists notes');
    expect(list).toHaveLength(1);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]).toMatchObject({ role: 'draft-checklist', actor: CHECKLIST_ACTOR });
  });

  it('never throws: a transport error or unusable answer is an empty checklist', async () => {
    const failing = makeCtx();
    failing.llm.enqueue(() => { throw new Error('provider down'); });
    expect(await draftAcceptanceChecklist(failing, 'goal')).toEqual([]);
    const prose = makeCtx();
    prose.llm.enqueueText('I would check the notes page.');
    expect(await draftAcceptanceChecklist(prose, 'goal')).toEqual([]);
  });
});

describe('host attribution of an HTTP observation', () => {
  it.skipIf(process.platform === 'win32')('is structured only for a server this tool set started, and never for a redirect', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { createServer } = await import('node:http');
    const { localToolBackend } = await import('../src/run/toolBackend.js');
    const { attestingExecutor, createAttestationLog } = await import('../src/core/attestation.js');
    const { silentLogger } = await import('./helpers.js');
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-checklist-attrib-'));
    const stranger = createServer((_q, r) => { r.end('not ours'); });
    await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', resolve));
    const strangerPort = (stranger.address() as { port: number }).port;
    const backend = localToolBackend({ workspaceRoot: workspace, logger: silentLogger() });
    const log = createAttestationLog();
    const tools = attestingExecutor(backend.executor, log, undefined, undefined, 1)!;
    try {
      writeFileSync(join(workspace, 'server.cjs'), "const http=require('node:http');const s=http.createServer((q,r)=>{if(q.url==='/old'){r.statusCode=302;r.setHeader('location','/api/notes');return r.end()}r.end('[]')});s.listen(0,'127.0.0.1',()=>console.log('LISTENING_ON_PORT='+s.address().port));");
      const started = await tools.execute('start_node_server', { entry: 'server.cjs' }) as { url: string };
      await tools.execute('fetch_url', { url: `${started.url}api/notes?x=1` });
      await tools.execute('fetch_url', { url: `${started.url}old` });
      await tools.execute('fetch_url', { url: `http://127.0.0.1:${strangerPort}/api/notes` });
      const fetches = log.forAttempt(1).filter((record) => record.tool === 'fetch_url');
      expect(fetches).toHaveLength(3);
      expect(fetches.map((record) => record.observation.kind === 'execution' ? record.observation.http : 'x')).toEqual([
        { method: 'GET', path: '/api/notes?x=1', status: 200 },
        undefined,
        undefined,
      ]);
    } finally {
      await backend.drain?.();
      await backend.cleanup();
      await new Promise<void>((resolve) => stranger.close(() => resolve()));
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20000);
});
