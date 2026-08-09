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
import { SkillRegistry } from '../skills/registry.js';
import { TraceRecorder } from '../viz/trace.js';
import { formatDecompositionReport, formatTimeoutPostMortem } from '../viz/report.js';
import { RecordingLlmClient } from '../viz/recordingLlm.js';
import { RecordingRegistry } from '../viz/recordingRegistry.js';
import { containerToolBackend, localToolBackend } from './toolBackend.js';
import type { Logger, RunContext } from '../core/types.js';
import type { TaskProfile } from './profile.js';

export const consoleLogger: Logger = {
  debug: (m, meta) => console.debug(m, meta ?? ''),
  info: (m, meta) => console.log(`ℹ ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`⚠ ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`✖ ${m}`, meta ?? ''),
};

export interface RunnerArgs {
  goal?: string;
  noLearnSkills: boolean;
  noPromoteSkills: boolean;
  noDirectSkills: boolean;
  cleanWorkspace: boolean;
  container: boolean;
}

/**
 * Argv parsing for a run.
 *
 * DELIBERATELY NOT `src/cli/args.ts`. CLAUDE.md names `parseCliArgs` the
 * single source of truth for CLI flags, and this looks like a duplicate worth
 * collapsing — it is not. `parseCliArgs` treats `--clean-workspace` as a
 * flag-WITH-VALUE and would swallow the goal that follows it, so every
 * burn-in task would silently fall back to the default Minesweeper goal. The
 * divergence is load-bearing; leave it.
 */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  let goal: string | undefined;
  let noLearnSkills = false;
  let noPromoteSkills = false;
  let noDirectSkills = false;
  let cleanWorkspace = false;
  let container = process.env['ATOMA_CONTAINER'] === '1';
  for (const a of argv) {
    if (a === '--no-learn-skills') noLearnSkills = true;
    else if (a === '--no-promote-skills') noPromoteSkills = true;
    else if (a === '--no-direct-skills') noDirectSkills = true;
    else if (a === '--clean-workspace') cleanWorkspace = true;
    else if (a === '--container') container = true;
    else if (a === '--no-container') container = false;
    else if (a.startsWith('--')) console.warn(`unknown flag: ${a}`);
    else if (goal === undefined) goal = a;
  }
  return { goal, noLearnSkills, noPromoteSkills, noDirectSkills, cleanWorkspace, container };
}

/**
 * Run one task end to end, for any family.
 *
 * Extracted verbatim from the old `examples/build-app.ts`, which had become the
 * product while living in `examples/` — the burn-in harness spawns it per
 * task, CLAUDE.md documents it as load-bearing in a dozen places, and the
 * only other entrypoint had silently drifted away from every safety
 * guarantee added here (watchdog, signal handling, provider routing).
 *
 * THE CONSOLE OUTPUT OF THIS FUNCTION IS AN API. `src/cli/burnin.ts`'s
 * `parseRunLog` reads it to build `burnin/results.csv`, the project's
 * longitudinal cost curve across 146 committed rows. Three markers are owned
 * here — `✓ build finished`, `--- run failed ---` and `TIMEOUT after` — and
 * changing any of them silently reclassifies runs. The rest of what the
 * harness greps for is emitted by the library and the metrics table.
 * `tests/run-profile-build.test.ts` pins all three.
 */
export async function runTask(profile: TaskProfile, argv: readonly string[]): Promise<void> {
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

  const args = parseRunnerArgs(argv);
  const goal = args.goal ?? profile.defaultGoal;
  // Auto-distillation is ON by default. Priority is CLI flag > env var >
  // default-on. The L2 onApproved hook reads ATOMA_SKILL_LEARN === '1' at
  // call time, so we just set the env var here and the lib stays unchanged.
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
  // TRUST_PROMOTE_THRESHOLD_SUCCESSES with zero failures, the L2 makes a
  // single Sonnet call to compile its body into a deterministic Node
  // script. On approval the next match runs the script via write_file +
  // run_shell instead of an LLM tool-loop. Same priority ordering as
  // auto-distillation: CLI flag > env var > default-on. Demotion (any
  // future failure on the script form) restores the stashed llm body from
  // the `_fallback.md` sidecar, and the failures-must-be-zero gate then
  // blocks re-promotion until the operator resets the counters by hand.
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

  // Store + workspace are per-FAMILY so two families never share a registry
  // (and, with it, a taxonomy namespace and the ledger's one-store rule).
  const dbPath = process.env[profile.envVars.dbPath] ?? profile.defaults.dbPath;
  const workspaceRoot = resolve(
    process.env[profile.envVars.workspace] ?? profile.defaults.workspace
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
  profile.prepareWorkspace(workspaceRoot, args.cleanWorkspace);

  // Local by default; `--container` moves the tool layer into a container
  // with only the workspace mounted and no route out. The swap is possible
  // at ONE point because `ToolExecutor` is two methods and nothing in the
  // control plane reads the workspace except through it.
  const backend = args.container
    ? await containerToolBackend({ workspaceRoot })
    : localToolBackend({ workspaceRoot, logger: consoleLogger });
  const toolDecls = backend.toolDecls;

  console.log(`workspace: ${backend.rootLabel}`);
  console.log(`tools: ${toolDecls.map((t) => t.name).join(', ')}\n`);

  const seedCtx = { registry, toolDecls, log: (line: string) => console.log(line) };
  const l3Type = profile.seedL3(seedCtx);
  profile.seedCatalog(seedCtx);

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

  // Default budget is transport-aware: the claude-cli path adds 2-5s of
  // subprocess overhead to EVERY call, so a 3-phase cold start (~23 LLM
  // calls) that fits comfortably in 600s on the direct API dies at the
  // deadline on the CLI (measured twice on the same task before this).
  const timeoutRaw = process.env[profile.envVars.timeoutMs];
  const timeoutMs = Number(timeoutRaw ?? (useClaudeCli ? 15 * 60 * 1000 : 10 * 60 * 1000));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(
      `invalid ${profile.envVars.timeoutMs}="${timeoutRaw}" (expected positive integer in ms)`
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
    tools: backend.executor,
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

  const task = profile.buildTask(goal);

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
    await backend.cleanup();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  recorder.beginRun(task, `${profile.traceLabelPrefix}${goal.slice(0, 80)}`, {
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
      } else {
        console.error('   (no current run to close — the trace was already finalised)');
      }
    } catch (err) {
      // NEVER let bookkeeping block the exit — but say what went wrong.
      // This catch used to be silent, and it cost a real investigation:
      // the run of 2026-08-08T18:32 was left without `endedAt` (so the viz
      // showed it LIVE for 11 hours) and the log recorded only that the
      // watchdog had fired, with no way to tell a skipped close from a
      // failed one. The whole job of this path is to leave evidence behind.
      console.error(
        `   ✗ watchdog could not close the trace: ${(err as Error).message}`
      );
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
