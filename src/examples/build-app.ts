import { resolve } from 'node:path';
import { setMaxListeners } from 'node:events';
import { makeAnthropicClient } from './auth.js';
import { modelForTier } from '../core/models.js';
import { RoutingLlmClient } from '../core/llmRouting.js';
import { buildReferencedProviders } from './providers.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { ClaudeCliLlmClient } from '../core/llmClaudeCli.js';
import { InMemoryMetrics, MetricsLlmClient } from '../core/metrics.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { openDb } from '../registry/db.js';
import { L3Atom } from '../atoms/L3Atom.js';
import { SMOKE_DESIGN_GUIDANCE } from '../atoms/prompts.js';
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
import { prepareWorkspace } from './workspace.js';
import { InMemoryToolRegistry } from '../tools/registry.js';
import { defaultBuiltinTools } from '../tools/builtin.js';
import type { Logger, RunContext, Task } from '../core/types.js';

const consoleLogger: Logger = {
  debug: (m, meta) => console.debug(m, meta ?? ''),
  info: (m, meta) => console.log(`ℹ ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`⚠ ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`✖ ${m}`, meta ?? ''),
};

interface CliArgs {
  goal?: string;
  noLearnSkills: boolean;
  noPromoteSkills: boolean;
  noDirectSkills: boolean;
  cleanWorkspace: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let goal: string | undefined;
  let noLearnSkills = false;
  let noPromoteSkills = false;
  let noDirectSkills = false;
  let cleanWorkspace = false;
  for (const a of argv) {
    if (a === '--no-learn-skills') noLearnSkills = true;
    else if (a === '--no-promote-skills') noPromoteSkills = true;
    else if (a === '--no-direct-skills') noDirectSkills = true;
    else if (a === '--clean-workspace') cleanWorkspace = true;
    else if (a.startsWith('--')) console.warn(`unknown flag: ${a}`);
    else if (goal === undefined) goal = a;
  }
  return { goal, noLearnSkills, noPromoteSkills, noDirectSkills, cleanWorkspace };
}


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
  // ATOMA_LLM=claude-cli routes every LLM call through the local Claude
  // Code installation (Claude Agent SDK) — subscription auth, no API key.
  const useClaudeCli = provider === 'claude-cli' || provider === 'claude';

  const args = parseArgs(process.argv.slice(2));
  const goal =
    args.goal ??
    'Build a minimal WebGL Minesweeper game (10x10 grid, 10 mines). Implement everything in a single index.html that loads and runs standalone. Left-click reveals a cell, right-click flags. Then start a local static server and return the URL.';
  // Auto-distillation is ON by default in this example. Priority is
  // CLI flag > env var > default-on. The L2 onApproved hook reads
  // ATOMA_SKILL_LEARN === '1' at call time, so we just set the env
  // var here and the lib stays unchanged.
  if (args.noLearnSkills) {
    process.env['ATOMA_SKILL_LEARN'] = '0';
    console.log('skill auto-distillation: off (--no-learn-skills)');
  } else if (process.env['ATOMA_SKILL_LEARN'] === '0') {
    console.log('skill auto-distillation: off (ATOMA_SKILL_LEARN=0)');
  } else {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    console.log('skill auto-distillation: ON (default — pass --no-learn-skills to disable)');
  }
  // Skill llm→script PROMOTION (#C2c). When a kind:llm skill crosses
  // TRUST_PROMOTE_THRESHOLD_SUCCESSES (5) with zero failures, the L2
  // makes a single Sonnet call to compile its body into a deterministic
  // Node script. On approval the next match runs the script via
  // write_file + run_shell instead of an LLM tool-loop. Same priority
  // ordering as auto-distillation: CLI flag > env var > default-on.
  // Demotion (any future failure on the script form) restores the
  // stashed llm body from the `_fallback.md` sidecar, and the
  // failures-must-be-zero gate then blocks re-promotion until the
  // operator resets the counters by hand.
  if (args.noPromoteSkills) {
    process.env['ATOMA_SKILL_PROMOTE'] = '0';
    console.log('skill llm→script promotion: off (--no-promote-skills)');
  } else if (process.env['ATOMA_SKILL_PROMOTE'] === '0') {
    console.log('skill llm→script promotion: off (ATOMA_SKILL_PROMOTE=0)');
  } else {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    console.log(
      'skill llm→script promotion: ON (default — pass --no-promote-skills to disable)'
    );
  }
  // Deterministic dispatch of TRUSTED kind:script skills (#C4). A script
  // skill with 3+ clean runs executes via write_file + run_shell with
  // ZERO LLM calls; any deviation falls back to the normal LLM loop.
  // Unlike learn/promote this is a kill switch, not an opt-in — the lib
  // enables it whenever ATOMA_SKILL_DIRECT !== '0', because the path
  // costs nothing and is gated by trust counters.
  if (args.noDirectSkills) {
    process.env['ATOMA_SKILL_DIRECT'] = '0';
    console.log('trusted script direct dispatch: off (--no-direct-skills)');
  } else if (process.env['ATOMA_SKILL_DIRECT'] === '0') {
    console.log('trusted script direct dispatch: off (ATOMA_SKILL_DIRECT=0)');
  } else {
    console.log(
      'trusted script direct dispatch: ON (default — pass --no-direct-skills to disable)'
    );
  }

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
  // The Anthropic SDK client only exists on the direct-API path — it
  // feeds L3.fromType's Opus-resolution step. On the ollama and
  // claude-cli paths we pass `undefined` so we never touch the API
  // (L3 falls back to FALLBACK_OPUS, which each provider then maps to
  // its own model). Credential resolution happens inside
  // makeAnthropicClient (API key → ANTHROPIC_AUTH_TOKEN → `ant auth
  // login` CLI profile; ATOMA_AUTH=cli drops a stale exported key so
  // the profile wins). Exits with guidance if nothing resolves.
  const anthropic = useOllama || useClaudeCli ? undefined : makeAnthropicClient();
  const metrics = new InMemoryMetrics();
  const baseClient = useOllama
    ? new OllamaLlmClient({
        baseUrl: process.env['OLLAMA_BASE_URL'],
        defaultModel: process.env['OLLAMA_MODEL'],
      })
    : useClaudeCli
      ? new ClaudeCliLlmClient()
      : new AnthropicLlmClient(anthropic!);
  // Per-tier PROVIDER routing: tier pins may carry a `provider:` prefix
  // (ATOMA_MODEL_L1=zai:glm-4.5-air → L1 on Z.ai, L2/L3 on the default
  // provider). Only referenced providers are constructed; with none, the
  // router is a transparent passthrough. Observability wraps the ROUTER,
  // so calls are recorded once, with the vendor visible in the model id.
  const providers = buildReferencedProviders();
  const routedClient =
    Object.keys(providers).length > 0
      ? new RoutingLlmClient(baseClient, providers)
      : baseClient;
  if (Object.keys(providers).length > 0) {
    console.log(`tier providers: ${Object.keys(providers).join(', ')} (routed by model prefix)`);
  }
  const llm = new MetricsLlmClient(
    new RecordingLlmClient(routedClient, recorder),
    metrics
  );
  console.log(
    useOllama
      ? `llm provider: ollama — ${process.env['OLLAMA_MODEL'] ?? 'glm-5.1:cloud'} @ ${process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'}`
      : useClaudeCli
        ? `llm provider: claude-cli — local Claude Code auth; tiers map to haiku/sonnet/opus aliases${
            process.env['ATOMA_CLAUDE_MODEL']
              ? ` (⚠ DEBUG override, ALL tiers: ${process.env['ATOMA_CLAUDE_MODEL']} — cost gradient flattened)`
              : ''
          }`
        : `llm provider: anthropic`
  );
  // Provider-agnostic per-tier model pins (ATOMA_MODEL_L1/L2/L3) — show
  // the effective gradient whenever any tier deviates from its default.
  const tierPins = ([1, 2, 3] as const)
    .filter((t) => process.env[`ATOMA_MODEL_L${t}`])
    .map((t) => `L${t}=${modelForTier(t)}`);
  if (tierPins.length > 0) console.log(`tier models: ${tierPins.join('  ')}`);

  // Runs BEFORE the sandbox is constructed: ToolSandbox realpath-resolves
  // its root at construction, so archiving the directory afterwards would
  // leave every tool pointing at the archive.
  prepareWorkspace(workspaceRoot, args.cleanWorkspace);

  const sandbox = new ToolSandbox(workspaceRoot);
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.registerAll(
    defaultBuiltinTools({ sandbox, logger: consoleLogger })
  );
  const toolDecls = toolRegistry.declarations();

  console.log(`workspace: ${sandbox.root}`);
  console.log(`tools: ${toolDecls.map((t) => t.name).join(', ')}\n`);

  // Bootstrap or reuse a builder L3 cell. The system prompt is
  // ARTEFACT-NEUTRAL on purpose: earlier revisions said "Prefer a
  // single index.html when possible" and "the final output must
  // include the exact URL from start_static_server" — a web bias
  // baked into the PERSISTED L3 prompt that pressured every plan
  // toward the serve+validate pattern regardless of the task's
  // nature. The reuse branch refreshes the persisted prompt whenever
  // this constant changes, so a stale Neuron cannot keep an old bias
  // alive across runs (same idempotent-seeder pattern as the
  // ensureCanonical* helpers).
  const neuronSystemPrompt = [
    'You are Neuron, a top-level cell that builds real apps end-to-end.',
    'DELEGATION DISCIPLINE: you NEVER call tools yourself. You choose an L2 molecule (reuse or create) and hand the task over. The L2 will in turn route a focused leaf task to an L1 element; L1 is the ONLY tier that writes files, runs shell commands, starts servers and validates artefacts. This hierarchy keeps LLM cost low — do not try to do the work from here.',
    'Produce runnable, self-contained artefacts shaped by the task itself: a single index.html for browser pages, a Node entry file for HTTP servers/APIs, plain script/config/doc files for CLI and file deliverables. Never impose one artefact shape on a task of a different nature.',
    'The final output you return must state how the deliverable was verified (which probe ran and its result) and give its entry point: the served URL when a server is part of the deliverable, otherwise the main file path plus the command that runs it.',
  ].join('\n');
  let l3Type = registry.listByTier(3).find((t) => t.name === 'Neuron');
  if (!l3Type) {
    l3Type = registry.create(3, {
      description:
        'A top-level cell that orchestrates real application builds by delegating strategy to L2 molecules; concrete side-effects happen only at L1.',
      systemPrompt: neuronSystemPrompt,
      tools: toolDecls,
      params: { maxTokens: 16384 },
      createdBy: 'user',
    });
    console.log(`bootstrapped L3 cell: ${l3Type.name}`);
  } else {
    // Always refresh the tools (executor set may have changed across
    // runs) and re-align the system prompt with the current seed.
    l3Type = registry.patch(
      l3Type.name,
      {
        addTools: toolDecls,
        ...(l3Type.systemPrompt !== neuronSystemPrompt
          ? { systemPromptReplace: neuronSystemPrompt }
          : {}),
      },
      'build-app',
      'refresh system tools + seed prompt'
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
  // Default budget is transport-aware: the claude-cli path adds 2-5s of
  // subprocess overhead to EVERY call, so a 3-phase cold start (~23 LLM
  // calls) that fits comfortably in 600s on the direct API dies at the
  // deadline on the CLI (measured twice on the same task before this).
  const timeoutMs = Number(
    process.env['ATOMA_BUILD_TIMEOUT_MS'] ?? (useClaudeCli ? 15 * 60 * 1000 : 10 * 60 * 1000)
  );
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
    // Mirror recordTrust for skill-pipeline events so the viz can render
    // a Skills lane (match / inject / learn / update / counter bumps).
    recordSkill: (info) => recorder.recordSkillEvent(info),
    // Prefilter decisions replayed from the on-disk cache: the LLM call
    // that did NOT happen still deserves a card.
    recordCacheHit: (info) => recorder.recordCacheHit(info),
  };

  // Constraints are ARTEFACT-NEUTRAL on purpose. The original wording
  // hardcoded the web pattern ("start_static_server ... validate_html ...")
  // for every task — written for the Minesweeper demo, it forced a
  // serve+validate phase onto non-web deliverables. Observed on the
  // greet-cli live run: L3's prefilter flagged the constraints as
  // "fundamentally incompatible" with a CLI task, then dutifully planned
  // a phase 2 that served a directory listing just to satisfy them, and
  // the learn path distilled that workaround into a junk skill. The
  // verification-method choice belongs to the plan prompts'
  // "VERIFICATION MATCHES THE ARTEFACT" rule, not to the harness.
  const task: Task = {
    description: goal,
    constraints: [
      'The L1 worker must actually create the files on disk via the write_file tool.',
      'The deliverable must be VERIFIED with the probe matching its nature: ' +
        'browser-rendered pages via start_static_server + validate_html, iterating ' +
        '(read + rewrite) until zero console.error messages and zero failed requests; ' +
        'HTTP servers/APIs via start_node_server + fetch_url probes; ' +
        'CLI tools, scripts and configs via run_shell executing the artefact and checking its output.',
      'Keep the implementation small and self-contained.',
    ],
  };

  console.log(`\ntask: ${task.description}\n`);

  // Keep the process alive until the user hits Ctrl+C so the static server
  // stays reachable. Clean up child processes on exit.
  //
  // Run-state semantics on signal: if the recorder still has a current
  // run (i.e. l3.handle hadn't resolved yet → the user cancelled the
  // run mid-flight), we close it cleanly with `cancelled: true` so the
  // viz can label it "✕ cancelled" instead of leaving it as "● LIVE"
  // forever. If currentRun is null the run already ended (success or
  // error) before the signal arrived — endRun would no-op anyway.
  const shutdown = async (code = 0): Promise<void> => {
    console.log('\nshutting down sandbox children...');
    if (recorder.currentRun !== null) {
      recorder.endRun({
        error: 'run cancelled by user (signal received)',
        cancelled: true,
      });
    } else {
      recorder.flushPartial();
    }
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
  // LAST-RESORT WATCHDOG. `AbortSignal.timeout` above is ADVISORY — it
  // cancels work that OBSERVES it, and a transport wedged on a dropped
  // connection observes nothing, leaving `l3.handle` pending forever with
  // the event loop held open by the stuck handle. Found live: a run alive
  // after 11 DAYS (2 min of CPU), still holding a headless Chrome and an
  // esbuild service. The burn-in harness already group-kills its children
  // past a hard timer; this brings the same guarantee in-process so a
  // MANUALLY launched run cannot outlive its deadline either. The grace
  // period lets the normal abort path finish cleanly first — the watchdog
  // only fires when that path itself is stuck.
  const WATCHDOG_GRACE_MS = 60_000;
  const watchdog = setTimeout(() => {
    console.error(
      `\n✗ watchdog: the run is still unfinished ${Math.round((timeoutMs + WATCHDOG_GRACE_MS) / 1000)}s in,` +
        ` past its ${Math.round(timeoutMs / 1000)}s deadline — the transport is wedged (dropped connection?).` +
        ` Persisting the partial trace and exiting so nothing is left running.`
    );
    try {
      if (recorder.currentRun !== null) {
        recorder.endRun({ error: 'watchdog: deadline exceeded, transport wedged', cancelled: true });
      }
    } catch {
      /* never let bookkeeping block the exit */
    }
    // Synchronous exit on purpose: awaiting sandbox.cleanup() here would
    // re-enter the same class of hang the watchdog exists to escape. The
    // sandbox's process-level exit handler SIGKILLs tracked children.
    process.exit(1);
  }, timeoutMs + WATCHDOG_GRACE_MS);

  try {
    const result = await l3.handle(task, ctx);
    clearTimeout(watchdog);
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
      '\n✓ build finished. Any server the run started is still reachable inside the sandbox.'
    );
    console.log('  Press Ctrl+C when you are done testing.');
    // Park forever until a signal comes in.
    await new Promise(() => {});
  } catch (err) {
    // The run failed on its own terms (abort, transport error, crash):
    // the watchdog's job is done, and leaving its timer armed would hold
    // the event loop open for the whole grace period on a run that is
    // already finished.
    clearTimeout(watchdog);
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
