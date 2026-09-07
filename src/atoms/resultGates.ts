import type { Result, RunContext, Task } from '../core/types.js';
import { stripLiteralContractBlock } from './prompts.js';
import { NON_JSON_PAYLOAD_SUMMARY_PREFIX } from './json.js';
import { INTERNAL_VALIDATION_FAILED_PREFIX } from './L1Atom.js';
import { DURABLE_HTTP_PORT_LITERAL_RE } from './groundTruth.js';
import {
  PROBE_MANIFEST_FILENAME,
  smokeOkIncludesStyling,
  smokeResultIncludesStyling,
} from '../contracts/probeManifest.js';
import { extractRecordedProbes, recordedProbesFromWitnesses } from '../contracts/witness.js';
import { resultHasSuccessfulToolAction } from '../skills/lifecycle.js';

/**
 * The mechanical RESULT gates, as ONE declarative table.
 *
 * Every gate here was born from a dated live incident (AGENTS.md engineering
 * record / docs/incidents/), and until 2026-08-14 each lived as its own
 * inline `if` inside L2.validateResult with its own tool reads and its own
 * ad-hoc disposition. That accretion held two contradictory safety doctrines
 * in one function: the ground-truth layer's invariant is "a heuristic must
 * never fail a run by itself" (contradictions only FORCE a full LLM verdict),
 * while the newest gates rejected outright, before trust, with no repeat
 * protection — so any false positive repeated byte-identically and tripped
 * the 3-strike repeat tracker into an escalation cascade (the measured $2.03
 * incident that gave the PLAN-side gate its one-shot memo, `types.ts`
 * `mechanicalPlanRejections`).
 *
 * The table makes the disposition an explicit, per-gate decision:
 *
 *  - `reject` — the result ITSELF declares the failure (a transport-observed
 *    zero-action run, a tolerant non-JSON wrapper, an explicit internal
 *    validation failure). Content-independent, false-positive-proof, so an
 *    outright mechanical rejection with coaching is correct and cheap.
 *  - `reject-once` — disk evidence contradicts a requirement extracted from
 *    the task text. The first offense earns ONE coached mechanical rejection
 *    (usually the fastest correct fix); a repeat for the SAME task must not
 *    re-reject byte-identically — it becomes a review finding handed to the
 *    LLM validator with the facts attached. Memoised run-wide on
 *    `ctx.mechanicalResultRejections` (fork-shared, replans included).
 *  - `requires-review` — the TRIGGER is a regex reading of model-authored
 *    prose (the exact input class the ground-truth layer refuses to let
 *    reject on its own). Never rejects: the finding is rendered into a
 *    fact block, the trust fast-path is overridden, and the full LLM verdict
 *    decides with the facts in view — the `checkGroundTruth` architecture.
 *
 * Shared plumbing the table buys: workspace reads are cached per validation
 * cycle (the command-manifest and JSON-shape gates used to read the SAME
 * manifest through two separate tool calls), and a new incident adds a row
 * with a stated disposition instead of a new philosophy.
 */

export type ResultGateDisposition = 'reject' | 'reject-once' | 'requires-review';

export interface ResultGateFinding {
  readonly gateId: string;
  readonly disposition: ResultGateDisposition;
  /** One-sentence statement of the defect — verdict `reasoning` on rejection. */
  readonly reasoning: string;
  /** Actionable retry coaching — `modifications.additionalContext` on rejection. */
  readonly coaching: string;
}

export type WorkspaceRead =
  | { readonly status: 'ok'; readonly content: string }
  | { readonly status: 'unreadable' }
  | { readonly status: 'no-tool' };

export interface ResultGateEnv {
  readonly task: Task;
  readonly result: Result;
  readonly childName: string;
  readonly childToolNames: readonly string[];
  readonly requireObservedToolAction: boolean;
  /**
   * Lazy, per-validation-cycle-cached workspace read. Gates share ONE read
   * per path: the command-manifest and JSON-shape gates both consume the
   * probe manifest, and used to pay two `read_file` calls for it.
   */
  readonly readWorkspaceFile: (path: string) => Promise<WorkspaceRead>;
}

