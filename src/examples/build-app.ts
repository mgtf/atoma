import Anthropic from '@anthropic-ai/sdk';
import { resolve } from 'node:path';
import { setMaxListeners } from 'node:events';
import { AnthropicLlmClient } from '../core/llm.js';
import { InMemoryMetrics, MetricsLlmClient } from '../core/metrics.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { openDb } from '../registry/db.js';
import { L3Atom } from '../atoms/L3Atom.js';
import { TraceRecorder } from '../viz/trace.js';
import { RecordingLlmClient } from '../viz/recordingLlm.js';
import { RecordingRegistry } from '../viz/recordingRegistry.js';
import { ToolSandbox } from '../tools/sandbox.js';
import { InMemoryToolRegistry } from '../tools/registry.js';
import { defaultBuiltinTools } from '../tools/builtin.js';
import type { Logger, RunContext, Task } from '../core/types.js';

const consoleLogger: Logger = {
  debug: (m, meta) => console.debug(m, meta ?? ''),
  info: (m, meta) => console.log(`ℹ ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`⚠ ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`✖ ${m}`, meta ?? ''),
};

async function main(): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required. Copy .env.example to .env and fill it.');
    process.exit(1);
  }

  const goal =
    process.argv[2] ??
    'Build a minimal WebGL Minesweeper game (10x10 grid, 10 mines). Implement everything in a single index.html that loads and runs standalone. Left-click reveals a cell, right-click flags. Then start a local static server and return the URL.';

  // Use a dedicated DB + workspace for build runs so we don't interfere with
  // the research-brief example's registry or clutter the repo root.
  const dbPath = process.env['ATOMA_BUILD_DB_PATH'] ?? './atoma-build.db';
  const workspaceRoot = resolve(
    process.env['ATOMA_BUILD_WORKSPACE'] ?? './build/app'
  );

  const runsDir = process.env['ATOMA_RUNS_DIR'] ?? './runs';
  const recorder = new TraceRecorder(runsDir);
  const db = openDb(dbPath);
  const registry = new RecordingRegistry(db, recorder);
  const anthropic = new Anthropic({ apiKey });
  const metrics = new InMemoryMetrics();
  const llm = new MetricsLlmClient(
    new RecordingLlmClient(new AnthropicLlmClient(anthropic), recorder),
    metrics
  );

  const sandbox = new ToolSandbox(workspaceRoot);
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.registerAll(
    defaultBuiltinTools({ sandbox, logger: consoleLogger })
  );
  const toolDecls = toolRegistry.declarations();

  console.log(`workspace: ${sandbox.root}`);
  console.log(`tools: ${toolDecls.map((t) => t.name).join(', ')}\n`);

  // Bootstrap or reuse a builder L3 cell.
  let l3Type = registry.listByTier(3).find((t) => t.name === 'Neuron');
  if (!l3Type) {
    l3Type = registry.create(3, {
      description:
        'A top-level cell that orchestrates real application builds by delegating strategy to L2 molecules; concrete side-effects happen only at L1.',
      systemPrompt: [
        'You are Neuron, a top-level cell that builds real apps end-to-end.',
        'DELEGATION DISCIPLINE: you NEVER call tools yourself. You choose an L2 molecule (reuse or create) and hand the task over. The L2 will in turn route a focused leaf task to an L1 element; L1 is the ONLY tier that writes files, runs shell commands, starts servers or validates HTML. This hierarchy keeps LLM cost low — do not try to do the work from here.',
        'Produce runnable, self-contained artefacts. Prefer a single index.html when possible.',
        'The final output you return must include the exact URL the L1 obtained from start_static_server so the user can open it.',
      ].join('\n'),
      tools: toolDecls,
      params: { maxTokens: 16384 },
      createdBy: 'user',
    });
    console.log(`bootstrapped L3 cell: ${l3Type.name}`);
  } else {
    // Always refresh the tools (executor set may have changed across runs).
    l3Type = registry.patch(
      l3Type.name,
      { addTools: toolDecls },
      'build-app',
      'refresh system tools'
    );
    console.log(`reusing L3 cell: ${l3Type.name} (v${l3Type.version})`);
  }

  const l3 = await L3Atom.fromType(l3Type, registry, anthropic);
  console.log(`L3 ${l3.name} using model ${l3.model}`);

  // 10-minute default matches the original hard-coded budget; override with
  // ATOMA_BUILD_TIMEOUT_MS for iterative build tasks that need more room
  // (WebGL Minesweeper-style runs routinely burn 6-8 min in the
  // validate_html → fix → re-validate loop and benefit from extra headroom).
  const timeoutMs = Number(process.env['ATOMA_BUILD_TIMEOUT_MS'] ?? 10 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(
      `invalid ATOMA_BUILD_TIMEOUT_MS="${process.env['ATOMA_BUILD_TIMEOUT_MS']}" (expected positive integer in ms)`
    );
    process.exit(2);
  }
  console.log(`run timeout: ${Math.round(timeoutMs / 1000)}s`);
  const signal = AbortSignal.timeout(timeoutMs);
  // Every LLM call + supervise-loop hop hangs an `abort` listener on this
  // signal; on long runs Node trips its default 10-listener warning. Lift
  // the cap — none of these are true leaks, they all clear on settle.
  setMaxListeners(0, signal);

  const ctx: RunContext = {
    logger: consoleLogger,
    signal,
    llm,
    limits: DEFAULT_LIMITS,
    tools: toolRegistry,
  };

  const task: Task = {
    description: goal,
    constraints: [
      'The L1 worker must actually create the files on disk via the write_file tool.',
      'The L1 worker must actually start the server via the start_static_server tool and return that URL.',
      'The L1 worker must call validate_html on the returned URL and iterate (read + rewrite) until there are zero console.error messages and zero failed requests.',
      'Keep the implementation small and self-contained.',
    ],
  };

  console.log(`\ntask: ${task.description}\n`);

  // Keep the process alive until the user hits Ctrl+C so the static server
  // stays reachable. Clean up child processes on exit.
  const shutdown = async (code = 0): Promise<void> => {
    console.log('\nshutting down sandbox children...');
    recorder.flushPartial();
    await sandbox.cleanup();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  recorder.beginRun(task, `build-app: ${goal.slice(0, 80)}`, {
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

    console.log('\n--- result ---');
    console.log(
      typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output, null, 2)
    );
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
    console.log(
      '\n✓ app built. The static server should still be running inside the sandbox.'
    );
    console.log('  Press Ctrl+C when you are done testing.');
    // Park forever until a signal comes in.
    await new Promise(() => {});
  } catch (err) {
    recorder.endRun({ error: (err as Error).message });
    console.error(err);
    await shutdown(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
