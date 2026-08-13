/**
 * atoma as an MCP server over STDIO.
 *
 * WHAT IT IS FOR: it lets an MCP host — Claude Code, or anything else speaking
 * the protocol — start a task run through the tiered pipeline and read atoma's
 * accumulated state (agent types and their earned trust, skills and their
 * lifecycle, the ledger's integrity projection, run traces, the friction
 * report). The host pays one tool call; atoma does the tiering.
 *
 * WHY STDIO, AND WHY THAT IS THE WHOLE SAFETY ARGUMENT: AGENTS.md's viz
 * "Launch tab" entry records why there is no launch BUTTON in the visualiser —
 * every requirement it lists (a secret that never touches HTTP, a global Host
 * allowlist ahead of every branch, an exact-Origin check with the port, the
 * DNS-rebinding surface) exists because the viz listens on a PORT THE RUN
 * ITSELF CAN REACH: `fetch_url` has no URL allowlist by design, and
 * `run_shell`'s allowlist is documented as STEERING, not a boundary. So the
 * adversary is not a remote page, it is the run. A stdio server has no socket
 * the run was ever handed, which dissolves that entire threat model rather
 * than mitigating it. THE COROLLARY IS A RULE: do not add an HTTP transport,
 * a debug endpoint or a metrics port to this file. Any of them re-opens the
 * exact hole, and the reasoning above stops applying.
 *
 * STDOUT IS THE PROTOCOL. The transport frames JSON-RPC on stdout and the
 * peer's reader THROWS on a non-JSON line — stricter than atoma's own
 * container protocol, which deliberately drops unparseable lines. Purity here
 * is therefore STRUCTURAL, not disciplinary: the transport is handed the real
 * stdout write captured before anything else runs, and `process.stdout.write`
 * is then redirected to stderr, so every `console.log` in this repo and in
 * every dependency becomes harmless. The same rule is already written down in
 * `src/tools/worker.ts` for the container worker, and it is why a run must be
 * a CHILD PROCESS — see `src/mcp/run.ts` for the four independent blockers.
 */

import type { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RUN_KILL_GRACE_MS } from '../cli/burnin.js';
import {
  families,
  friction,
  ledgerCheck,
  registryList,
  registryShow,
  runTrace,
  runsList,
  skillsList,
  skillsReview,
  skillsStats,
} from './readers.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  RunRejected,
  cancelRun,
  forceKillActiveRunAfterGrace,
  repoRoot,
  runStatus,
  signalActiveRunOnExit,
  shutdownRuns,
  startRun,
} from './run.js';

/** Wrap any reader payload in the tool-result shape this SDK expects. */
function jsonResult(payload: unknown): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Reader tools all share these annotations: nothing they do can change state. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Server-level usage guidance. Exported so a test can hold it to the same rule
 * `tests/viz-launch-profiles.test.ts` holds the viz Launch guidance to: never
 * teach a caller to NAME A BUILTIN TOOL in a goal. Commit ae63e06 removed
 * exactly that from subtask descriptions after 194 of 237 archived subtasks
 * did it and one run burned half its calls on a phase the wording had implied;
 * teaching it one level up, in the human's own words, would reintroduce it.
 */
