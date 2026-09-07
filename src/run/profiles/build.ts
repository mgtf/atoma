import { SMOKE_DESIGN_GUIDANCE } from '../../atoms/prompts.js';
import {
  ensureCanonicalL1,
  ensureCanonicalL2,
  ensureCanonicalHttpL1,
  ensureCanonicalHttpL2,
  ensureCanonicalFileScribeL1,
} from '../../atoms/capability.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace } from '../workspace.js';
import { DEFAULT_DB_PATH } from '../../core/stores.js';
import type { AtomType } from '../../registry/atomRegistry.js';
import type { Task } from '../../core/types.js';
import type { ProfileSeedContext, TaskProfile } from '../profile.js';

/**
 * Where build runs get their scratch directory.
 *
 * Under the user's home rather than the repo, and STABLE across runs rather
 * than a fresh temp dir: the workspace holds the deliverable, and a human
 * inspects it after the run finishes (`prepareWorkspace` archives by rename
 * for the same reason — a wrong call must stay recoverable). An OS tmpdir
 * would be swept out from under that.
 *
 * Overridable with ATOMA_BUILD_WORKSPACE, which the burn-in harness does not
 * set — so batches share one workspace and rely on `--clean-workspace`,
 * exactly as before the move.
 */
export function defaultWorkspaceRoot(): string {
  return join(homedir(), '.atoma', 'workspaces', 'build');
}

/**
 * The tier-3 seed prompt for the build family.
 *
 * ARTEFACT-NEUTRAL on purpose: earlier revisions said "Prefer a single
 * index.html when possible" and "the final output must include the exact URL
 * from start_static_server" — a web bias baked into the PERSISTED L3 prompt
 * that pressured every plan toward the serve+validate pattern regardless of
 * the task's nature.
 *
 * DO NOT EDIT CASUALLY. `seedL3` refreshes the persisted prompt whenever this
 * constant changes, and `AtomRegistry.patch` ZEROES the trust counters — so a
 * one-character change here is the first tier-3 patch in the project's
 * history and costs Meristem its record. `tests/run-profile-build.test.ts` pins
 * the exact text against what is persisted in the live store.
 */
export const MERISTEM_SYSTEM_PROMPT = [
  'You are Meristem, a top-level tissue that builds real apps end-to-end.',
  'DELEGATION DISCIPLINE: you NEVER invoke elements yourself. You choose an L2 cell (reuse or create) and hand the task over. The L2 will in turn route a focused leaf task to an L1 molecule; L1 is the ONLY agent tier that invokes elements to write files, run shell commands, start servers and validate artefacts. This hierarchy keeps LLM cost low — do not try to do the work from here.',
  'Produce runnable, self-contained artefacts shaped by the task itself: a single index.html for browser pages, a Node entry file for HTTP servers/APIs, plain script/config/doc files for CLI and file deliverables. Never impose one artefact shape on a task of a different nature.',
  'The final output you return must state how the deliverable was verified (which probe ran and its result) and give its entry point: the served URL when a server is part of the deliverable, otherwise the main file path plus the command that runs it.',
].join('\n');

/** Persisted description of the build family's tier-3 tissue. Same edit caution. */
export const MERISTEM_DESCRIPTION =
  'A top-level tissue that orchestrates real application builds by delegating strategy to L2 cells; concrete side-effects happen only in L1 molecules.';

/**
 * Task constraints for the build family.
 *
 * ARTEFACT-NEUTRAL on purpose. The original wording hardcoded the web pattern
 * ("start_static_server ... validate_html ...") for every task — written for
 * the Minesweeper demo, it forced a serve+validate phase onto non-web
 * deliverables. Observed on the greet-cli live run: L3's prefilter flagged the
 * constraints as "fundamentally incompatible" with a CLI task, then dutifully
 * planned a phase 2 that served a directory listing just to satisfy them, and
 * the learn path distilled that workaround into a junk skill. The
 * verification-method choice belongs to the plan prompts' "VERIFICATION
 * MATCHES THE ARTEFACT" rule, not to the harness.
 */
