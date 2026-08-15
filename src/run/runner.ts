import { resolve } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { makeAnthropicClient } from './auth.js';
import { modelForTier } from '../core/models.js';
import { RoutingLlmClient } from '../core/llmRouting.js';
import { buildReferencedProviders, makeBaseClient, resolveBaseProviderKind } from './providers.js';
import { InMemoryMetrics, MetricsLlmClient } from '../core/metrics.js';
import { DEFAULT_LIMITS } from '../core/limits.js';
import { openDb } from '../registry/db.js';
import { assertCurrentTaxonomy } from '../registry/taxonomyMigration.js';
import { legacyStoreNotice, skillsDirPath } from '../core/stores.js';
import { L3Atom } from '../atoms/L3Atom.js';
import { SkillRegistry } from '../skills/registry.js';
import { TraceRecorder } from '../viz/trace.js';
import { formatDecompositionReport, formatTimeoutPostMortem } from '../viz/report.js';
import { RecordingLlmClient } from '../viz/recordingLlm.js';
import { RecordingRegistry } from '../viz/recordingRegistry.js';
import { containerToolBackend, localToolBackend } from './toolBackend.js';
import { runFrontierBaseline } from './baseline.js';
import { resolveToolBackendMode } from './backendMode.js';
import { parseArgTokens } from '../cli/args.js';
import {
  formatRunStatsEpilogue,
  type RunStats,
  type RunStatSignal,
} from '../contracts/runStats.js';
import type { Logger, Result, RunContext, Task } from '../core/types.js';
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
  egress: boolean;
  /**
   * Control arm of the cost experiment: one frontier agent with the same
   * tools, sandbox, budget and accounting, instead of the three-tier
   * cascade. See `src/run/baseline.ts` for why it lives here.
   */
  baseline: boolean;
  /**
   * Directory copied into the workspace AFTER it is prepared. A maintenance
   * task needs an artefact to maintain, and every run starts from an archived
   * empty workspace — without a seed the task degrades into a build task,
   * which is the shape we already measured four times.
   */
  seed?: string;
}

export type SkillPromotionSource =
  | 'cli-disable'
  | 'environment-enable'
  | 'environment-disable'
  | 'seed-default'
  | 'default-disable';

export interface SkillPromotionDecision {
  readonly enabled: boolean;
  readonly source: SkillPromotionSource;
}

type RunSignalCounts = Record<RunStatSignal, number>;

function machineRunStats(
  outcome: RunStats['outcome'],
  metrics: InMemoryMetrics,
  signals: Readonly<RunSignalCounts>
): RunStats {
  const summary = metrics.summary();
  const callsMatching = (marker: RegExp): number =>
    summary.perModel.reduce(
      (total, model) => total + (marker.test(model.model) ? model.calls : 0),
      0
    );
  const opusCalls = callsMatching(/opus/i);
  const sonnetCalls = callsMatching(/sonnet/i);
  const haikuCalls = callsMatching(/haiku/i);
  return {
    outcome,
    costUsd: Number(summary.totals.costUsd.toFixed(4)),
    llmCalls: summary.totals.calls,
    opusCalls,
    sonnetCalls,
    haikuCalls,
    otherCalls: Math.max(0, summary.totals.calls - opusCalls - sonnetCalls - haikuCalls),
    deterministicPhases: signals.deterministic,
    escalations: signals.escalation,
    learnedSkills: signals['learned-skill'],
    learnedEventSkills: signals['learned-event-skill'],
    promotions: signals.promotion,
    refusals: signals.refusal,
    compileErrors: signals['compile-error'],
    demotions: signals.demotion,
    dispatchFallbacks: signals['dispatch-fallback'],
  };
}

/**
 * Argv parsing for a run — a THIN adapter over the shared parser.
 *
 * This used to be a hand-rolled loop because the old `parseCliArgs` grammar
 * was greedy: `--clean-workspace <goal>` swallowed the goal and every burn-in
 * task silently fell back to the default Minesweeper build. The shared parser
 * now takes DECLARED boolean/negatable/value flags, so the runner expresses
 * its grammar as data instead of a second tokenizer. The grammar itself is
 * LOAD-BEARING: burn-in spawns this argv shape and MCP `spawnRun` appends the
 * goal LAST, so a declared boolean must never consume the following token and
 * an unknown flag is warn-and-DISCARDED (never fed the goal as its value).
 *
 * Spellings keep their `--` prefix: tests/mcp-server.test.ts greps this file
 * for the exact tokens the MCP server is allowed to emit.
 */