interface ResultGate {
  readonly id: string;
  readonly disposition: ResultGateDisposition;
  /** Envelope failures apply to delegated results as well as leaf results. */
  readonly appliesToDelegatedResult?: boolean;
  readonly check: (
    env: ResultGateEnv
  ) => Promise<Pick<ResultGateFinding, 'reasoning' | 'coaching'> | null>;
}

export interface ResultGateOutcome {
  /** Set when a gate rejects mechanically; the caller returns this verdict. */
  readonly rejection: ResultGateFinding | null;
  /**
   * Findings that must FORCE a full LLM verdict (trust fast-path overridden)
   * with `renderResultGateFindings` attached. Includes `reject-once` repeats.
   */
  readonly reviewFindings: readonly ResultGateFinding[];
}

export function buildResultGateEnv(args: {
  readonly task: Task;
  readonly result: Result;
  readonly childName: string;
  readonly childToolNames: readonly string[];
  readonly ctx: RunContext;
}): ResultGateEnv {
  const cache = new Map<string, WorkspaceRead>();
  const readWorkspaceFile = async (path: string): Promise<WorkspaceRead> => {
    const cached = cache.get(path);
    if (cached) return cached;
    let read: WorkspaceRead;
    if (!args.ctx.tools?.has('read_file')) {
      read = { status: 'no-tool' };
    } else {
      try {
        const raw = await args.ctx.tools.execute('read_file', { path });
        const content =
          raw &&
          typeof raw === 'object' &&
          typeof (raw as Record<string, unknown>)['content'] === 'string'
            ? ((raw as Record<string, unknown>)['content'] as string)
            : typeof raw === 'string'
              ? raw
              : '';
        read = { status: 'ok', content };
      } catch {
        read = { status: 'unreadable' };
      }
    }
    cache.set(path, read);
    return read;
  };
  return {
    task: args.task,
    result: args.result,
    childName: args.childName,
    childToolNames: args.childToolNames,
    requireObservedToolAction: args.ctx.requireObservedToolAction === true,
    readWorkspaceFile,
  };
}

/* ------------------------------------------------------------------ */
/* Gate predicates — exported for direct unit testing and for the      */
/* historical import paths (L2Atom re-exports them).                   */
/* ------------------------------------------------------------------ */

export function webStylingEvidenceMissing(task: Task, result: Result): boolean {
  const phaseDescription = stripLiteralContractBlock(task.description);
  if (!/\b(?:conditional\s+styl|styling|style|class|colou?r)\b/i.test(phaseDescription)) {
    return false;
  }
  if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
    return true;
  }
  const probes = (result.output as Record<string, unknown>)['probes'];
  if (!Array.isArray(probes)) return true;
  let milestoneStyling = false;
  let resetStyling = false;
  for (const probe of probes) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
    const entry = probe as Record<string, unknown>;
    const smoke = typeof entry['smoke'] === 'string' ? entry['smoke'] : '';
    const smokeResult =
      entry['smokeResult'] && typeof entry['smokeResult'] === 'object'
        ? JSON.stringify(entry['smokeResult'])
        : '';
    const hasStyling =
      /(?:class|style|colou?r|getComputedStyle)/i.test(smoke) &&
      smokeResultIncludesStyling(entry['smokeResult']) &&
      smokeOkIncludesStyling(smoke);
    if (!hasStyling) continue;
    const evidenceText = `${smoke}\n${smokeResult}`;
    if (/(?:milestone|afterIncrement|afterClick|streak.?3)/i.test(evidenceText)) {
      milestoneStyling = true;
    }
    if (/(?:reset|final)/i.test(evidenceText)) resetStyling = true;
  }
  return !(milestoneStyling && resetStyling);
}

function expectedJsonContainer(description: string): 'object' | 'array' | null {
  const phaseDescription = stripLiteralContractBlock(description);
  const expectsObject = /\bJSON\s+object\b/i.test(phaseDescription);
  const expectsArray = /\bJSON\s+array\b/i.test(phaseDescription);
  if (expectsObject === expectsArray) return null;
  return expectsObject ? 'object' : 'array';
}

