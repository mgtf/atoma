import { setMaxListeners } from 'node:events';
import { makeAnthropicClient } from './auth.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { InMemoryMetrics, MetricsLlmClient } from '../core/metrics.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { openDb } from '../registry/db.js';
import { L3Atom } from '../atoms/L3Atom.js';
import { TraceRecorder } from '../viz/trace.js';
import { RecordingLlmClient } from '../viz/recordingLlm.js';
import { RecordingRegistry } from '../viz/recordingRegistry.js';
import type { Logger, RunContext, Task } from '../core/types.js';

const consoleLogger: Logger = {
  debug: (m, meta) => console.debug(m, meta ?? ''),
  info: (m, meta) => console.log(`ℹ ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`⚠ ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`✖ ${m}`, meta ?? ''),
};

async function main(): Promise<void> {
  const dbPath = process.env['ATOMA_DB_PATH'] ?? './atoma.db';
  const runsDir = process.env['ATOMA_RUNS_DIR'] ?? './runs';
  const recorder = new TraceRecorder(runsDir);
  const db = openDb(dbPath);
  const registry = new RecordingRegistry(db, recorder);
  // API key → ANTHROPIC_AUTH_TOKEN → `ant auth login` CLI profile;
  // ATOMA_AUTH=cli drops a stale exported key so the profile wins.
  const anthropic = makeAnthropicClient();
  const metrics = new InMemoryMetrics();
  const llm = new MetricsLlmClient(
    new RecordingLlmClient(new AnthropicLlmClient(anthropic), recorder),
    metrics
  );

  // Bootstrap: ensure at least one L3 cell exists. Reuse if already there.
  let l3Type = registry.listByTier(3)[0];
  if (!l3Type) {
    l3Type = registry.create(3, {
      description:
        'A top-level cell that orchestrates research briefs by delegating to molecules.',
      systemPrompt: [
        'You are Neuron, a top-level cell orchestrating research briefs.',
        'You supervise L2 molecules. Decide whether to reuse an existing molecule or design a new one.',
        'When creating a new L2, provide a focused system prompt and a sensible temperature.',
        'Validate your children strictly: reject plans that would produce vague or unsupported briefs.',
      ].join('\n'),
      tools: [],
      params: { temperature: 0.2, maxTokens: 2048 },
      createdBy: 'user',
    });
    console.log(`bootstrapped L3 cell: ${l3Type.name}`);
  } else {
    console.log(`reusing L3 cell: ${l3Type.name} (v${l3Type.version})`);
  }

  const l3 = await L3Atom.fromType(l3Type, registry, anthropic);
  console.log(`L3 ${l3.name} using model ${l3.model}`);

  const signal = AbortSignal.timeout(5 * 60 * 1000);
  // Every LLM call + supervise-loop hop hangs an `abort` listener on this
  // signal; on long runs Node trips its default 10-listener warning. Lift
  // the cap — none of these are true leaks, they all clear on settle.
  setMaxListeners(0, signal);

  const ctx: RunContext = {
    logger: consoleLogger,
    signal,
    llm,
    limits: DEFAULT_LIMITS,
    recordTrust: (info) => recorder.recordTrust(info),
  };

  const topic = process.argv[2] ?? 'the ecological impact of vertical farming';
  const task: Task = {
    description: `Produce a concise research brief on: ${topic}`,
    constraints: [
      'Return a 3-bullet summary and a 1-paragraph nuance note.',
      'Be specific; avoid filler.',
    ],
  };

  console.log(`\ntask: ${task.description}\n`);
  recorder.beginRun(task, `research-brief: ${topic}`, {
    initialTypes: [
      ...registry.listByTier(1),
      ...registry.listByTier(2),
      ...registry.listByTier(3),
    ],
  });
  let result;
  try {
    result = await l3.handle(task, ctx);
    recorder.endRun({
      result: {
        summary: result.summary,
        output: result.output,
        producedBy: result.producedBy,
      },
    });
  } catch (err) {
    recorder.endRun({ error: (err as Error).message });
    throw err;
  }

  console.log('\n--- result ---');
  console.log(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2));
  console.log('\nsummary:', result.summary);
  console.log('producedBy:', result.producedBy);
  console.log(`\nregistry state:`);
  for (const tier of [1, 2, 3] as const) {
    const types = registry.listByTier(tier);
    console.log(
      `  tier ${tier}: ${
        types
          .map((t) => `${t.name}(v${t.version}, ✓${t.successes}/✗${t.failures})`)
          .join(', ') || '(none)'
      }`
    );
  }

  console.log(`\nLLM usage:`);
  console.log(metrics.formatSummary());

  console.log(
    `\nrun enregistré dans ${recorder.runsDir} — démarre le visualiseur : npm run viz`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