const RUNNER_BOOLEAN_FLAGS = [
  '--no-learn-skills',
  '--no-promote-skills',
  '--no-direct-skills',
  '--clean-workspace',
] as const;
/** Booleans that also accept an explicit `--no-` form; the LAST spelling wins. */
const RUNNER_NEGATABLE_FLAGS = ['--baseline', '--container', '--egress'] as const;

const stripDashes = (flag: string): string => flag.slice(2);

export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  // Container/egress stay OWNED by resolveToolBackendMode (doctor shares it,
  // including the env precedence and egress→container implication). They are
  // declared below only so the shared parser neither swallows the goal after
  // them nor reports them unknown; the parsed values are ignored.
  const backendMode = resolveToolBackendMode(argv);
  const { command, flags, undeclaredFlags } = parseArgTokens(argv, {
    booleanFlags: RUNNER_BOOLEAN_FLAGS.map(stripDashes),
    negatableFlags: RUNNER_NEGATABLE_FLAGS.map(stripDashes),
    // `--seed` consumes the next token UNCONDITIONALLY (historical contract);
    // a trailing `--seed` records '' and deliberately clobbers ATOMA_SEED.
    valueFlags: ['seed'],
    undeclared: 'discard',
  });
  for (const token of undeclaredFlags) console.warn(`unknown flag: ${token}`);
  const seed =
    'seed' in flags ? flags['seed'] || undefined : process.env['ATOMA_SEED'] || undefined;
  const baseline =
    flags['baseline'] !== undefined
      ? flags['baseline'] === 'true'
      : process.env['ATOMA_BASELINE'] === '1';
  return {
    goal: command ?? undefined,
    noLearnSkills: flags['no-learn-skills'] === 'true',
    noPromoteSkills: flags['no-promote-skills'] === 'true',
    noDirectSkills: flags['no-direct-skills'] === 'true',
    cleanWorkspace: flags['clean-workspace'] === 'true',
    ...backendMode,
    baseline,
    ...(seed ? { seed } : {}),
  };
}

/**
 * Resolve the llm→script compilation policy without starting a run.
 *
 * Promotion has value on maintenance work, represented today by a seeded
 * workspace. From-scratch runs keep compilation frozen unless the operator
 * explicitly opts in. The CLI kill switch is a veto, including over a seed
 * and `ATOMA_SKILL_PROMOTE=1`; only that exact environment value enables the
 * compiler, so typos fail closed.
 */
export function resolveSkillPromotion(
  args: Pick<RunnerArgs, 'noPromoteSkills' | 'seed'>,
  configuredValue: string | undefined
): SkillPromotionDecision {
  if (args.noPromoteSkills) return { enabled: false, source: 'cli-disable' };
  if (configuredValue === '1') return { enabled: true, source: 'environment-enable' };
  if (configuredValue !== undefined) {
    return { enabled: false, source: 'environment-disable' };
  }
  if (args.seed) return { enabled: true, source: 'seed-default' };
  return { enabled: false, source: 'default-disable' };
}

/**
 * A launched run, decoupled from the process that hosts it.
 *
 * `runTask` used to BE the process: it parked forever on a never-settling
 * promise so the demo server stayed reachable, called `process.exit` on six
 * paths, registered SIGINT/SIGTERM handlers per invocation without removal,
 * and left the skill-lifecycle env vars sticky across in-process calls. The
 * MCP server had to grow a SQLite lease, PGID plumbing and hard-exit
 * backstops purely because the only way to run a task was to fork a whole
 * npm process (2026-08-14 review §3.5). The park/exit behavior is a CLI
 * concern; it now lives in `runTask`, the thin shell over this handle.
 */
