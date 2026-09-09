// Direct retrieval experiment. No agent, answer generation, model API, or product state.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { platform, arch } from 'node:os';
import Database from 'better-sqlite3';
import { loadRetrievalDataset, snapshotFor } from '../../dist/cli/retrievalDataset.js';
import { retrievalObservations } from '../../dist/cli/retrievalObservations.js';
import { prepareProjectRetrievalCorpus } from '../../dist/projects/retrievalCorpus.js';
import { ProjectRetrievalIndex } from '../../dist/projects/retrievalIndex.js';
import { createHaystackRetrievalBinding } from '../../dist/projects/retrievalHaystack.js';
import { haystackModelRevision } from '../../dist/projects/retrievalModelFiles.js';
import { DEFAULT_PROJECT_RETRIEVAL_LIMITS, projectRetrievalScopeSchema } from '../../dist/contracts/projectRetrieval.js';
import { createProjectRetrievalTool } from '../../dist/tools/projectRetrieval.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const [command, outputArg, pythonArg, modelsArg] = process.argv.slice(2);
if (!outputArg || !['register', 'run', 'replay'].includes(command ?? '')) throw new Error('Usage: node benchmark/haystack/evaluate.mjs <register|run|replay> <output> [absolute-python absolute-model-root]');
const output = resolve(outputArg);
const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 120_000 });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const dataset = loadRetrievalDataset(join(repo, 'benchmark/retrieval'));
const snapshot = snapshotFor(dataset, 'northstar-v1');
const questions = dataset.questions.filter(q => q.snapshotId === snapshot.id);
const arms = ['sqlite-fts5', 'haystack-bm25', 'haystack-hybrid-rerank'];
function report() {
  const rows = arms.map(arm => {
    const observations = questions.map(q => retrievalObservations(join(output, `${arm}-${q.id}.json`), dataset, q));
    if (observations.some(o => !o)) throw new Error('missing or invalid evidence');
    const facts = observations.reduce((n, o) => n + o.coveredFacts, 0);
    const expectedFacts = observations.reduce((n, o) => n + o.expectedFacts, 0);
    const times = observations.map(o => o.durationMs).sort((a, b) => a - b);
    return { arm, questions: questions.length, answerable: questions.filter(q => q.answerable).length,
      fullyCovered: observations.filter(o => o.expectedFacts > 0 && o.coveredFacts === o.expectedFacts).length,
      coveredFacts: facts, expectedFacts,
      failures: observations.reduce((n, o) => n + o.failures, 0),
      invalidSourcePassages: observations.reduce((n, o) => n + o.invalidSourcePassages, 0),
      unanswerableWithHits: observations.filter((o, i) => !questions[i].answerable && o.returnedPassages > 0).length,
      medianQueryMs: times[Math.floor(times.length / 2)],
      preparation: json(join(output, `${arm}-preparation.json`)),
      observations: observations.map((o, i) => ({ questionId: questions[i].id, ...o })) };
  });
  const control = rows[0];
  return { measurement: 'direct-retrieval-development-only', rows, decision: rows.slice(1).some(r =>
    r.failures === 0 && r.invalidSourcePassages === 0 && r.fullyCovered > control.fullyCovered) ?
    'candidate-for-agent-evaluation' : 'no-promotion-evidence',
    caveat: 'No answer generation or task-success measurement. One pass on 13 development questions; no held-out evaluation.' };
}
if (command === 'replay') {
  process.stdout.write(JSON.stringify(report(), null, 2) + '\n');
} else {
  if (!pythonArg || !modelsArg || !pythonArg.startsWith('/') || !modelsArg.startsWith('/')) throw new Error('Explicit absolute runtime/model paths required');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  // Both compiled modules and source must match the committed registration.
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'src', 'scripts', 'benchmark/haystack'], { cwd: repo });
  const sources = execFileSync('git', ['ls-files', 'src', 'scripts/retrieval-haystack.py', 'scripts/requirements-haystack*.txt', 'benchmark/haystack'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  const sourceHashes = Object.fromEntries(sources.map(p => [p, digest(readFileSync(join(repo, p)))]));
  const compiledHashes = Object.fromEntries(sources.filter(p => p.startsWith('src/') && /\.tsx?$/.test(p))
    .map(p => p.replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js')).filter(p => existsSync(join(repo, p)))
    .map(p => [p, digest(readFileSync(join(repo, p)))]));
  const runtime = JSON.parse(execFileSync(pythonArg, ['-I', '-c', 'import json,platform; from importlib.metadata import distributions; print(json.dumps({"python":platform.python_version(),"packages":dict(sorted((d.metadata["Name"],d.version) for d in distributions()))}))'], { encoding: 'utf8' }));
  const settings = { mode: 'hybrid-rerank', embeddingPath: join(modelsArg, 'embedding'), rerankerPath: join(modelsArg, 'reranker'),
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    embeddingRevision: await haystackModelRevision(join(modelsArg, 'embedding'), context()),
    rerankerRevision: await haystackModelRevision(join(modelsArg, 'reranker'), context()) };
  const identity = { sourceCommit, sourceHashes, compiledHashes, runtime, host: { platform: platform(), arch: arch(), node: process.version },
    instrumentsSha256: digest(readFileSync(join(repo, 'benchmark/retrieval/instruments.lock.json'))),
    snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, questionIds: questions.map(q => q.id),
    limits: DEFAULT_PROJECT_RETRIEVAL_LIMITS, settings, arms };
  if (command === 'register') {
    mkdirSync(output);
    write('registration.json', { registeredAt: new Date().toISOString(), identity,
      selection: 'All 13 Northstar development questions, once per arm, exact prompts as queries; no rewriting or retries.',
      pipeline: 'BM25Okapi + cosine dense retrieval; equal-weight reciprocal rank fusion; cross-encoder reranking; CPU; framework defaults.',
      metric: 'Golden evidence coverage in the existing host element output at limit=5; exact source validation by the unchanged retrievalObservations scorer.',
      screen: 'Advance to an agent experiment only if a Haystack arm improves fully covered answerable questions over FTS5 with zero failed calls and invalid source passages.',
      limits: 'No task success, answer correctness, agentic baseline, scale or SOTA quality claim. No automatic activation.' });
  } else {
    const registration = json(join(output, 'registration.json'));
    if (JSON.stringify(identity) !== JSON.stringify(registration.identity)) throw new Error('execution differs from registration');
    const startedAt = new Date().toISOString();
    const corpus = await prepareProjectRetrievalCorpus(join(dataset.root, snapshot.root), { version: 1,
      corpusId: 'development-docs', snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, documents: snapshot.documents }, context());
    const scope = projectRetrievalScopeSchema.parse({ kind: 'operator', runId: 'haystack-development-evaluation',
      corpusId: corpus.manifest.corpusId, snapshotId: corpus.manifest.snapshotId,
      snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation });
    for (const arm of arms) {
      const db = new Database(':memory:');
      const index = new ProjectRetrievalIndex(db);
      let binding;
      const begin = performance.now();
      try {
        const authority = { scope, limits: DEFAULT_PROJECT_RETRIEVAL_LIMITS,
          service: index.createService(scope, async () => true) };
        if (arm === 'sqlite-fts5') { await index.build(scope, corpus, context()); binding = authority; }
        else binding = await createHaystackRetrievalBinding({ authority, corpus, python: pythonArg,
          settings: arm === 'haystack-bm25' ? { mode: 'bm25' } : settings, context: context() });
        write(`${arm}-preparation.json`, { ok: true, elapsedMs: performance.now() - begin,
          documents: corpus.manifest.documents.length, passages: corpus.passages.length, generation: corpus.generation });
      } catch (error) {
        write(`${arm}-preparation.json`, { ok: false, elapsedMs: performance.now() - begin, error: String(error) });
      }
      const tool = binding && createProjectRetrievalTool(binding, context());
      try {
        for (const q of questions) {
          const begin = performance.now();
          const result = tool ? await tool.execute({ query: q.prompt, limit: 5 }) : { ok: false, status: 'unavailable' };
          write(`${arm}-${q.id}.json`, { questionId: q.id, startedAt, events: [{ kind: 'tool', name: 'search_project_docs',
            args: { query: q.prompt, limit: 5 }, result, durationMs: performance.now() - begin }] });
        }
      } finally { await tool?.close(); db.close(); }
    }
    write('report.json', { startedAt, finishedAt: new Date().toISOString(), ...report() });
    process.stdout.write(JSON.stringify(report(), null, 2) + '\n');
  }
}