export const BUILD_TASK_CONSTRAINTS: readonly string[] = [
  'The L1 worker must actually create the files on disk via the write_file tool.',
  'The deliverable must be VERIFIED with the probe matching its nature: ' +
    'static browser pages via start_static_server + validate_html; pages backed by a Node API ' +
    'via start_node_server + fetch_url + validate_html against the SAME Node server, iterating ' +
    '(read + rewrite) until zero console.error messages and zero failed requests; ' +
    'HTTP servers/APIs via start_node_server + fetch_url probes; ' +
    'CLI tools, scripts and configs via run_shell executing the artefact and checking its output.',
  'Keep the implementation small and self-contained.',
];

/**
 * The build family: produce a runnable artefact on disk and verify it with
 * the probe matching its nature. Every one of the 146 burn-in rows to date
 * belongs to this family.
 */
export const buildProfile: TaskProfile = {
  id: 'build',
  traceLabelPrefix: 'build-app: ',
  defaultGoal:
    'Build a minimal WebGL Minesweeper game (10x10 grid, 10 mines). Implement everything in a single index.html that loads and runs standalone. Left-click reveals a cell, right-click flags. Then start a local static server and return the URL.',
  envVars: {
    // THE STORE IS NOT PER-FAMILY, so its env var is not either. This said
    // `ATOMA_BUILD_DB_PATH` while every CLI read `ATOMA_DB_PATH`, and the
    // mismatch is what grew four different `existsSync('./atoma-build.db')`
    // probes across the CLIs and the viz. The workspace and the budget DO
    // stay per-family: those genuinely differ between task families, a
    // catalog of atom types and skills deliberately does not (see
    // `resolveCreationDescription`, which strips task themes precisely so a
    // type earns reuse outside the family that spawned it).
    dbPath: 'ATOMA_DB_PATH',
    workspace: 'ATOMA_BUILD_WORKSPACE',
    timeoutMs: 'ATOMA_BUILD_TIMEOUT_MS',
  },
  defaults: {
    dbPath: DEFAULT_DB_PATH,
    // OUTSIDE THE REPO, deliberately. The workspace used to be `./build/app`,
    // two `..` hops below the atom registry, every skill body, the ledger and
    // the user's own uncommitted git work — and `run_shell`'s child is NOT
    // jailed to the workspace, it merely starts there (`builtin.ts` spawns
    // with `cwd`, nothing more). REPRODUCED: `ls ../../atoma-build.db
    // ../../skills` from a sandbox listed the registry and every learned
    // recipe.
    //
    // This is a BLAST-RADIUS REDUCTION, NOT A BOUNDARY, and the distinction
    // matters: an absolute path still reaches anything the user can read.
    // What it buys is that the casual traversal — a model running `ls ..` to
    // orient itself, or a stray `rm -rf ..` in generated cleanup code — now
    // lands in a scratch tree instead of the repository. A real boundary is
    // an OS one (container/VM) and belongs to deployment; see
    // docs/saas-architecture.md §3 and invariant T1. Do not describe this
    // line as isolation.
    //
    // It also removes the CAUSE of the ESM module-resolution leak rather
    // than compensating for it: the workspace no longer sits under a
    // package.json saying `"type": "module"`, so
    // `ensureModuleResolutionBoundary` goes inert here (it stays, and still
    // fires, for anyone who points the workspace back inside a module repo).
    workspace: defaultWorkspaceRoot(),
  },

  // Every line here reflects something this repo MEASURED, not generic
  // prompt advice. "Do not name tools": ae63e06 forbids naming tools in
  // subtask descriptions after 194/237 archived subtasks did it, and the
  // clock-cli run wasted half its calls on a serve+validate phase the goal
  // had implied. "Self-contained": the curriculum generator carries the same
  // MANDATORY rule — the workspace starts empty, so a goal referring to data
  // that is not created by the run has nothing to work against. "Say the
  // shape": the three artefact shapes are exactly the ones the plan prompt's
  // VERIFICATION MATCHES THE ARTEFACT block knows how to probe.
  guidance: {
    label: 'Build an app',
    help:
      'Describe ONE runnable artefact and the behaviour it must have. Say which shape it takes — '
      + 'a single index.html page, a Node HTTP server, or a CLI script / config / doc file — then the '
      + 'concrete behaviour and any hard constraint (grid size, routes and status codes, argv and exit '
      + 'codes). Keep it small and self-contained: the workspace starts empty, so everything the run '
      + 'needs must be something it can create. Do NOT name tools, phases or verification steps — the '
      + 'planner chooses those from the artefact\'s nature, and spelling them out is a measured source '
      + 'of wasted phases. Verification is automatic and matches the shape: a page gets loaded in a '
      + 'headless browser, a server gets real requests, a CLI gets really invoked.',
    examples: [
      'Build a single-page pomodoro timer in one index.html: 25/5 minute cycles, start/pause/reset buttons, a visible countdown and a completed-cycle counter.',
      'Build a Node HTTP JSON API for a bookmarks list: GET /bookmarks, POST /bookmarks taking url and title (400 when a field is missing), DELETE /bookmarks/:id returning 404 for an unknown id.',
      'Build a Node CLI taking a CSV file path as its argument and printing per-column min, max and mean, exiting non-zero with a usage message when the path is missing or unreadable.',
    ],
  },

  prepareWorkspace(root: string, clean: boolean): void {
    prepareWorkspace(root, clean);
  },

  seedL3({ registry, toolDecls, log }: ProfileSeedContext): AtomType {
    let l3Type = registry.listByTier(3).find((t) => t.name === 'Meristem');
    if (!l3Type) {
      l3Type = registry.create(3, {
        description: MERISTEM_DESCRIPTION,
        systemPrompt: MERISTEM_SYSTEM_PROMPT,
        tools: [...toolDecls],
        params: { maxTokens: 16384 },
        createdBy: 'user',
      });
      log(`bootstrapped L3 tissue: ${l3Type.name}`);
    } else {
      // Always refresh the tools (executor set may have changed across
      // runs) and re-align the system prompt with the current seed.
      l3Type = registry.patch(
        l3Type.name,
        {
          addTools: [...toolDecls],
          ...(l3Type.systemPrompt !== MERISTEM_SYSTEM_PROMPT
            ? { systemPromptReplace: MERISTEM_SYSTEM_PROMPT }
            : {}),
        },
        'build-app',
        'refresh system tools + seed prompt'
      );
      log(`reusing L3 tissue: ${l3Type.name} (v${l3Type.version})`);
    }
    return l3Type;
  },

  seedCatalog({ registry, toolDecls, log }: ProfileSeedContext): void {
    // Bootstrap canonical L2 + L1 catalog entries. These are capability-
    // focused, domain-neutral atoms seeded so L3/L2 prefilter has a clean
    // reusable target on every run — without them the first build on a
    // fresh registry spawns a bespoke (and usually theme-poisoned) clone
    // of the same "single-file web artefact" recipe we already know how
    // to execute. Idempotent: we match by the `CANONICAL_BOOTSTRAP_MARKER`
    // in `createdBy`, refreshing tools on each run so the canonical
    // catalog follows the current executor set.
    const canonicalL2Web = ensureCanonicalL2(registry, toolDecls);
    log(
      `canonical L2 (web): ${canonicalL2Web.name} (v${canonicalL2Web.version}) — ${canonicalL2Web.description.slice(0, 70)}…`
    );
    const canonicalL2Http = ensureCanonicalHttpL2(registry, toolDecls);
    log(
      `canonical L2 (http): ${canonicalL2Http.name} (v${canonicalL2Http.version}) — ${canonicalL2Http.description.slice(0, 70)}…`
    );
    const canonicalL1Web = ensureCanonicalL1(registry, toolDecls, SMOKE_DESIGN_GUIDANCE);
    log(
      `canonical L1 (web): ${canonicalL1Web.name} (v${canonicalL1Web.version}) — ${canonicalL1Web.description.slice(0, 70)}…`
    );
    const canonicalL1Http = ensureCanonicalHttpL1(registry, toolDecls);
    log(
      `canonical L1 (http): ${canonicalL1Http.name} (v${canonicalL1Http.version}) — ${canonicalL1Http.description.slice(0, 70)}…`
    );
    const canonicalL1FileScribe = ensureCanonicalFileScribeL1(registry, toolDecls);
    log(
      `canonical L1 (file-scribe): ${canonicalL1FileScribe.name} (v${canonicalL1FileScribe.version}) — ${canonicalL1FileScribe.description.slice(0, 70)}…`
    );
  },

  buildTask(goal: string): Task {
    return { description: goal, constraints: [...BUILD_TASK_CONSTRAINTS] };
  },
};
