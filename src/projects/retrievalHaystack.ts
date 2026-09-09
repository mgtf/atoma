import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { HAYSTACK_FRAME_BYTES, HAYSTACK_REPLY_BYTES, haystackReplySchema, haystackSettingsSchema,
  type HaystackReply, type HaystackSettings } from '../contracts/retrievalHaystack.js';
import { projectRetrievalPassageSchema } from '../contracts/projectRetrieval.js';
import { PROJECT_RETRIEVAL_CORPUS_LIMITS } from '../contracts/projectRetrievalCorpus.js';
import { haystackModelRevision } from './retrievalModelFiles.js';
import { validateProjectRetrievalBinding, type ProjectRetrievalBinding,
  type ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';
import { assertRetrievalTime, canonicalRetrievalManifest, projectRetrievalHash,
  retrievalDocumentId, retrievalGeneration, retrievalPassageContext, type PreparedProjectRetrievalCorpus } from './retrievalCorpus.js';

/** Run-owned Python backend. Only admitted text enters; only IDs and scores return. */
class HaystackProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: HaystackReply) => void; reject: () => void }>();
  private readonly exited: Promise<unknown>;
  private buffer = '';
  private stopped = false;
  private ordinal = 0;
  constructor(python: string) {
    if (!isAbsolute(python)) throw new Error('Haystack requires an absolute host Python executable');
    this.child = spawn(python, ['-I', '-u', fileURLToPath(new URL('../../scripts/retrieval-haystack.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      // No HOME, provider credentials, tracing destination, Python injection, or product paths.
      env: { PATH: process.env['PATH'], LANG: 'C.UTF-8', HAYSTACK_TELEMETRY_ENABLED: 'False',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
    });
    this.exited = once(this.child, 'close').catch(() => {});
    this.child.on('error', () => this.stop());
    this.child.on('close', () => this.stop());
    this.child.stdin.on('error', () => this.stop());
    // Drain diagnostics without retaining potential document bodies or host paths.
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          if (Buffer.byteLength(line) > HAYSTACK_REPLY_BYTES) throw new Error('oversized response');
          const message = haystackReplySchema.parse(JSON.parse(line));
          const pending = this.pending.get(message.id);
          if (!pending) throw new Error('unexpected response');
          this.pending.delete(message.id);
          if (message.kind === 'error') { pending.reject(); this.stop(); return; }
          pending.resolve(message);
        } catch { this.stop(); return; }
      }
      if (Buffer.byteLength(this.buffer) > HAYSTACK_REPLY_BYTES) this.stop();
    });
  }
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const pid = this.child.pid;
    if (pid && Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    for (const pending of this.pending.values()) pending.reject();
    this.pending.clear(); this.buffer = '';
  }
  async send(payload: Record<string, unknown>, context: ProjectRetrievalCallContext, initial = false): Promise<HaystackReply> {
    assertRetrievalTime(context);
    if (this.stopped || this.pending.size >= 8) throw new Error('Haystack unavailable');
    const id = initial ? 0 : ++this.ordinal;
    const bytes = JSON.stringify({ ...payload, id }) + '\n';
    if (Buffer.byteLength(bytes) > HAYSTACK_FRAME_BYTES) throw new Error('Haystack input too large');
    const stop = () => this.stop();
    const timer = setTimeout(stop, Math.max(1, context.deadlineAt - Date.now()));
    context.signal.addEventListener('abort', stop, { once: true });
    try {
      const result = await new Promise<HaystackReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject: () => reject(new Error('Haystack unavailable')) });
        this.child.stdin.write(bytes);
        if (context.signal.aborted) this.stop();
      });
      assertRetrievalTime(context);
      return result;
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', stop); }
  }
  async close(): Promise<void> { this.stop(); await this.exited; }
}

