import Anthropic from '@anthropic-ai/sdk';
import { resolve } from 'node:path';
import { setMaxListeners } from 'node:events';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { InMemoryMetrics, MetricsLlmClient } from '../core/metrics.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { openDb } from '../registry/db.js';
import { L3Atom } from '../atoms/L3Atom.js';
import { SMOKE_DESIGN_GUIDANCE } from '../atoms/L2Atom.js';
import {
  ensureCanonicalL1,
  ensureCanonicalL2,
  ensureCanonicalHttpL1,
  ensureCanonicalHttpL2,
  ensureCanonicalFileScribeL1,
} from '../atoms/capability.js';
import { SkillRegistry } from '../skills/registry.js';
import { TraceRecorder } from '../viz/trace.js';
import { formatDecompositionReport, formatTimeoutPostMortem } from '../viz/report.js';
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
  // Provider selection. Default is Anthropic; set ATOMA_LLM=ollama to
  // run against a local Ollama install (or Ollama Cloud via a :cloud
  // tag). The Ollama path ignores ANTHROPIC_API_KEY and doesn't need a
  // network-reachable Anthropic endpoint. The L3 Opus-discovery step
  // (`resolveLatestOpus`) is also skipped — L3 falls back to its
  // FALLBACK_OPUS model id string, which the OllamaLlmClient then
  // silently substitutes with its configured default model.
  const provider = (process.env['ATOMA_LLM'] ?? 'anthropic').toLowerCase();
  const useOllama = provider === 'ollama';
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!useOllama && !apiKey) {
    console.error(
      'ANTHROPIC_API_KEY is required (or set ATOMA_LLM=ollama to use a local Ollama model).'
    );
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
  // Anthropic SDK is still constructed when ollama is selected — it
  // stays unused at inference time but L3.fromType accepts an optional
  // Anthropic client for its Opus-resolution step, and we pass
  // `undefined` when on the Ollama path so we never touch the network.
  const anthropic = useOllama ? undefined : new Anthropic({ apiKey: apiKey! });
  const metrics = new InMemoryMetrics();
  const baseClient = useOllama
    ? new OllamaLlmClient({
        baseUrl: process.env['OLLAMA_BASE_URL'],
        defaultModel: process.env['OLLAMA_MODEL'],
      })
    : new AnthropicLlmClient(anthropic!);
  const llm = new MetricsLlmClient(
    new RecordingLlmClient(baseClient, recorder),
    metrics
  );
  console.log(
    useOllama
      ? `llm provider: ollama — ${process.env['OLLAMA_MODEL'] ?? 'glm-5.1:cloud'} @ ${process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'}`
      : `llm provider: anthropic`
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

  // Bootstrap canonical L2 + L1 catalog entries. These are capability-
  // focused, domain-neutral atoms seeded so L3/L2 prefilter has a clean
  // reusable target on every run — without them the first build on a
  // fresh registry spawns a bespoke (and usually theme-poisoned) clone
  // of the same "single-file web artefact" recipe we already know how
  // to execute. Idempotent: we match by the `CANONICAL_BOOTSTRAP_MARKER`
  // in `createdBy`, refreshing tools on each run so the canonical
  // catalog follows the current executor set.
  const canonicalL2Web = ensureCanonicalL2(registry, toolDecls);
  console.log(
    `canonical L2 (web): ${canonicalL2Web.name} (v${canonicalL2Web.version}) — ${canonicalL2Web.description.slice(0, 70)}…`
  );
  const canonicalL2Http = ensureCanonicalHttpL2(registry, toolDecls);
  console.log(
    `canonical L2 (http): ${canonicalL2Http.name} (v${canonicalL2Http.version}) — ${canonicalL2Http.description.slice(0, 70)}…`
  );
  const canonicalL1Web = ensureCanonicalL1(registry, toolDecls, SMOKE_DESIGN_GUIDANCE);
  console.log(
    `canonical L1 (web): ${canonicalL1Web.name} (v${canonicalL1Web.version}) — ${canonicalL1Web.description.slice(0, 70)}…`
  );
  const canonicalL1Http = ensureCanonicalHttpL1(registry, toolDecls);
  console.log(
    `canonical L1 (http): ${canonicalL1Http.name} (v${canonicalL1Http.version}) — ${canonicalL1Http.description.slice(0, 70)}…`
  );
  const canonicalL1FileScribe = ensureCanonicalFileScribeL1(registry, toolDecls);
  console.log(
    `canonical L1 (file-scribe): ${canonicalL1FileScribe.name} (v${canonicalL1FileScribe.version}) — ${canonicalL1FileScribe.description.slice(0, 70)}…`
  );

  // Skill store — shared by every atom in the run. Skills are
  // filesystem-backed under ATOMA_SKILLS_DIR (default ./skills) so
  // they survive across invocations. L1 atoms hydrate their `skills()`
  // accessor from this registry on demand; L2 runs a Haiku
  // skill-prefilter against the matched L1's skills before entering
  // each supervise loop.
  const skillsDir = process.env['ATOMA_SKILLS_DIR'] ?? './skills';
  const skillRegistry = new SkillRegistry(skillsDir);
  console.log(`skills root: ${skillRegistry.rootDir}`);

  const l3 = await L3Atom.fromType(l3Type, registry, anthropic, skillRegistry);
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
    // Surface trust fast-path decisions in the trace so the viz lane
    // shows "why no L2 LLM call was needed" instead of an empty gap.
    recordTrust: (info) => recorder.recordTrust(info),
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
    const persistedRun = recorder.endRun({
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

    if (persistedRun) {
      console.log('');
      console.log(formatDecompositionReport(persistedRun));
    }

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
    // Format a richer post-mortem when the run aborts. #4 —
    // the default AbortError / timeout message ("This operation was
    // aborted") is unactionable; we dig into the partial run trace
    // the recorder has kept to surface: which tier/atom was running
    // last, which tool loops consumed the budget, and which
    // validator rejections the supervise loop couldn't recover from.
    // Everything stays best-effort: a diagnostic crash must not mask
    // the underlying error.
    const errMsg = (err as Error).message ?? String(err);
    const isTimeout =
      signal.aborted &&
      (signal.reason instanceof Error
        ? /timeout|aborted/i.test(signal.reason.message ?? '')
        : true);
    const run = recorder.currentRun;
    let postMortem = '';
    if (run) {
      try {
        postMortem = formatTimeoutPostMortem(run, {
          budgetMs: timeoutMs,
          isTimeout,
        });
      } catch {
        // swallow — we're already in the error path, don't pile on
      }
    }
    recorder.endRun({
      error: isTimeout ? `run aborted after ${Math.round(timeoutMs / 1000)}s budget` : errMsg,
    });
    console.error('\n--- run failed ---');
    console.error(isTimeout ? `⏱ TIMEOUT after ${Math.round(timeoutMs / 1000)}s — budget exhausted` : `✖ ${errMsg}`);
    if (postMortem) {
      console.error('');
      console.error(postMortem);
    }
    console.error('');
    console.error(`LLM usage at abort:`);
    console.error(metrics.formatSummary());
    console.error(
      `\nrun enregistré dans ${recorder.runsDir} — ouvre le visualiseur pour plus de détails : npm run viz`
    );
    await shutdown(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