export const INSTRUCTIONS = `atoma is a three-tier LLM agent orchestration framework: a tier-3 tissue decomposes a
goal, tier-2 cells supervise, and only tier-1 molecules invoke elemental tools and touch the filesystem. Cheap
models do the cheap work, and agent types plus skill recipes accumulate earned trust across runs, so
repeat work gets cheaper.

Starting a run is DESTRUCTIVE and SERIALISED. One run happens at a time; by default the shared build
workspace is archived first, and a run mutates the agent registry, the skill store and the lifecycle
ledger, and spends model quota. Runs take minutes: call atoma_run_start, then poll atoma_run_status,
and use atoma_run_cancel to stop one.

Everything else here is a pure reader over the persisted state. Two payloads carry caveats you should
repeat rather than paraphrase: atoma_skills_review is a MECHANICAL pre-screen and never a sharing
approval, and atoma_skills_stats statuses depend on the trust/promote thresholds in force at call
time, which the payload echoes.

Call atoma_families first if you need to know how to phrase a goal.`;

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'atoma', version: packageVersion() },
    { instructions: INSTRUCTIONS }
  );

  /* ------------------------------------------------------------- families */

  server.registerTool(
    'atoma_families',
    {
      title: 'List task families',
      description:
        'The task families a run can target, each with guidance on how to phrase a goal and example goals. Call this before atoma_run_start if you are unsure how to word a goal.',
      annotations: READ_ONLY,
    },
    () => jsonResult(families())
  );

  /* ------------------------------------------------------------------ run */

  const familyHelp = families()
    .families.map((f) => `"${f.id}" (${f.label})`)
    .join(', ');

  server.registerTool(
    'atoma_run_start',
    {
      title: 'Start a task run',
      description:
        `Start a run through atoma's tiered pipeline and return immediately with a runId — a run takes minutes, so poll atoma_run_status. Families: ${familyHelp}.\n\n` +
        'DESTRUCTIVE: by default the shared build workspace is ARCHIVED before the run starts (pass keepWorkspace to keep it), and the run mutates the agent registry, the skill store and the lifecycle ledger, and spends model quota. ' +
        'SERIALISED: only one run at a time — a second call is refused while one is in flight, because the workspace is shared and concurrent runs make the cost numbers incomparable. ' +
        'The goal is prose describing the artefact you want; do not name tools in it.',
      inputSchema: {
        goal: z
          .string()
          .min(1)
          .describe('What to build, in prose. Must not start with "--".'),
        family: z.string().optional().describe('Task family id. Defaults to "build".'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Run budget in ms. Defaults to ${DEFAULT_RUN_TIMEOUT_MS}.`),
        keepWorkspace: z
          .boolean()
          .optional()
          .describe('Do NOT archive the existing workspace first. Default false.'),
        learnSkills: z
          .boolean()
          .optional()
          .describe('Distil a new skill recipe on a novel success. Default true.'),
        promoteSkills: z
          .boolean()
          .optional()
          .describe('Compile a trusted recipe into a deterministic script. Default true.'),
        directSkills: z
          .boolean()
          .optional()
          .describe('Allow zero-LLM dispatch of a trusted compiled script. Default true.'),
        container: z
          .boolean()
          .optional()
          .describe('Run tools inside a Docker worker (needs the atoma-worker image). Default false.'),
        egress: z
          .boolean()
          .optional()
          .describe('Allow proxied network egress from the container. Implies container. Default false.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return jsonResult(await startRun(args));
      } catch (err) {
        if (err instanceof RunRejected) return errorResult(`refused: ${err.message}`);
        throw err;
      }
    }
  );

  server.registerTool(
    'atoma_run_status',
    {
      title: 'Run status and economics',
      description:
        'Status of one run (pass runId) or of every run this server started. A finished run carries its economics as parsed from its own log: outcome, cost, LLM calls per model tier, deterministic phases, learned skills, promotions, demotions, plus the trace filename to open in the visualiser.',
      inputSchema: { runId: z.string().optional().describe('Omit to list every run.') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(runStatus(args))
  );

  server.registerTool(
    'atoma_run_cancel',
    {
      title: 'Cancel a run',
      description:
        'Stop a run. SIGTERM goes to its whole process group with a 5s grace window before SIGKILL, so the run closes its trace and its headless browser reaps its own helpers. Omit runId to cancel the run in flight.',
      inputSchema: { runId: z.string().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => jsonResult(cancelRun(args))
  );

  /* ------------------------------------------------------------- registry */

  server.registerTool(
    'atoma_registry_list',
    {
      title: 'List agent types',
      description:
        'Persisted molecules, cells and tissues with their earned trust counters and elemental tool metadata. A type with 3+ successes and zero failures is TRUSTED, which lets its supervisor skip LLM validation — that fast-path is one of the two mechanisms behind atoma’s cost curve.',
      inputSchema: { tier: z.number().int().min(1).max(3).optional().describe('1, 2 or 3.') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(registryList({ tier: args.tier as 1 | 2 | 3 | undefined }))
  );

  server.registerTool(
    'atoma_registry_show',
    {
      title: 'Show one agent type',
      description:
        'One molecule, cell or tissue in full, plus its version history (who patched it, when, why). Note that a patch RESETS trust: a changed type has to earn it again.',
      inputSchema: { name: z.string().min(1).describe('Agent type name, e.g. "Water".') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(registryShow(args))
  );

  /* --------------------------------------------------------------- skills */

  server.registerTool(
    'atoma_skills_list',
    {
      title: 'List skills',
      description:
        'Skill recipes per tier-1 molecule, with kind (llm recipe or compiled script), counters and any promotion-refusal stamp.',
      inputSchema: { l1: z.string().optional().describe('Restrict to one molecule namespace.') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(skillsList(args))
  );

  server.registerTool(
    'atoma_skills_stats',
    {
      title: 'Skill utility view',
      description:
        'Per-skill matches vs runs actually driven, the free-ride gap (matched but credit withheld by the adherence gate), a lifecycle status, and merge candidates by description overlap. The payload echoes the trust/promote thresholds in force, because statuses are computed from environment values read at call time — reading these numbers without them has misled a benchmark round before.',
      inputSchema: {
        l1: z.string().optional().describe('Restrict to one molecule namespace.'),
        sim: z.number().min(0).max(1).optional().describe('Merge-candidate similarity threshold. Default 0.5.'),
      },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(skillsStats(args))
  );

  server.registerTool(
    'atoma_skills_review',
    {
      title: 'Skill shareability pre-screen',
      description:
        'MECHANICAL pre-screen for cross-organisation sharing: leaked literals from the originating run, tool names the owning molecule cannot declare, and a static scan of script bodies. IT IS NOT THE REVIEW GATE — a clean verdict only means a human reviewer’s time will not be wasted. Report its caveat verbatim.',
      inputSchema: { l1: z.string().optional().describe('Restrict to one molecule namespace.') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(skillsReview(args))
  );

  /* --------------------------------------------------------------- ledger */

  server.registerTool(
    'atoma_ledger_check',
    {
      title: 'Ledger integrity check',
      description:
        'Project the lifecycle ledger onto the stored counters and report drift. store > ledger is EXPECTED for entities predating the ledger; store < ledger is IMPOSSIBLE and means a write path bypassed the storage choke points.',
      annotations: READ_ONLY,
    },
    () => jsonResult(ledgerCheck())
  );

  /* ----------------------------------------------------------------- runs */

  server.registerTool(
    'atoma_runs_list',
    {
      title: 'List persisted run traces',
      description: 'Newest run traces with their totals. Use atoma_run_trace for one run’s event shape.',
      inputSchema: { last: z.number().int().positive().optional().describe('How many newest traces. Default 20.') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(runsList(args))
  );

  server.registerTool(
    'atoma_run_trace',
    {
      title: 'Show one run trace',
      description:
        'The event SHAPE of one trace — tiers, roles, models, tools, guard decisions — plus its totals. Event payloads (prompts, responses, tool results) are omitted on purpose: they are megabytes of model-authored text. Read those in the visualiser (npm run viz).',
      inputSchema: { file: z.string().min(1).describe('Trace filename from atoma_runs_list, e.g. "2026-08-11T10-00-00.json".') },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(runTrace(args))
  );

  server.registerTool(
    'atoma_friction',
    {
      title: 'Tool-loop friction report',
      description:
        'Recurring tool-loop failure signatures across recent traces — the friction that is invisible to the learning machinery because the run recovered from it in-loop. The payload carries the action rule: act only on a signature recurring across two consecutive batches whose root cause lives inside the sandbox.',
      inputSchema: {
        last: z.number().int().positive().optional().describe('How many newest traces to scan. Default 20.'),
        tier: z.enum(['hard', 'soft', 'all']).optional().describe('hard = the executor threw. Default all.'),
      },
      annotations: READ_ONLY,
    },
    (args) => jsonResult(friction(args))
  );

  return server;
}

export function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json has no version');
  }
  return parsed.version;
}

/** Boot after `stdio.ts` has already claimed stdout for the protocol. */
export async function boot(protocolOut: Writable): Promise<void> {
  // Work from the repo root whatever cwd the host launched us in. This is what
  // makes `storeDbPath()` / `skillsDirPath()` / `./runs` resolve to the SAME
  // store the child run will use, without this file growing a second copy of
  // the path rules — four divergent copies of that rule WAS the bug once.
  process.chdir(repoRoot());
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // `spawnRun` should settle after its SIGTERM→SIGKILL sequence. This timer
    // is the server-side backstop if the driver promise itself wedges.
    const forceTimer = setTimeout(() => {
      forceKillActiveRunAfterGrace();
      process.exit(code);
    }, RUN_KILL_GRACE_MS + 1000);
    void shutdownRuns(reason).finally(() => {
      clearTimeout(forceTimer);
      process.exit(code);
    });
  };
  process.once('SIGINT', () => shutdown('MCP server received SIGINT'));
  process.once('SIGTERM', () => shutdown('MCP server received SIGTERM'));
  process.once('SIGHUP', () => shutdown('MCP server received SIGHUP'));
  process.stdin.once('end', () => shutdown('MCP stdio input ended'));
  process.stdin.once('close', () => shutdown('MCP stdio input closed'));
  // A generic exit gets SIGTERM only — no uncatchable SIGKILL before Chrome
  // can reap its helpers. The stale lease lets the next server escalate.
  process.once('exit', signalActiveRunOnExit);

  const server = buildServer();
  server.server.onclose = () => shutdown('MCP transport closed');
  await server.connect(new StdioServerTransport(process.stdin, protocolOut));
  process.stderr.write(`[atoma-mcp] ready on stdio · repo ${process.cwd()}\n`);
}