/** Experimental library binding. Atoma retains admission, scope, citations and L1 execution. */
export async function createHaystackRetrievalBinding(input: {
  authority: ProjectRetrievalBinding; corpus: PreparedProjectRetrievalCorpus;
  python: string; settings: HaystackSettings; runtimeSha256?: string; context: ProjectRetrievalCallContext;
}): Promise<ProjectRetrievalBinding> {
  const binding = validateProjectRetrievalBinding(input.authority);
  const { scope } = binding;
  const settings = haystackSettingsSchema.parse(input.settings);
  const manifest = canonicalRetrievalManifest(input.corpus.manifest);
  if (scope.corpusId !== manifest.corpusId || scope.snapshotId !== manifest.snapshotId ||
    scope.snapshotSha256 !== manifest.snapshotSha256 || scope.generation !== input.corpus.generation ||
    retrievalGeneration(manifest, input.corpus.config) !== scope.generation ||
    input.corpus.passages.length > PROJECT_RETRIEVAL_CORPUS_LIMITS.passages) throw new Error('Haystack corpus binding mismatch');
  const passages = new Map(input.corpus.passages.map(value => {
    const passage = projectRetrievalPassageSchema.parse(value);
    const document = manifest.documents.find(d => d.path === passage.path && d.sha256 === passage.sha256);
    if (!document || passage.endByte > document.bytes || passage.documentId !== retrievalDocumentId(document.path, document.sha256)) {
      throw new Error('Haystack passage source mismatch');
    }
    const id = projectRetrievalHash(JSON.stringify([passage.documentId, passage.startByte, passage.endByte]));
    return [id, passage] as const;
  }));
  if (passages.size !== input.corpus.passages.length) throw new Error('Haystack duplicate passage');
  let child: HaystackProcess | undefined;
  try {
    if (await binding.service.authorize(scope, input.context) !== true) throw new Error('Haystack source denied');
    if (settings.mode === 'hybrid-rerank' && (
      await haystackModelRevision(settings.embeddingPath, input.context) !== settings.embeddingRevision ||
      await haystackModelRevision(settings.rerankerPath, input.context) !== settings.rerankerRevision)) {
      throw new Error('Haystack model files changed');
    }
    assertRetrievalTime(input.context);
    child = new HaystackProcess(input.python);
    const ready = await child.send({ op: 'init', settings, documents: [...passages].map(([id, p]) => ({
      id, content: retrievalPassageContext(manifest, p) + '\n' + p.excerpt,
    })) }, input.context, true);
    if (ready.kind !== 'ready' || (input.runtimeSha256 !== undefined && ready.runtimeSha256 !== input.runtimeSha256) ||
        ready.documents !== passages.size || await binding.service.authorize(scope, input.context) !== true) {
      throw new Error('Haystack initialization refused');
    }
    assertRetrievalTime(input.context);
    const process = child;
    let closed = false;
    return { scope, limits: binding.limits, service: {
      authorize: async (candidate, context) => !closed && JSON.stringify(candidate) === JSON.stringify(scope) &&
        await binding.service.authorize(candidate, context) === true,
      search: async (candidate, query, context) => {
        if (closed || JSON.stringify(candidate) !== JSON.stringify(scope)) return { ok: false, status: 'denied' };
        const result = await process.send({ op: 'search', query: query.text, lexicalQuery: query.terms.join(' '), limit: query.maxCandidates }, context);
        if (result.kind !== 'result' || result.hits.length > query.maxCandidates || new Set(result.hits.map(h => h.id)).size !== result.hits.length) {
          throw new Error('Haystack invalid result');
        }
        return { ok: true, status: 'ok', corpusId: scope.corpusId, snapshotId: scope.snapshotId,
          snapshotSha256: scope.snapshotSha256, generation: scope.generation,
          passages: result.hits.map(hit => {
            const passage = passages.get(hit.id);
            if (!passage) throw new Error('Haystack unknown passage');
            return { ...passage, score: hit.score };
          }), truncated: result.hits.length >= query.maxCandidates };
      },
      dispose: async () => {
        if (closed) return;
        closed = true;
        try { await process.close(); } finally { passages.clear(); await binding.service.dispose(); }
      },
    } };
  } catch (error) {
    try { await child?.close(); } finally { await binding.service.dispose(); }
    throw error;
  }
}
