import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHaystackRetrievalBinding } from '../src/projects/retrievalHaystack.js';
import { haystackModelRevision } from '../src/projects/retrievalModelFiles.js';
import { createProjectRetrievalTool, type ProjectRetrievalBinding } from '../src/tools/projectRetrieval.js';
import { corpusScope, prepareTestCorpus, retrievalContext } from './helpers/projectRetrievalCorpus.js';
import type { HaystackSettings } from '../src/contracts/retrievalHaystack.js';

let root: string;
const owned: ProjectRetrievalBinding[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-haystack-test-')); });
afterEach(async () => { await Promise.allSettled(owned.splice(0).map(b => b.service.dispose())); rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const corpus = await prepareTestCorpus(root, { 'price.md': '# Price\nAnnual price is 190 euros.\n', 'support.md': '# Support\nContact the desk.\n' });
  const scope = corpusScope(corpus);
  const authority = { scope, service: { authorize: vi.fn(async () => true),
    search: vi.fn(async () => ({ ok: false as const, status: 'unavailable' as const })), dispose: vi.fn(async () => {}) } };
  return { corpus, authority, context: retrievalContext(), settings: { mode: 'bm25' as const } };
}
/** A real child executable exercises the host protocol without Python/model dependencies in CI. */
function executable(behavior = 'valid') {
  const path = join(root, 'protocol');
  writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));
const mode = ${JSON.stringify(behavior)};
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
let documents;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.op === 'init') {
   documents = request.documents;
   if(mode === 'env' && (process.env.OPENAI_API_KEY || process.env.HOME || process.env.PYTHONPATH || process.env.HF_HUB_OFFLINE !== '1')) process.exit(2);
   reply({kind:'ready',id:0,version:mode === 'version' ? '0.0.0' : '3.1.1',documents:documents.length});
 } else if(mode === 'hang') { /* keep stdin open until cancellation */ }
 else if(mode === 'malformed') process.stdout.write('not json\\n');
 else if(mode === 'oversized') process.stdout.write('x'.repeat(33 * 1024 * 1024));
 else if(mode === 'unknown') reply({kind:'result',id:request.id,hits:[{id:'f'.repeat(64),score:1}]});
 else if(mode === 'duplicate') reply({kind:'result',id:request.id,hits:[{id:documents[0].id,score:1},{id:documents[0].id,score:1}]});
 else reply({kind:'result',id:request.id,hits:documents.map(d => ({id:d.id,score:1}))});
});
`, { mode: 0o700 });
  return path;
}
async function bind(behavior = 'valid') {
  const input = await fixture();
  const binding = await createHaystackRetrievalBinding({ ...input, python: executable(behavior) });
  owned.push(binding);
  return { ...input, binding, tool: createProjectRetrievalTool(binding, retrievalContext()) };
}

describe('experimental Haystack host boundary', () => {
  it('returns exact admitted passages through the existing L1 element and honors live revocation', async () => {
    const { tool, binding, authority, corpus } = await bind();
    const result = await tool.execute({ query: 'price', limit: 1 });
    expect(result).toMatchObject({ ok: true, passages: [{ ...corpus.passages[0], score: 1 }], truncated: true });
    expect(authority.service.search).not.toHaveBeenCalled();
    expect(await binding.service.authorize({ ...binding.scope, runId: 'other' }, retrievalContext())).toBe(false);
    authority.service.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await tool.execute({ query: 'price' })).toEqual({ ok: false, status: 'denied' });
    await tool.close();
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await binding.service.authorize(binding.scope, retrievalContext())).toBe(false);
  });
  it.each(['unknown', 'duplicate', 'malformed', 'oversized'])('hides %s backend output', async behavior => {
    const { tool } = await bind(behavior);
    expect(await tool.execute({ query: 'price' })).toEqual({ ok: false, status: 'unavailable' });
    await tool.close();
  });
  it('kills and reaps a child when a query is cancelled', async () => {
    const { binding } = await bind('hang');
    const controller = new AbortController();
    const tool = createProjectRetrievalTool(binding, retrievalContext(30_000, controller.signal));
    const pending = tool.execute({ query: 'price' });
    setTimeout(() => controller.abort(), 30);
    expect(await pending).toEqual({ ok: false, status: 'cancelled' });
    await tool.close();
    expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow();
  });
  it('rejects a missing runtime and mismatched package version with authority teardown', async () => {
    const input = await fixture();
    await expect(createHaystackRetrievalBinding({ ...input, python: join(root, 'missing') })).rejects.toThrow();
    expect(input.authority.service.dispose).toHaveBeenCalledOnce();
    await expect(createHaystackRetrievalBinding({ ...input, python: executable('version') })).rejects.toThrow();
  });
  it('never starts the backend when source authority or generation is wrong', async () => {
    const input = await fixture();
    input.authority.service.authorize.mockResolvedValue(false);
    await expect(createHaystackRetrievalBinding({ ...input, python: executable() })).rejects.toThrow('denied');
    expect(() => readFileSync(join(root, 'pid'))).toThrow();
    input.authority.scope = { ...input.authority.scope, generation: 'f'.repeat(64) };
    await expect(createHaystackRetrievalBinding({ ...input, python: executable() })).rejects.toThrow('mismatch');
  });
  it('requires a literal true admission before sending documents to Python', async () => {
    const input = await fixture();
    input.authority.service.authorize.mockResolvedValue('yes' as never);
    await expect(createHaystackRetrievalBinding({ ...input, python: executable() })).rejects.toThrow('denied');
    expect(() => readFileSync(join(root, 'pid'))).toThrow();
  });
  it('does not inherit host secrets or enable model downloads', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-key'); vi.stubEnv('PYTHONPATH', root);
    try { const { tool } = await bind('env'); expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true }); }
    finally { vi.unstubAllEnvs(); }
  });
  it('pins model content and refuses changed weights and symlinks', async () => {
    const input = await fixture();
    const model = join(root, 'model'); mkdirSync(model); writeFileSync(join(model, 'weights'), 'v1');
    const revision = await haystackModelRevision(model, retrievalContext());
    mkdirSync(join(model, '.cache')); writeFileSync(join(model, '.cache', 'metadata'), 'ignored');
    expect(await haystackModelRevision(model, retrievalContext())).toBe(revision);
    writeFileSync(join(model, 'weights'), 'v2');
    const settings: HaystackSettings = { mode: 'hybrid-rerank', embeddingPath: model, rerankerPath: model,
      queryPrefix: '', embeddingRevision: revision, rerankerRevision: revision };
    await expect(createHaystackRetrievalBinding({ ...input, settings, python: executable() })).rejects.toThrow('model files changed');
    expect(() => readFileSync(join(root, 'pid'))).toThrow();
    symlinkSync(join(model, 'weights'), join(model, 'alias'));
    await expect(haystackModelRevision(model, retrievalContext())).rejects.toThrow('symlinks');
  });
});

const python = process.env['ATOMA_HAYSTACK_TEST_PYTHON'];
describe.skipIf(!python)('real optional Haystack runtime', () => {
  it('exits when its host input pipe disappears', async () => {
    const child = spawn(python!, ['-I', '-u', fileURLToPath(new URL('../scripts/retrieval-haystack.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { HAYSTACK_TELEMETRY_ENABLED: 'False', HF_HUB_OFFLINE: '1' } });
    child.stderr.resume();
    const closed = once(child, 'close');
    try {
      child.stdin.write(JSON.stringify({ id: 0, op: 'init', settings: { mode: 'bm25' }, documents: [] }) + '\n');
      await once(child.stdout, 'data');
      child.stdin.destroy();
      expect((await closed)[0]).toBe(0);
    } finally { child.kill('SIGKILL'); }
  }, 15_000);

  it('loads the pinned framework and retrieves source bytes across the Python boundary', async () => {
    const input = await fixture();
    const binding = await createHaystackRetrievalBinding({ ...input, python: python!, context: retrievalContext(60_000) });
    owned.push(binding);
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    expect(await tool.execute({ query: 'annual price', limit: 1 })).toMatchObject({ ok: true, passages: [{ path: 'price.md', excerpt: input.corpus.passages[0]!.excerpt }] });
    await tool.close();
  }, 65_000);
  it.skipIf(!process.env['ATOMA_HAYSTACK_TEST_MODELS'])('runs local embeddings, fusion and cross-encoder reranking', async () => {
    const input = await fixture();
    const models = process.env['ATOMA_HAYSTACK_TEST_MODELS']!;
    const context = retrievalContext(120_000);
    const embeddingPath = join(models, 'embedding'), rerankerPath = join(models, 'reranker');
    const settings: HaystackSettings = { mode: 'hybrid-rerank', embeddingPath, rerankerPath,
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      embeddingRevision: await haystackModelRevision(embeddingPath, context),
      rerankerRevision: await haystackModelRevision(rerankerPath, context) };
    const binding = await createHaystackRetrievalBinding({ ...input, python: python!, settings, context });
    owned.push(binding);
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    expect(await tool.execute({ query: 'annual price', limit: 1 })).toMatchObject({ ok: true, passages: [{ path: 'price.md' }] });
    await tool.close();
  }, 125_000);
});