function recordedJsonShapeMismatchFromProbes(
  task: Task,
  probes: readonly unknown[]
): string | null {
  const expected = expectedJsonContainer(task.description);
  if (!expected) return null;
  if (probes.length === 0) return null;

  let observed = 0;
  let matching = 0;
  for (const probe of probes) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
    const entry = probe as Record<string, unknown>;
    if (entry['exitCode'] !== 0 || typeof entry['stdout'] !== 'string') continue;
    const stdout = entry['stdout'].trim();
    if (!stdout) continue;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      observed++;
      const isArray = Array.isArray(parsed);
      const isObject = parsed !== null && typeof parsed === 'object' && !isArray;
      if ((expected === 'object' && isObject) || (expected === 'array' && isArray)) {
        matching++;
      }
    } catch {
      // Non-JSON stdout is silent here; the normal validator decides whether
      // mixed/logged output satisfies the task.
    }
  }
  if (observed === 0 || matching > 0) return null;
  return expected === 'object'
    ? 'the task requires JSON object output, but every parseable successful probe returned a JSON array'
    : 'the task requires JSON array output, but every parseable successful probe returned a JSON object';
}

function resultRecordedProbes(result: Result): unknown[] {
  return [
    ...extractRecordedProbes({ output: result.output }),
    ...recordedProbesFromWitnesses(result.evidence),
  ];
}

export function recordedJsonShapeMismatch(task: Task, result: Result): string | null {
  return recordedJsonShapeMismatchFromProbes(task, resultRecordedProbes(result));
}

export function requiredPassingCommands(description: string): string[] {
  const phaseDescription = stripLiteralContractBlock(description);
  const commands = [
    ...phaseDescription.matchAll(
      /\bnode\s+((?:[\w.-]+\/)*(?:(?:test|probe|verify|check|harness)[\w.-]*|[\w.-]+-(?:test|probe|verify|check|harness))\.(?:m?js|cjs))\b/gi
    ),
  ].map((match) => `node ${match[1]}`);
  return [...new Set(commands)];
}

