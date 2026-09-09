// Offline replay only. Execute from this checkout with its pinned Node and --import tsx.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadRetrievalDataset, questionFor } from '../../src/cli/retrievalDataset.ts';
import { scoreRetrievalWorkspace } from '../../src/cli/retrievalScorer.ts';
import { retrievalObservations } from '../../src/cli/retrievalObservations.ts';
import { parseRunStatsEpilogue } from '../../src/contracts/runStats.ts';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node --import tsx replay.mjs <extracted-evidence-directory>');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const dataset = loadRetrievalDataset(join(root, 'dataset'));
const rows = [];
for (const name of readdirSync(join(root, 'attempts')).sort()) {
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
  if (recorded) { assert.deepEqual(score, recorded.score); assert.deepEqual(runner, recorded.runner); }
  if (existsSync(join(attempt, 'retrieval-observations.json'))) {
    assert.deepEqual(observation, json(join(attempt, 'retrieval-observations.json')));
  }
  rows.push({ entry: start.entry, runId: start.runId, recorded: !!recorded, full: recorded?.full ?? false,
    elapsedMs: recorded?.elapsedMs ?? null, runner, score, traceStartedAt: trace.startedAt, traceEndedAt: trace.endedAt,
    traceTotals: trace.totals, toolCalls: trace.events.filter(e => e.kind === 'tool').length,
    observedServedModels: [...new Set(trace.events.filter(e => e.kind === 'llm').map(e => e.servedModel ?? null))],
    retrieval: observation, preparation: json(join(attempt, 'preparation.json')) });
}
console.log(JSON.stringify(rows, null, 2));