export interface RunHandle {
  /**
   * Settles when the task settles — after ALL of the run's reporting output
   * (result, registry state, metrics, stats epilogue, delivery/failure
   * banner) has been printed. Never parks, never exits the process. On the
   * failed path the backend has already been cleaned up.
   */
  readonly settled: Promise<RunOutcome>;
  /**
   * Graceful teardown: closes the trace (as `cancelled` when the run is
   * still in flight — the mid-run Ctrl+C semantics), then cleans the tool
   * backend. Idempotent; never exits the process.
   */
  shutdown(): Promise<void>;
}

export interface RunOutcome {
  readonly outcome: 'delivered' | 'failed';
}

/** Invalid launch input (timeout, seed, tier pin). The CLI maps it to exit 2. */
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConfigError';
  }
}

export type LifecycleToggleSource = 'cli-disable' | 'environment-disable' | 'default-enable';

export interface LifecycleToggleDecision {
  readonly enabled: boolean;
  readonly source: LifecycleToggleSource;
}

/** Auto-distillation policy: CLI flag > HOST env > default-on. Pure. */
export function resolveSkillLearning(
  noLearnSkills: boolean,
  hostValue: string | undefined
): LifecycleToggleDecision {
  if (noLearnSkills) return { enabled: false, source: 'cli-disable' };
  if (hostValue === '0') return { enabled: false, source: 'environment-disable' };
  return { enabled: true, source: 'default-enable' };
}

/** Trusted direct dispatch: a kill switch, not an opt-in. Pure. */
export function resolveDirectDispatch(
  noDirectSkills: boolean,
  hostValue: string | undefined
): LifecycleToggleDecision {
  if (noDirectSkills) return { enabled: false, source: 'cli-disable' };
  if (hostValue === '0') return { enabled: false, source: 'environment-disable' };
  return { enabled: true, source: 'default-enable' };
}

/**
 * STICKY-ENV FIX. The lifecycle resolvers must read what the OPERATOR
 * configured, never what a previous in-process run wrote: run 1 with
 * `--no-learn-skills` used to set ATOMA_SKILL_LEARN='0', and run 2 WITHOUT
 * the flag then read that '0' back as the operator's choice — the documented
 * default-on silently became sticky-off. The snapshot is taken once per
 * process, before the first run mutates anything, so every later resolution
 * sees the same host intent and `startTask` stays idempotent.
 */
interface HostLifecycleEnv {
  readonly learn: string | undefined;
  readonly promote: string | undefined;
  readonly direct: string | undefined;
}
let hostLifecycleEnv: HostLifecycleEnv | null = null;
/** Exported for tests and embedders; production callers never need it. */
export function hostLifecycleSnapshot(): HostLifecycleEnv {
  hostLifecycleEnv ??= {
    learn: process.env['ATOMA_SKILL_LEARN'],
    promote: process.env['ATOMA_SKILL_PROMOTE'],
    direct: process.env['ATOMA_SKILL_DIRECT'],
  };
  return hostLifecycleEnv;
}
export function resetHostLifecycleSnapshotForTests(): void {
  hostLifecycleEnv = null;
}

/**
 * Launch one task and return a handle, for any family.
 *
 * Extracted from `runTask` (itself extracted from the old
 * `examples/build-app.ts`, which had become the product while living in
 * `examples/`). This function owns everything a run IS — provider routing,
 * stores, sandbox, trace recording, the run budget, the watchdog, the
 * reporting output. It deliberately does NOT own how the host process ends:
 * no park-forever, no `process.exit`, no signal handlers. Those are CLI
 * concerns and live in `runTask`.
 *
 * THE CONSOLE OUTPUT OF THIS FUNCTION IS AN API. `src/cli/burnin.ts`'s
 * `parseRunLog` reads it to build `burnin/results.csv`, the project's
 * longitudinal cost curve across 146 committed rows. Three markers are owned
 * here — `✓ build finished`, `--- run failed ---` and `TIMEOUT after` — and
 * changing any of them silently reclassifies runs. The rest of what the
 * harness greps for is emitted by the library and the metrics table.
 * `tests/run-profile-build.test.ts` pins all three.
 *
 * `opts.onWedged` is the LAST-RESORT action when the watchdog finds the
 * transport wedged past the deadline. The default preserves the historical
 * CLI semantics — a synchronous `process.exit(1)` (awaiting cleanup there
 * would re-enter the same hang; the sandbox's process-level exit handler
 * SIGKILLs tracked children). An embedder may substitute its own action,
 * knowing the wedged transport may hold the event loop open regardless.
 */
