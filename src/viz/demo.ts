import { MockLlmClient } from '../core/llm.js';
import { openDb } from '../registry/db.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { L3Atom } from '../atoms/L3Atom.js';
import { TraceRecorder } from './trace.js';
import { RecordingLlmClient } from './recordingLlm.js';
import { RecordingRegistry } from './recordingRegistry.js';
import type { Logger, RunContext, Task } from '../core/types.js';

/**
 * Produces a synthetic run (no API key required) so the web visualizer has
 * something to show out of the box. Uses the same MockLlmClient the unit
 * tests rely on, and walks the supervise loops end-to-end (L3 → L2 → L1) with
 * canned responses that exercise create / plan / validate / execute.
 *
 * Run with:  npm run viz:demo
 */

const logger: Logger = {
  debug: () => {},
  info: (m) => console.log('ℹ ' + m),
  warn: (m) => console.warn('⚠ ' + m),
  error: (m) => console.error('✖ ' + m),
};

async function main(): Promise<void> {
  const runsDir = process.env['ATOMA_RUNS_DIR'] ?? './runs';
  const recorder = new TraceRecorder(runsDir);
  const db = openDb(':memory:');
  const registry = new RecordingRegistry(db, recorder);
  const mock = new MockLlmClient();
  const llm = new RecordingLlmClient(mock, recorder);

  const l3Type = registry.create(3, {
    description: 'Demo cell orchestrating a scripted run.',
    systemPrompt: 'You are Neuron, a demo L3 cell.',
    tools: [],
    params: { temperature: 0.2, maxTokens: 2048 },
    createdBy: 'viz-demo',
  });
  const l3 = L3Atom.buildWithModel(l3Type, registry, 'claude-opus-4-0');

  // Exact call order produced by the nested supervise loops on the happy
  // path (child catalogs start empty, so no prefilter calls fire):
  //   1. L3.plan                                 → strategy+plan pair
  //   2. L2.plan                                 → strategy+plan pair
  //   3. L3.validatePlan(child=L2, plan=L2.plan) → verdict
  //   4. L1.plan                                 → plan
  //   5. L2.validatePlan(child=L1, plan=L1.plan) → verdict
  //   6. L1.execute                              → result payload
  //   7. L2.validateResult(child=L1, result)     → verdict
  //   8. L3.validateResult(child=L2, result)     → verdict

  mock.enqueueText(
    JSON.stringify([
      {
        strategy: 'create',
        seed: {
          description: 'A demo L2 molecule that decomposes tiny research tasks.',
          systemPrompt: 'You are a demo L2 molecule.',
          tools: [],
          params: { temperature: 0.2, maxTokens: 1024 },
        },
        reasoning: 'no L2 exists yet — must create one for this task',
      },
      {
        reasoning: 'delegate to a new L2 molecule',
        proposedAction: 'create an L2 molecule and hand off the brief',
        expectedOutput: 'a 3-bullet brief from the new molecule',
      },
    ])
  );
  mock.enqueueText(
    JSON.stringify([
      {
        strategy: 'create',
        seed: {
          description: 'A demo L1 element that writes a short brief from its prompt.',
          systemPrompt: 'You are a demo L1 element.',
          tools: [],
          params: { temperature: 0.3, maxTokens: 512 },
        },
        reasoning: 'no L1 exists — create a leaf element',
      },
      {
        reasoning: 'delegate to a new L1 element',
        proposedAction: 'create an L1 element and ask it to produce the brief',
        expectedOutput: 'a short structured brief',
      },
    ])
  );
  mock.enqueueText(JSON.stringify({ approved: true, reasoning: 'L2 plan is on point' }));
  mock.enqueueText(
    JSON.stringify({
      reasoning: 'return a canned brief',
      proposedAction: 'emit JSON brief',
      expectedOutput: 'a 3-bullet brief + nuance note',
    })
  );
  mock.enqueueText(JSON.stringify({ approved: true, reasoning: 'L1 plan is coherent' }));
  mock.enqueueText(
    JSON.stringify({
      output: {
        bullets: [
          'Vertical farms use 95% less water than conventional agriculture.',
          'Lighting energy dominates their carbon footprint.',
          'Best suited for leafy greens and herbs today.',
        ],
        nuance:
          'The environmental win is conditional on the electricity mix: on a coal-heavy grid the footprint can exceed a well-run conventional farm, while on a renewable grid vertical farms outperform across most metrics.',
      },
      summary: 'Three-bullet brief + one-paragraph nuance note on vertical farming.',
    })
  );
  mock.enqueueText(JSON.stringify({ approved: true, reasoning: 'L1 result satisfies the task' }));
  mock.enqueueText(JSON.stringify({ approved: true, reasoning: 'L2 result satisfies the task' }));

  const ctx: RunContext = {
    logger,
    signal: AbortSignal.timeout(60_000),
    llm,
    limits: DEFAULT_LIMITS,
  };

  const task: Task = {
    description: 'Produce a concise research brief on vertical farming (demo run, mocked LLM).',
    constraints: [
      'Return a 3-bullet summary and a 1-paragraph nuance note.',
      'Be specific; avoid filler.',
    ],
  };

  recorder.beginRun(task, 'demo — research brief (mocked)', {
    initialTypes: [
      ...registry.listByTier(1),
      ...registry.listByTier(2),
      ...registry.listByTier(3),
    ],
  });
  try {
    const result = await l3.handle(task, ctx);
    recorder.endRun({
      result: {
        summary: result.summary,
        output: result.output,
        producedBy: result.producedBy,
      },
    });
    console.log(`demo run saved in ${recorder.runsDir}`);
    console.log(`start the viewer:   npm run viz`);
  } catch (err) {
    recorder.endRun({ error: (err as Error).message });
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
