import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retrievalAttemptStartSchema, retrievalRegistrationSchema } from '../../src/contracts/retrievalCampaign.js';

/** Frozen real registration; no runtime/model execution in these fixtures. */
export function benchmarkRegistration() {
  return retrievalRegistrationSchema.parse(JSON.parse(readFileSync(resolve(
    import.meta.dirname, '../../benchmark/retrieval-citations-pilot-2026-09-09/registration.json'
  ), 'utf8')));
}

export function seedBenchmark(root: string) {
  const registration = benchmarkRegistration();
  const campaign = join(root, registration.spec.id);
  const attempt = join(campaign, 'attempts/0001');
  const traces = join(attempt, 'traces');
  mkdirSync(traces, { recursive: true });
  writeFileSync(join(campaign, 'registration.json'), JSON.stringify(registration));
  const start = retrievalAttemptStartSchema.parse({
    entry: registration.schedule[0], runId: 'benchmark-test-run', goal: 'test goal', initialState: 'fixture',
    executionEnv: { ATOMA_RUNS_DIR: traces },
  });
  const receipt = join(attempt, 'start.json');
  writeFileSync(receipt, JSON.stringify(start));
  const file = join(traces, `${start.runId}.json`);
  const trace = { id: start.runId, label: 'Benchmark fixture', startedAt: new Date().toISOString(), events: [] };
  writeFileSync(file, JSON.stringify(trace));
  return { registration, start, file, receipt, trace, traces };
}