export async function startTask(
  profile: TaskProfile,
  argv: readonly string[],
  opts?: { onWedged?: () => void }
): Promise<RunHandle> {
  // Provider selection. Default is Anthropic; set ATOMA_LLM=ollama to
  // run against a local Ollama install (or Ollama Cloud via a :cloud
  // tag). The Ollama path ignores ANTHROPIC_API_KEY and doesn't need a
  // network-reachable Anthropic endpoint. The L3 Opus-discovery step
  // (`resolveLatestOpus`) is also skipped — L3 falls back to its
  // FALLBACK_OPUS model id string, which the OllamaLlmClient then
  // silently substitutes with its configured default model.
  const provider = resolveBaseProviderKind(process.env['ATOMA_LLM']);
  const useOllama = provider === 'ollama';
  // ATOMA_LLM=claude-cli routes every LLM call through the local Claude
  // Code installation (Claude Agent SDK) — subscription auth, no API key.
  const useClaudeCli = provider === 'claude-cli';

  const args = parseRunnerArgs(argv);
  const goal = args.goal ?? profile.defaultGoal;
  // Validate every fallible launch argument BEFORE mutating the workspace,
  // opening stores or starting the container/egress backend. The old order
  // archived a valid deliverable before discovering a missing seed, and
  // could leave a proxy sidecar behind before rejecting a bad timeout.
  const timeoutRaw = process.env[profile.envVars.timeoutMs];
  const timeoutMs = Number(timeoutRaw ?? (useClaudeCli ? 15 * 60 * 1000 : 10 * 60 * 1000));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RunnerConfigError(
      `invalid ${profile.envVars.timeoutMs}="${timeoutRaw}" (expected positive integer in ms)`
    );
  }
  const seedRoot = args.seed ? resolve(args.seed) : undefined;
  if (seedRoot && !existsSync(seedRoot)) {
    throw new RunnerConfigError(`--seed: no such directory: ${seedRoot}`);
  }
  // Codex serves tiers 2/3 only — its transport cannot expose tools through
  // ToolSandbox, so an L1 pin would happily serve every prefilter/validator
  // (text-only) and detonate at the first tool-bearing execute, mid-run and
  // mid-spend. Doctor has carried this check since v0.1.3; a wrong tier pin
  // must fail at LAUNCH, not inside an optional diagnostic (review §3.9).
  const l1Pin = process.env['ATOMA_MODEL_L1']?.trim().toLowerCase();
  if (l1Pin?.startsWith('codex:')) {
    throw new RunnerConfigError(
      'ATOMA_MODEL_L1 cannot use codex because Codex cannot expose tools through ToolSandbox — pin L1 to a tool-capable provider (e.g. zai:glm-4.5-air) and keep codex on L2/L3'
    );
  }
  console.log(`run timeout: ${Math.round(timeoutMs / 1000)}s`);
  const signal = AbortSignal.timeout(timeoutMs);
  // Every LLM call + supervise-loop hop hangs an `abort` listener on this
  // signal; on long runs Node trips its default 10-listener warning.
  setMaxListeners(0, signal);

  // Lifecycle toggles resolve against the HOST snapshot (see
  // hostLifecycleSnapshot), then the env vars are written DETERMINISTICALLY
  // so the library hooks (which read them at call time) see the decision —
  // and so a second in-process run resolves from operator intent, not from
  // what the first run wrote.
  const hostEnv = hostLifecycleSnapshot();
  // Auto-distillation is ON by default. Priority is CLI flag > env var >
  // default-on. The L2 onApproved hook reads ATOMA_SKILL_LEARN === '1' at
  // call time, so we just set the env var here and the lib stays unchanged.
  const learning = resolveSkillLearning(args.noLearnSkills, hostEnv.learn);
  process.env['ATOMA_SKILL_LEARN'] = learning.enabled ? '1' : '0';
  if (learning.source === 'cli-disable') {
    console.log('skill auto-distillation: off (--no-learn-skills)');
  } else if (learning.source === 'environment-disable') {
    console.log('skill auto-distillation: off (ATOMA_SKILL_LEARN=0)');
  } else {
    console.log('skill auto-distillation: ON (default — pass --no-learn-skills to disable)');
  }
  // Skill llm→script PROMOTION (#C2c). When a kind:llm skill crosses
  // TRUST_PROMOTE_THRESHOLD_SUCCESSES with zero failures, the L2 makes a
  // single Sonnet call to compile its body into a deterministic Node
  // script. On approval the next match runs the script via write_file +
  // run_shell instead of an LLM tool-loop. Compilation is frozen by default
  // on from-scratch work: it has measured value on MAINTENANCE tasks, which
  // today are identified by a seeded workspace. Priority is CLI veto > exact
  // env opt-in/opt-out > seed default > default-off. Demotion (any future
  // failure on the script form) restores the stashed llm body from the
  // `_fallback.md` sidecar, and the failures-must-be-zero gate then blocks
  // re-promotion until the operator resets the counters by hand.
  const promotionEnv = hostEnv.promote;
  const promotion = resolveSkillPromotion(args, promotionEnv);
  process.env['ATOMA_SKILL_PROMOTE'] = promotion.enabled ? '1' : '0';
  if (promotion.source === 'cli-disable') {
    console.log('skill llm→script promotion: off (--no-promote-skills)');
  } else if (promotion.source === 'environment-enable') {
    console.log('skill llm→script promotion: ON (ATOMA_SKILL_PROMOTE=1)');
  } else if (promotion.source === 'environment-disable') {
    console.log(
      `skill llm→script promotion: off (ATOMA_SKILL_PROMOTE=${JSON.stringify(promotionEnv)}; only exact "1" enables)`
    );
  } else if (promotion.source === 'seed-default') {
    console.log(
      'skill llm→script promotion: ON (maintenance seed default — pass --no-promote-skills to disable)'
    );
  } else {
    console.log(
      'skill llm→script promotion: off (from-scratch default — set ATOMA_SKILL_PROMOTE=1 to opt in)'
    );
  }
  // Deterministic dispatch of TRUSTED kind:script skills (#C4). A script
  // skill with 3+ clean runs executes via write_file + run_shell with
  // ZERO LLM calls; any deviation falls back to the normal LLM loop.
  // Unlike learn/promote this is a kill switch, not an opt-in — the lib
  // enables it whenever ATOMA_SKILL_DIRECT !== '0', because the path
  // costs nothing and is gated by trust counters.
  const direct = resolveDirectDispatch(args.noDirectSkills, hostEnv.direct);
  process.env['ATOMA_SKILL_DIRECT'] = direct.enabled ? '1' : '0';
  if (direct.source === 'cli-disable') {
    console.log('trusted script direct dispatch: off (--no-direct-skills)');
  } else if (direct.source === 'environment-disable') {
    console.log('trusted script direct dispatch: off (ATOMA_SKILL_DIRECT=0)');
  } else {
    console.log(
      'trusted script direct dispatch: ON (default — pass --no-direct-skills to disable)'
    );
  }

  // The WORKSPACE is per-family; the STORE is not. A catalog of atom types
  // and skills is deliberately cross-family — `resolveCreationDescription`
  // strips task themes from descriptions precisely so a type earns reuse
  // outside the family that spawned it — so partitioning the registry by
  // family fought the one property it exists to have. The profile still names
  // the env var (a family COULD point elsewhere); today they all name
  // `ATOMA_DB_PATH`. See src/core/stores.ts for the four drifted copies this
  // replaced.
  const dbPath = process.env[profile.envVars.dbPath] ?? profile.defaults.dbPath;
  // Loudest possible place for the migration ramp: a run is what earns the
  // counters, so a run opening the pre-consolidation store must say so.
  const storeNotice = legacyStoreNotice(dbPath);
  if (storeNotice) console.log(storeNotice);
  const workspaceRoot = resolve(
    process.env[profile.envVars.workspace] ?? profile.defaults.workspace
  );

  const runsDir = process.env['ATOMA_RUNS_DIR'] ?? './runs';
  const recorder = new TraceRecorder(runsDir);
  const db = openDb(dbPath);
  assertCurrentTaxonomy(db);
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
  const runSignals: RunSignalCounts = {
    deterministic: 0,
    escalation: 0,
    'learned-skill': 0,
    'learned-event-skill': 0,
    promotion: 0,
    refusal: 0,
    'compile-error': 0,
    demotion: 0,
    'dispatch-fallback': 0,
  };
  // ONE construction switch, shared with curriculum (review §3.9): the
  // hand-rolled ternary here and its drifted copy over there were the exact
  // two-copies-of-one-rule class the repo has paid for twice.
  const baseClient = makeBaseClient(provider, anthropic ? { anthropic } : {});
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
  // Seed AFTER preparation — prepareWorkspace archives the whole directory, so
  // copying first would archive the fixture along with the previous run.
  if (seedRoot) {
    mkdirSync(workspaceRoot, { recursive: true });
    cpSync(seedRoot, workspaceRoot, { recursive: true });
    console.log(`workspace seeded from ${seedRoot} (${readdirSync(workspaceRoot).length} entries)`);
  }

  // Local by default; `--container` moves the tool layer into a container
  // with only the workspace mounted and no route out. The swap is possible
  // at ONE point because `ToolExecutor` is two methods and nothing in the
  // control plane reads the workspace except through it.
  const backend = args.container
    ? await containerToolBackend({
        workspaceRoot,
        egress: args.egress,
        runId: `${profile.id}-${process.pid}`,
      })
    : localToolBackend({ workspaceRoot, logger: consoleLogger });
  const toolDecls = backend.toolDecls;

  console.log(`workspace: ${backend.rootLabel}`);
  console.log(`tools: ${toolDecls.map((t) => t.name).join(', ')}\n`);

  // WHO HANDLES THE TASK — the single line that differs between the two arms
  // of the cost experiment. Everything above and below is shared verbatim, so
  // no difference in sandbox, tools, budget, cache behaviour, token
  // accounting or price table can leak into the comparison.
  let handle: (t: Task, c: RunContext) => Promise<Result>;

  if (args.baseline) {
    // CONTROL ARM. No taxonomy to seed and nothing to learn — and a control
    // that mutated the treatment arm's registry or skill store would
    // invalidate the experiment, so we touch neither.
    console.log(
      `\n⚖ BASELINE MODE — one ${modelForTier(3)} agent, no tiering, no learned recipes,` +
        ` no independent verification (it self-certifies).`
    );
    console.log('  Registry and skill store are NOT seeded and NOT written.\n');
    handle = (t, c) => runFrontierBaseline(t, c, toolDecls);
  } else {
    const seedCtx = { registry, toolDecls, log: (line: string) => console.log(line) };
    const l3Type = profile.seedL3(seedCtx);
    profile.seedCatalog(seedCtx);

    // Skill store — shared by every atom in the run. Skills are
    // filesystem-backed under ATOMA_SKILLS_DIR (default ./skills) so
    // they survive across invocations. L1 atoms hydrate their `skills()`
    // accessor from this registry on demand; L2 runs a Haiku
    // skill-prefilter against the matched L1's skills before entering
    // each supervise loop.
    const skillRegistry = new SkillRegistry(skillsDirPath());
    console.log(`skills root: ${skillRegistry.rootDir}`);

    const l3 = await L3Atom.fromType(l3Type, registry, anthropic, skillRegistry);
    console.log(`L3 ${l3.name} using model ${l3.model}`);
    handle = (t, c) => l3.handle(t, c);
  }

  const ctx: RunContext = {
    logger: consoleLogger,
    signal,
    llm,
    limits: DEFAULT_LIMITS,
    tools: backend.executor,
    requireObservedToolAction: true,
    // Surface trust fast-path decisions in the trace so the viz lane
    // shows "why no L2 LLM call was needed" instead of an empty gap.
    recordTrust: (info) => recorder.recordTrust(info),
    // Mirror recordTrust for skill-pipeline events so the viz can render
    // a Skills lane (match / inject / learn / update / counter bumps).
    recordSkill: (info) => recorder.recordSkillEvent(info),
    recordRunStat: (signalName) => {
      runSignals[signalName] += 1;
    },
    // Prefilter decisions replayed from the on-disk cache: the LLM call
    // that did NOT happen still deserves a card.
    recordCacheHit: (info) => recorder.recordCacheHit(info),
    recordBranch: (info) => recorder.recordBranch(info),
  };

  const task = profile.buildTask(goal);

  console.log(`\ntask: ${task.description}\n`);

  // Graceful teardown, shared by the failed path and the handle's
  // `shutdown()` (which the CLI wires to SIGINT/SIGTERM).
  //
  // Run-state semantics: if the recorder still has a current run (i.e. the
  // task hadn't settled yet → the caller is cancelling mid-flight), close it
  // with `cancelled: true` so the viz labels it "✕ cancelled" instead of
  // leaving it "● LIVE" forever. If currentRun is null the run already ended
  // (success or error) before teardown — flush any pending partial instead.
  // Idempotent: the failed path tears down before settling, and a later
  // shutdown() from a signal handler must not double-clean.
  let torn = false;
  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    console.log('\nshutting down sandbox children...');
    if (recorder.currentRun !== null) {
      recorder.endRun({
        error: 'run cancelled by user (signal received)',
        cancelled: true,
      });
      // The machine epilogue must survive cancellation: without it the
      // burn-in CSV read this row as outcome 'error' with NULL economics
      // while the trace held the real totals — trace and CSV disagreed
      // about the same run's cost. Same pattern as the watchdog path.
      console.error(formatRunStatsEpilogue(machineRunStats('cancelled', metrics, runSignals)));
    } else {
      recorder.flushPartial();
    }
    try {
      await backend.cleanup();
    } catch (err) {
      // Teardown must still progress so the synchronous Docker exit registry
      // gets its final bounded attempt. Resolving cleanup failures silently
      // would claim resources were gone; awaiting forever would defeat the
      // watchdog.
      console.error(`✖ sandbox cleanup incomplete: ${(err as Error).message}`);
    }
  };

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
  const onWedged =
    opts?.onWedged ??
    (() => {
      // Synchronous exit on purpose: awaiting sandbox.cleanup() here would
      // re-enter the same class of hang the watchdog exists to escape. The
      // sandbox's process-level exit handler SIGKILLs tracked children.
      process.exit(1);
    });
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
    console.error(formatRunStatsEpilogue(machineRunStats('failed', metrics, runSignals)));
    onWedged();
  }, timeoutMs + WATCHDOG_GRACE_MS);

  const settled = (async (): Promise<RunOutcome> => {
    try {
      const result = await handle(task, ctx);
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
      console.log(formatRunStatsEpilogue(machineRunStats('delivered', metrics, runSignals)));
      console.log(
        '\n✓ build finished. Any server the run started is still reachable inside the sandbox.'
      );
      console.log('  Press Ctrl+C when you are done testing.');
      return { outcome: 'delivered' };
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
      console.error(formatRunStatsEpilogue(machineRunStats('failed', metrics, runSignals)));
      console.error(
        `\nrun enregistré dans ${recorder.runsDir} — ouvre le visualiseur pour plus de détails : npm run viz`
      );
      await teardown();
      return { outcome: 'failed' };
    }
  })();

  return { settled, shutdown: teardown };
}

/**
 * Run one task end to end as a CLI process, for any family.
 *
 * The thin shell over `startTask` that owns everything about how the HOST
 * PROCESS ends: config errors exit 2 (before any side effect — pinned by the
 * real-subprocess tests), a failed run exits 1, a delivered run parks forever
 * so any server the run started stays reachable, and SIGINT/SIGTERM tear the
 * run down (trace closed as cancelled when mid-flight) before exiting 0.
 */
export async function runTask(profile: TaskProfile, argv: readonly string[]): Promise<void> {
  let run: RunHandle;
  try {
    run = await startTask(profile, argv);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  process.on('SIGINT', () => void run.shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => void run.shutdown().finally(() => process.exit(0)));
  const { outcome } = await run.settled;
  if (outcome === 'failed') process.exit(1);
  // Keep the process alive until the user hits Ctrl+C so the static server
  // stays reachable; the signal handlers above own the teardown.
  await new Promise(() => {});
}
