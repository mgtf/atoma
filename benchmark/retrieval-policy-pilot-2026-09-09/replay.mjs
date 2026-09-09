// Offline replay only. Execute from this checkout with its pinned Node and --import tsx.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadRetrievalDataset, questionFor } from '../../src/cli/retrievalDataset.ts';
import { scoreRetrievalWorkspace } from '../../src/cli/retrievalScorer.ts';
import { retrievalObservations } from '../../src/cli/retrievalObservations.ts';
import { pairedRetrievalDecision } from '../../src/cli/retrievalComparison.ts';
import { retrievalRegistrationSchema } from '../../src/contracts/retrievalCampaign.ts';
import { parseRunStatsEpilogue } from '../../src/contracts/runStats.ts';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node --import tsx replay.mjs <extracted-evidence-directory>');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const dataset = loadRetrievalDataset(join(root, 'dataset'));
const registration = retrievalRegistrationSchema.parse(json(join(root, 'registration.json')));
const recordedRows = readFileSync(join(root, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.ok(recordedRows.length <= registration.schedule.length);
const report = json(join(root, existsSync(join(root, 'report.json')) ? 'report.json' : 'aborted.json'));
if (report.reason === 'completed') assert.equal(recordedRows.length, registration.schedule.length);
const comparison = pairedRetrievalDecision(registration, recordedRows);
if (comparison && report.reason !== 'completed') comparison.decision = 'inconclusive';
assert.deepEqual(comparison, report.comparison);
const rows = [];
for (const name of readdirSync(join(root, 'attempts')).filter(name => !name.startsWith('._')).sort()) {
  const attempt = join(root, 'attempts', name);
  const start = json(join(attempt, 'start.json'));
  const env = start.executionEnv;
  const originalAttempt = resolve(dirname(env.ATOMA_DB_PATH), '..');
  const relocate = path => {
    const suffix = relative(originalAttempt, path);
    if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('../')) throw new Error('archive path escapes its attempt');
    return join(attempt, suffix);
  };
  const workspace = relocate(env.ATOMA_BUILD_WORKSPACE);
  const tracePath = join(relocate(env.ATOMA_RUNS_DIR), start.runId + '.json');
  const trace = json(tracePath);
  const runner = parseRunStatsEpilogue(readFileSync(join(attempt, 'run.log'), 'utf8'));
  const score = scoreRetrievalWorkspace(dataset, start.entry.questionId, workspace);
  const observation = retrievalObservations(tracePath, dataset, questionFor(dataset, start.entry.questionId));
  const recorded = existsSync(join(attempt, 'result.json')) ? json(join(attempt, 'result.json')) : null;
  assert.ok(recorded, 'every scheduled attempt must have a stopped result');
  assert.deepEqual(recorded, recordedRows.find(row => row.entry.ordinal === start.entry.ordinal));
  assert.deepEqual(start.entry, registration.schedule.find(entry => entry.ordinal === start.entry.ordinal));
  assert.deepEqual(score, recorded.score);
  assert.deepEqual(runner, recorded.runner);
  if (existsSync(join(attempt, 'retrieval-observations.json'))) {
    assert.deepEqual(observation, json(join(attempt, 'retrieval-observations.json')));
  }
  const tools = trace.events.filter(e => e.kind === 'tool');
  const firstSearch = tools.findIndex(e => e.name === 'search_project_docs');
  const sourcePaths = new Set(registration.spec.treatment ? dataset.corpus.snapshots.find(s => s.id === questionFor(dataset, start.entry.questionId).snapshotId).documents.map(d => d.path) : []);
  const firstSourceReadOrWrite = tools.findIndex(e => ['write_file', 'edit_file', 'record_probe'].includes(e.name) || (e.name === 'read_file' && sourcePaths.has(e.args?.path)));
  const invocation = { firstSearch, firstSourceReadOrWrite, searchBeforeSourceReadOrWrite: firstSearch >= 0 && (firstSourceReadOrWrite < 0 || firstSearch < firstSourceReadOrWrite), searchActors: tools.filter(e => e.name === 'search_project_docs').map(e => e.actor), toolErrors: tools.filter(e => e.error).map(e => ({name:e.name,error:e.error})) };
  rows.push({ invocation, entry: start.entry, runId: start.runId, recorded: !!recorded, full: recorded?.full ?? false,
    elapsedMs: recorded?.elapsedMs ?? null, runner, score, traceStartedAt: trace.startedAt, traceEndedAt: trace.endedAt,
    traceTotals: trace.totals, toolCalls: trace.events.filter(e => e.kind === 'tool').length,
    observedServedModels: [...new Set(trace.events.filter(e => e.kind === 'llm').map(e => e.servedModel ?? null))],
    retrieval: observation, preparation: json(join(attempt, 'preparation.json')) });
}
assert.equal(rows.length, recordedRows.length);
console.log(JSON.stringify(rows, null, 2));