export function requiredCommandManifestMismatch(
  taskDescription: string,
  manifestRaw: string
): string | null {
  const commands = requiredPassingCommands(taskDescription);
  if (commands.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return null; // Manifest health reports malformed JSON separately.
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = (parsed as Record<string, unknown>)['entries'];
  if (!Array.isArray(entries)) return null;
  for (const command of commands) {
    const matching = entries.filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>)['cmd'] === command
    ) as Array<Record<string, unknown>>;
    const latest = matching.at(-1);
    if (!latest) {
      return `the task requires ${command} to pass, but the probe manifest has no entry for that exact command`;
    }
    if (latest['exitCode'] !== 0) {
      return `the task requires ${command} to pass, but its latest recorded exit code is ${JSON.stringify(latest['exitCode'])}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

const COMMAND_MANIFEST_COACHING =
  'Fix the exact required finite test/probe script instead of substituting a different harness. Run it through record_probe until that same command exits 0; its manifest entry must be replaced with the successful observation before returning.';

const RESULT_GATES: readonly ResultGate[] = [
  {
    // Transport witness: the run's own tool observer saw zero successful
    // actions. Content-independent — the fifth-iteration fix for a weak L1
    // fabricating a CLI with no tool calls.
    id: 'observed-tool-action',
    disposition: 'reject',
    check: (env) => {
      if (!env.requireObservedToolAction) return Promise.resolve(null);
      if (env.result.toolCallResults === undefined) return Promise.resolve(null);
      if (resultHasSuccessfulToolAction(env.result)) return Promise.resolve(null);
      return Promise.resolve({
        reasoning:
          'the L1 result was produced without any successful tool action observed by the transport, so its file/execution claims are unsupported narrative',
        coaching:
          'No successful tool action was observed. Actually perform the subtask with your declared tools, verify the artefact, and only then return the result JSON. Do not describe intended work as completed.',
      });
    },
  },
  {
    // The task names a finite harness (`node test-api.js`); the manifest must
    // hold a passing entry for that EXACT command (thirty-first iteration:
    // substituted harnesses shipped a failing `node test-api.js`).
    id: 'required-command-manifest',
    disposition: 'reject-once',
    check: async (env) => {
      const commands = requiredPassingCommands(env.task.description);
      if (commands.length === 0) return null;
      const read = await env.readWorkspaceFile(PROBE_MANIFEST_FILENAME);
      if (read.status === 'no-tool') return null;
      if (read.status === 'unreadable') {
        return {
          reasoning: `the task requires ${commands.join(', ')} to pass, but the probe manifest could not be read`,
          coaching: COMMAND_MANIFEST_COACHING,
        };
      }
      if (!read.content.trim()) {
        return {
          reasoning: `the task requires ${commands.join(', ')} to pass, but the probe manifest is missing or empty`,
          coaching: COMMAND_MANIFEST_COACHING,
        };
      }
      const mismatch = requiredCommandManifestMismatch(env.task.description, read.content);
      return mismatch ? { reasoning: mismatch, coaching: COMMAND_MANIFEST_COACHING } : null;
    },
  },
  {
    // Portable docs: a README the task requires to stay port-agnostic must
    // not embed a live numeric loopback port (thirty-third iteration).
    id: 'portable-http-docs',
    disposition: 'reject-once',
    check: async (env) => {
      const phaseDescription = stripLiteralContractBlock(env.task.description);
      if (
        !/\bREADME\.md\b/i.test(phaseDescription) ||
        !/(?:<port>|portable|never[^.\n]{0,80}numeric port)/i.test(phaseDescription)
      ) {
        return null;
      }
      const read = await env.readWorkspaceFile('README.md');
      if (read.status === 'no-tool') return null;
      const coaching =
        'Replace every durable numeric localhost port and LISTENING_ON_PORT number in README.md with <port>. Keep live numeric URLs only in run evidence, then read README.md back before returning.';
      if (read.status === 'unreadable') {
        return {
          reasoning:
            'the task requires portable HTTP documentation in README.md, but README.md could not be read',
          coaching,
        };
      }
      return DURABLE_HTTP_PORT_LITERAL_RE.test(read.content)
        ? {
            reasoning:
              'the task requires portable README.md port placeholders, but README.md contains a numeric loopback URL or LISTENING_ON_PORT value',
            coaching,
          }
        : null;
    },
  },
  {
    // The result itself says it never produced the final JSON envelope.
    id: 'non-json-envelope',
    disposition: 'reject',
    appliesToDelegatedResult: true,
    check: (env) =>
      Promise.resolve(
        env.result.summary.startsWith(NON_JSON_PAYLOAD_SUMMARY_PREFIX)
          ? {
              reasoning:
                'the executor did not emit the required final {"output","summary"} JSON envelope',
              coaching:
                'Your tool work may already be complete. Do not call a return/output tool and do not narrate the result as prose. Emit one final JSON object directly as assistant text: {"output": <actual result>, "summary": "<evidence-backed summary>"}.',
            }
          : null
      ),
  },
  {
    // The result itself reports its final browser validation failed.
    id: 'internal-validation-failed',
    disposition: 'reject',
    appliesToDelegatedResult: true,
    check: (env) =>
      Promise.resolve(
        env.result.summary.startsWith(INTERNAL_VALIDATION_FAILED_PREFIX)
          ? {
              reasoning:
                'the result explicitly reports that its final validate_html call failed',
              coaching:
                'Your last validate_html result was not ok. Read its exact errors/smokeResult, fix the artefact or the assertion, and re-run validation until ok:true before returning the final JSON.',
            }
          : null
      ),
  },
  {
    // Prose-triggered (the "JSON object/array" wording is a regex read of the
    // task text), so it never rejects alone: the finding forces a full LLM
    // verdict with the facts attached (twenty-sixth iteration, downgraded per
    // the 2026-08-14 review — a false trigger becomes one cheap validator
    // call instead of a deterministic rejection cascade).
    id: 'recorded-json-shape',
    disposition: 'requires-review',
    check: async (env) => {
      const probes = resultRecordedProbes(env.result);
      const coaching =
        'The successful recorded stdout has the wrong JSON container shape. Preserve the verified values and ordering, but emit exactly the requested JSON object or JSON array, then re-run every success probe and return their new real stdout.';
      const inlineMismatch = recordedJsonShapeMismatchFromProbes(env.task, probes);
      if (inlineMismatch) return { reasoning: inlineMismatch, coaching };
      if (expectedJsonContainer(env.task.description) === null) return null;
      const read = await env.readWorkspaceFile(PROBE_MANIFEST_FILENAME);
      if (read.status !== 'ok' || !read.content.trim()) return null;
      try {
        const parsed = JSON.parse(read.content) as unknown;
        const entries =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)['entries']
            : undefined;
        if (Array.isArray(entries)) probes.push(...entries);
      } catch {
        // Missing/malformed manifests are handled by the ground-truth health
        // checker. Shape mismatch stays silent without parseable evidence.
        return null;
      }
      const mismatch = recordedJsonShapeMismatchFromProbes(env.task, probes);
      return mismatch ? { reasoning: mismatch, coaching } : null;
    },
  },
  {
    // Prose-triggered (`styling|style|class|colour` over task text — the
    // trigger fires on "implement a Counter class"), so it never rejects
    // alone either (fifteenth/seventeenth iterations, downgraded per the
    // 2026-08-14 review).
    id: 'web-styling-evidence',
    disposition: 'requires-review',
    check: (env) => {
      if (!env.childToolNames.includes('validate_html')) return Promise.resolve(null);
      if (!webStylingEvidenceMissing(env.task, env.result)) return Promise.resolve(null);
      return Promise.resolve({
        reasoning:
          'the task requires conditional styling, but the recorded browser probe contains no class/style/color milestone evidence',
        coaching:
          'Return milestone and reset snapshots containing the actual class/style/color values, and make ok assert the expected transition. State counters or labels alone do not verify conditional styling.',
      });
    },
  },
];

/** Stable order, exported for the pipeline test that pins it. */
export const RESULT_GATE_IDS: readonly string[] = RESULT_GATES.map((g) => g.id);

export async function runResultGates(
  env: ResultGateEnv,
  memo?: Set<string>,
  scope: 'leaf' | 'delegated' = 'leaf'
): Promise<ResultGateOutcome> {
  const reviewFindings: ResultGateFinding[] = [];
  for (const gate of RESULT_GATES) {
    if (scope === 'delegated' && !gate.appliesToDelegatedResult) continue;
    const hit = await gate.check(env);
    if (!hit) continue;
    const finding: ResultGateFinding = { gateId: gate.id, disposition: gate.disposition, ...hit };
    if (gate.disposition === 'reject') {
      return { rejection: finding, reviewFindings };
    }
    if (gate.disposition === 'reject-once') {
      const key = `${gate.id}|${env.task.description}`;
      if (memo?.has(key)) {
        // A byte-identical mechanical rejection repeated against the same
        // task must not trip the repeat tracker — hand the facts to the LLM.
        reviewFindings.push(finding);
        continue;
      }
      memo?.add(key);
      return { rejection: finding, reviewFindings };
    }
    reviewFindings.push(finding);
  }
  return { rejection: null, reviewFindings };
}

/**
 * Render review findings for the validator. The framing matters: these are
 * heuristic signals over model prose, so the block instructs the validator to
 * verify rather than obey — the same contract as the ground-truth evidence
 * block ("reject ONLY on a contradiction").
 */
export function renderResultGateFindings(findings: readonly ResultGateFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map(
    (f) => `- [${f.gateId}] ${f.reasoning}\n  Expected compliant evidence: ${f.coaching}`
  );
  return [
    '== MECHANICAL GATE FINDINGS ==',
    'Automated checks raised the finding(s) below. They are heuristic readings',
    'of the task text and recorded evidence — treat them as leads to VERIFY,',
    'not verdicts to obey. Reject only when the payload/evidence confirms the',
    'finding; approve when the evidence shows the requirement is actually met',
    'or the trigger misread the task.',
    ...lines,
    '== END MECHANICAL GATE FINDINGS ==',
  ].join('\n');
}
