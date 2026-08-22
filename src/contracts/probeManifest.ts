import { z } from 'zod';
import { Script } from 'node:vm';

/**
 * PROBE MANIFEST — THE machine-readable verification interface.
 * =============================================================
 * This module is the SINGLE SOURCE OF TRUTH for the on-disk probe manifest
 * (`.atoma-probes.json`): the zod schemas define the three entry shapes,
 * the prompt blocks that teach L1s to WRITE the manifest are generated
 * from schema-validated example objects, the compile-prompt block that
 * teaches compiled scripts to READ it is generated from the same examples,
 * and `validateProbeManifest` (the health check the read-back probe runs)
 * checks the same fields the schemas declare.
 *
 * WHY one module: this contract used to live in THREE hand-written copies
 * (writer prompt text in capability.ts, reader text in the compile prompt,
 * checker code in L2Atom) and they drifted twice in production —
 *   - the http shape was taught to writers but not the reader: a compiled
 *     HTTP verifier crashed on `entry.cmd === undefined`;
 *   - the web shape was taught to writers but not the checker: every web
 *     manifest would have been reported MALFORMED to the validator.
 * A shape added or changed here propagates to all three sides at once, and
 * the example objects are parsed through their schemas at module load — a
 * drift between example and schema fails the entire test suite instantly.
 */

export const PROBE_MANIFEST_FILENAME = '.atoma-probes.json';

/**
 * A shell cmd "decorated" with an exit-code echo (`; echo EXIT=$?`,
 * `&& echo $?`…). The writer contract forbids recording these; the health
 * check reports them; the reader contract tells compiled scripts to SKIP
 * them. Exported so tests pin all three sides to the same signature.
 */
export const DECORATED_CMD_RE = /(?:;|&&|\|\|)\s*echo\s+[^;&|]*\$\?\s*$/;

/**
 * A recorded stdout that embeds the HTTP-bucket boot marker. The port is
 * OS-assigned fresh every run, so byte-comparing such a stdout fails every
 * replay of a healthy artefact — the writer contract says to omit stdout on
 * harness entries for exactly this reason. Observed live (contacts run,
 * 2026-08-07): one port-bearing recorded stdout produced a phantom mismatch
 * at deterministic dispatch and, combined with an omitted-entry miss the
 * run before, demoted a healthy compiled verifier. Deliberately pinned to
 * the project's own contract marker: zero false positives, and the broad
 * "omit run-varying output" rule stays with the writer prompt.
 */
export const PORT_BEARING_STDOUT_RE = /LISTENING_ON_PORT=\d+/;

/* ────────────────────────── schemas ────────────────────────── */

/**
 * SHELL entry — a verified CLI/script invocation. Re-run `cmd`, compare
 * exit/stdout/stderr byte-for-byte. `stdout`/`stderr` optional at parse
 * (older writers omitted them) but writers are told to record verbatim.
 */
export const shellEntrySchema = z
  .object({
    cmd: z.string().min(1),
    exitCode: z.number(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();

/**
 * HTTP entry — a verified request against the artefact's server. Boot the
 * server, request method+path against the bound port, compare status+body.
 * Entry ORDER is significant: state-dependent probes (PUT then GET) are
 * recorded in the sequence that made them pass.
 */
export const httpEntrySchema = z
  .object({
    probe: z.literal('http'),
    method: z.string().min(1),
    path: z.string().min(1),
    status: z.number(),
    body: z.string().optional(),
  })
  .passthrough();

/**
 * WEB entry — a verified browser validation. Deliberately records the FILE,
 * the selector-based interactions and the smoke expression, NEVER the
 * served URL (fresh port every run — a URL is unreplayable; those three are
 * exactly what lets a later pass re-serve and re-validate). Interactions
 * must be SELECTOR-based: pixel coordinates encode this run's viewport,
 * fonts and layout, and are rejected by the health check.
 */
/**
 * The BROWSER-PROBE discriminant, in the two places a browser observation is
 * declared: the on-disk manifest entry (`webEntrySchema`) and the child's
 * in-envelope `output.probes` record. ONE literal is taught — both the
 * manifest writer block and the web canonical prompt's envelope example are
 * generated from this constant, so the vocabulary cannot drift again.
 *
 * WHY the constant exists (measured, cold `web-counter` run 2026-08-22): the
 * web canonical prompt taught `"probe": "validate_html"` in the envelope while
 * the manifest schema and the ground-truth detector both read the literal
 * `"web"`. The child followed the prompt, so the supervisor's web-manifest
 * health check never activated even though a manifest was on disk, and the
 * RESULT was approved on the child's own narration. See
 * `docs/incidents/supervisor-attestation-evidence-2026-08-22.md`.
 */
export const WEB_PROBE_DISCRIMINANT = 'web' as const;

/**
 * Envelope-ONLY tolerance. `validate_html` is the tool-name spelling the web
 * canonical prompt taught until 2026-08-22; archived skill recipes distilled
 * in that window still carry it, and a child that matches such a recipe will
 * keep emitting it. The READER therefore recognises it so the manifest check
 * fires; the on-disk manifest checker below stays single-valued and still
 * rejects it, because the manifest is a replay contract and its discriminator
 * is what a compiled script dispatches on.
 */
export const REPORTED_WEB_PROBE_ALIASES: readonly string[] = ['validate_html'];

/**
 * Does this `output.probes` entry declare a browser observation? Recognition
 * only — this says the child CLAIMS a browser probe, never that the runtime
 * executed one.
 */
export function isReportedWebProbe(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const probe = (entry as Record<string, unknown>)['probe'];
  return (
    probe === WEB_PROBE_DISCRIMINANT ||
    (typeof probe === 'string' && REPORTED_WEB_PROBE_ALIASES.includes(probe))
  );
}

export const webInteractionSchema = z
  .object({
    type: z.string().min(1),
    selector: z.string().min(1),
  })
  .passthrough();

export const webEntrySchema = z
  .object({
    probe: z.literal(WEB_PROBE_DISCRIMINANT),
    file: z.string().min(1),
    interactions: z.array(webInteractionSchema).optional(),
    smoke: z.string().min(1),
    expected: z.string().optional(),
    consoleErrors: z.number().optional(),
    failedRequests: z.number().optional(),
  })
  .passthrough();

export const probeManifestSchema = z
  .object({
    version: z.literal(1),
    // Entries are validated per-shape by `validateProbeManifest` so ONE bad
    // entry yields a targeted message instead of a whole-file reject.
    entries: z.array(z.unknown()),
  })
  .passthrough();

export type ShellEntry = z.infer<typeof shellEntrySchema>;
export type HttpEntry = z.infer<typeof httpEntrySchema>;
export type WebEntry = z.infer<typeof webEntrySchema>;
export type ManifestEntry = ShellEntry | HttpEntry | WebEntry;

const WEB_STYLE_TERM_RE = /(?:class|style|colou?r|getComputedStyle)/i;

export function smokeOkClause(smoke: string): string {
  const okAt = smoke.search(/\bok\s*:/i);
  if (okAt < 0) return '';
  const okEnd = smoke.indexOf(',', okAt);
  return smoke.slice(okAt, okEnd > okAt ? okEnd : okAt + 1200);
}

export function smokeOkIncludesStyling(smoke: string): boolean {
  if (WEB_STYLE_TERM_RE.test(smokeOkClause(smoke))) return true;
  return (
    /Object\.values\(checks\)\.every\(Boolean\)/.test(smoke) &&
    /\bchecks\s*=\s*\{[\s\S]*(?:class|style|colou?r|getComputedStyle)/i.test(smoke)
  );
}

export function smokeResultIncludesStyling(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => WEB_STYLE_TERM_RE.test(key) || visit(child)
    );
  };
  return visit(result);
}

/* ─────────────────── schema-validated examples ─────────────────── */
/**
 * The examples embedded in every prompt block below. Parsed through their
 * schemas HERE, at module load: if a field is renamed in a schema without
 * updating the example (or vice-versa), every test run throws before a
 * single prompt is built. This is the mechanism that makes the prompts
 * "generated from the schema" rather than parallel prose.
 */
export const EXAMPLE_SHELL_ENTRY: ShellEntry = shellEntrySchema.parse({
  cmd: '<exact command>',
  exitCode: 0,
  stdout: '<verbatim>',
  stderr: '<verbatim>',
});

export const EXAMPLE_HTTP_ENTRY: HttpEntry = httpEntrySchema.parse({
  probe: 'http',
  method: 'GET',
  path: '/status',
  status: 200,
  body: '<verbatim first 200 chars>',
});

export const EXAMPLE_WEB_ENTRY: WebEntry = webEntrySchema.parse({
  probe: WEB_PROBE_DISCRIMINANT,
  file: 'index.html',
  interactions: [{ type: 'click', selector: '#start' }],
  smoke: 'window.__test.started === true',
  expected: 'true',
  consoleErrors: 0,
});

/* ────────────────────── health check ────────────────────── */

/**
 * Field names a writer plausibly used INSTEAD of the canonical one. The
 * contract is taught by example, and L1s paraphrase it: two runs were
 * measured burning four and five rejection cycles respectively on
 * {kind, expect} and "expectExitCode". Stating the absence alone
 * ("missing numeric status") left the writer guessing; naming the
 * rename it actually made turns a cascade into one coached cycle.
 */
const CANONICAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  status: ['expect', 'expectedStatus', 'expected_status', 'statusCode', 'status_code'],
  exitCode: ['expectExitCode', 'expected_exit_code', 'expectedExitCode', 'exit_code', 'code'],
  cmd: ['command', 'invocation'],
  probe: ['kind', 'type'],
};

function renameHint(entry: Record<string, unknown>, canonical: string): string {
  const found = (CANONICAL_ALIASES[canonical] ?? []).filter((a) => entry[a] !== undefined);
  if (found.length === 0) return '';
  return ` — this entry has "${found[0]}"; the field is named "${canonical}" (field names are exact, never renamed)`;
}

/**
 * Shape check for the on-disk probe manifest. The manifest is written by
 * PROMPT (L1 evidence contracts) and read by COMPILED SCRIPTS; this check
 * runs in the read-back probe so breakage surfaces as validator evidence
 * instead of a far-away dispatch crash. Returns human-readable problems;
 * an EMPTY list means "well-formed".
 *
 * Deliberately tolerant: unknown extra fields pass (forward compatibility)
 * and a manifest MIXING shapes is VALID — that is the documented contract.
 *
 * Shape dispatch order matters (audit finding): the EXPLICIT `probe`
 * discriminator wins first, then `cmd` claims the shell shape, and only
 * then do we infer http/web from distinctive fields — so a shell entry
 * carrying an incidental extra `path` or `smoke` field is not
 * misclassified into a shape it never claimed (which produced a false
 * MALFORMED on a correct deliverable).
 */
export function validateProbeManifest(raw: string): string[] {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [`${PROBE_MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}`];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [`${PROBE_MANIFEST_FILENAME} must be a JSON object with an "entries" array`];
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== 1) {
    problems.push(
      `${PROBE_MANIFEST_FILENAME}: expected "version": 1, got ${JSON.stringify(obj['version'])}`
    );
  }
  const entries = obj['entries'];
  if (!Array.isArray(entries)) {
    problems.push(`${PROBE_MANIFEST_FILENAME}: "entries" must be an array`);
    return problems;
  }
  if (entries.length === 0) {
    problems.push(
      `${PROBE_MANIFEST_FILENAME}: "entries" is empty — nothing for a later pass to re-verify`
    );
  }
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`${PROBE_MANIFEST_FILENAME}: entry #${i} is not an object`);
      return;
    }
    const en = e as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(en, 'probe') &&
      en['probe'] !== 'http' &&
      en['probe'] !== WEB_PROBE_DISCRIMINANT
    ) {
      problems.push(
        `entry #${i}: "probe" must be the literal "http" or "web", got ${JSON.stringify(en['probe'])} — scenario labels belong in the smoke/note, not in the discriminator`
      );
    }
    const kind =
      en['probe'] === 'http'
        ? 'http'
        : en['probe'] === 'web'
          ? 'web'
          : typeof en['cmd'] === 'string'
            ? 'shell'
            : typeof en['path'] === 'string'
              ? 'http'
              : typeof en['smoke'] === 'string'
                ? 'web'
                : null;
    if (kind === 'http') {
      if (typeof en['method'] !== 'string') problems.push(`entry #${i} (http): missing string "method"`);
      if (typeof en['path'] !== 'string') problems.push(`entry #${i} (http): missing string "path"`);
      if (typeof en['status'] !== 'number') {
        problems.push(`entry #${i} (http): missing numeric "status"${renameHint(en, 'status')}`);
      }
    } else if (kind === 'web') {
      if (typeof en['file'] !== 'string') problems.push(`entry #${i} (web): missing string "file"`);
      if (typeof en['smoke'] !== 'string') problems.push(`entry #${i} (web): missing string "smoke"`);
      if (
        typeof en['file'] === 'string' &&
        /(?:^|\/)(?:test|probe|verify|check|harness)[^/]*\.(?:[cm]?js|ts)$/i.test(en['file'])
      ) {
        problems.push(
          `entry #${i} (web): "file" names a test/probe script (${JSON.stringify(en['file'])}), not the rendered artefact source`
        );
      }
      if (typeof en['smoke'] === 'string') {
        try {
          // Parse only; never execute model-authored manifest content.
          new Script(`(${en['smoke']})`);
        } catch {
          problems.push(
            `entry #${i} (web): "smoke" is not a replayable JavaScript expression`
          );
        }
      }
      if (!('expected' in en)) {
        problems.push(
          `entry #${i} (web): missing JSON-encoded "expected" result — the smoke has no replay comparison target`
        );
      }
      if ('expected' in en && typeof en['expected'] !== 'string') {
        problems.push(
          `entry #${i} (web): "expected" must be a JSON-encoded string, got ${typeof en['expected']}`
        );
      }
      const inter = en['interactions'];
      if (Array.isArray(inter)) {
        const allowedTypes = new Set([
          'click',
          'rightclick',
          'type',
          'keydown',
          'keyup',
          'keypress',
        ]);
        inter.forEach((action, actionIndex) => {
          if (!action || typeof action !== 'object' || Array.isArray(action)) {
            problems.push(`entry #${i} (web): interaction #${actionIndex} is not an object`);
            return;
          }
          const a = action as Record<string, unknown>;
          if (typeof a['type'] !== 'string' || !allowedTypes.has(a['type'])) {
            problems.push(
              `entry #${i} (web): interaction #${actionIndex} has unsupported type ${JSON.stringify(a['type'])}`
            );
          } else if (
            (a['type'] === 'click' || a['type'] === 'rightclick') &&
            typeof a['selector'] !== 'string' &&
            typeof a['x'] !== 'number' &&
            typeof a['y'] !== 'number'
          ) {
            problems.push(
              `entry #${i} (web): interaction #${actionIndex} ${a['type']} is missing a selector`
            );
          } else if (
            a['type'] === 'type' &&
            (typeof a['selector'] !== 'string' || typeof a['text'] !== 'string')
          ) {
            problems.push(
              `entry #${i} (web): interaction #${actionIndex} type requires string selector and text`
            );
          } else if (
            (a['type'] === 'keydown' || a['type'] === 'keyup' || a['type'] === 'keypress') &&
            typeof a['key'] !== 'string'
          ) {
            problems.push(
              `entry #${i} (web): interaction #${actionIndex} ${a['type']} is missing a key`
            );
          }
        });
        const coordOnly = inter.filter(
          (a) =>
            a &&
            typeof a === 'object' &&
            typeof (a as Record<string, unknown>)['selector'] !== 'string' &&
            (typeof (a as Record<string, unknown>)['x'] === 'number' ||
              typeof (a as Record<string, unknown>)['y'] === 'number')
        ).length;
        if (coordOnly > 0) {
          problems.push(
            `entry #${i} (web): ${coordOnly} interaction(s) use pixel coordinates instead of a "selector" — not replayable after a re-render`
          );
        }
      }
    } else if (kind === 'shell') {
      if (typeof en['exitCode'] !== 'number') {
        problems.push(`entry #${i} (shell): missing numeric "exitCode"${renameHint(en, 'exitCode')}`);
      }
      // Semantic corruption, same class as pixel-coordinate interactions:
      // a cmd decorated with an echo of $? records echo's exit code (always
      // 0) and a stdout no clean replay reproduces. Observed 2026-08-06:
      // such a manifest phantom-failed two deterministic dispatches and
      // auto-demoted a 30-success compiled verifier.
      if (typeof en['cmd'] === 'string' && DECORATED_CMD_RE.test(en['cmd'])) {
        problems.push(
          `entry #${i} (shell): cmd ends with an echo of $? — record the bare command; the exit code belongs in "exitCode" (a decorated cmd records echo's exit code and an unreplayable stdout)`
        );
      }
      if (typeof en['stdout'] === 'string' && PORT_BEARING_STDOUT_RE.test(en['stdout'])) {
        problems.push(
          `entry #${i} (shell): recorded stdout embeds a run-varying bound port (LISTENING_ON_PORT=…) — record {"cmd","exitCode"} and OMIT stdout for this entry, or every later replay diffs a fresh port against a stale one and fails a healthy artefact`
        );
      }
    } else {
      problems.push(
        `entry #${i}: matches no known shape — shell ("cmd" + "exitCode"), http ("method" + "path" + "status") or web ("file" + "smoke")`
      );
    }
  });
  return problems;
}

/* ────────────────── prompt-block generation ────────────────── */

/** Render an example entry as indented prompt lines inside the JSON scaffold. */
function exampleLines(entry: ManifestEntry): string[] {
  const json = JSON.stringify(entry, null, 1)
    .split('\n')
    .map((l) => '    ' + l.replace(/^\s*/, (m) => m.replace(/ /g, ' ')));
  // Compact: JSON.stringify(_, null, 1) keeps `"probe": "http"` greppable
  // (space after colon) while staying narrow enough for prompt lines.
  return [`  {"version": 1, "entries": [`, ...json, `  ]}`];
}

/**
 * WRITER block for the L1 evidence contracts — one per bucket. The
 * surrounding prose is bucket-specific (merge key, WHY framing) but the
 * embedded example is rendered from the schema-validated constants above.
 */
export function manifestWriterLines(kind: 'shell' | 'http' | 'web'): string[] {
  if (kind === 'http') {
    return [
      `PROBE MANIFEST ON DISK: whenever an HTTP request is evidence, call`,
      `fetch_url with "record": true. The tool appends its REAL observed`,
      `method/path/status/body to "${PROBE_MANIFEST_FILENAME}" itself — never`,
      `transcribe a fetch result, and never use curl or node -e as a substitute:`,
      ...exampleLines(EXAMPLE_HTTP_ENTRY),
      `One entry per verified request, in the order you ran them. fetch_url`,
      `ACCUMULATES across phases and preserves earlier entries automatically.`,
      `HTTP observations APPEND in`,
      `order — never merge by method+path: an HTTP manifest is a SEQUENCE,`,
      `and the same route legitimately appears several times with different`,
      `outcomes (a real CRUD manifest recorded POST /recipes four times: 201,`,
      `400 malformed, 400 missing-fields). Merging on the route would collapse`,
      `the sequence and silently delete the error cases.`,
      `NEVER record the long-running server command itself as a shell probe`,
      `(\`node server.js\` or equivalent). A server is supposed to keep running,`,
      `and record_probe is intentionally NOT in the HTTP toolset. Boot through`,
      `start_node_server, then call fetch_url for finite requests; the L1 runtime`,
      `forces every loopback fetch to record even if "record": true was omitted.`,
      `HARNESS ENTRY — MANDATORY WHENEVER A TEST SCRIPT EXISTS. If the`,
      `workspace holds an EXECUTABLE probe harness (test-api.js or similar —`,
      `a script that boots the server and exits non-zero on any mismatch),`,
      `run it through run_shell and APPEND a shell entry`,
      `{"cmd":"node <harness>","exitCode":0} IN ADDITION to the http entries —`,
      `omit "stdout", the bound port makes`,
      `it vary run to run. This is not optional bookkeeping: the http entries`,
      `carry no request payload, so WITHOUT the harness entry the manifest is`,
      `mechanically unreplayable and every later verification pass fails.`,
      `(Observed: one omission charged a healthy compiled verifier a direct`,
      `failure at dispatch; a second demoted it.)`,
      `FIELD NAMES ARE EXACT — do not rename, abbreviate or "improve" them,`,
      `and do not add a discriminator of your own. It is "probe", not "kind";`,
      `"status", not "expect"/"expectedStatus"; "cmd", not "command";`,
      `"exitCode", not "expectExitCode". A renamed field is an UNKNOWN shape`,
      `to every reader — measured twice: one run burned four rejection`,
      `cycles on {kind, expect} and another five on "expectExitCode".`,
      `WHY: this file is the machine-readable interface later verification`,
      `passes re-run and diff against — prose in a README cannot be parsed`,
      `reliably, this can.`,
    ];
  }
  if (kind === 'web') {
    return [
      `PROBE MANIFEST ON DISK: whenever you validated a page, ALSO write_file`,
      `"${PROBE_MANIFEST_FILENAME}" in the workspace root:`,
      ...exampleLines(EXAMPLE_WEB_ENTRY),
      `One entry per DISTINCT validation you performed, in the order you ran`,
      `them; merge by file+smoke if the file already exists. WHY: the served`,
      `URL is EPHEMERAL (a fresh port every run) but the FILE, the`,
      `interactions and the smoke expression are stable — recording those`,
      `three makes a later pass able to re-serve the artefact and replay the`,
      `exact same validation. Prose in a README cannot be replayed; this can.`,
      `For an embedded UI served from a Node application, "file" is the real`,
      `server entry (for example server.js), never an extracted/fake index.html`,
      `or a test script.`,
      `The discriminator is EXACT: "probe" MUST be the literal "web". Never`,
      `put a scenario label there (for example "reset_after_increments");`,
      `the smoke/interactions already distinguish scenarios, and every reader`,
      `dispatches on the literal value.`,
      `"expected" is a STRING containing JSON.stringify(smokeResult), never the`,
      `object itself. The checker and replay reader require that encoded form.`,
      `Because replay compares that result, smokeResult must exclude volatile`,
      `timestamps, generated ids, numeric ports and locale-formatted dates;`,
      `return stable booleans/counts/source-defined labels instead.`,
      `INTERACTIONS MUST BE SELECTOR-BASED — MANDATORY. Record`,
      `{"type": "click", "selector": "#start"}, NEVER pixel coordinates`,
      `({"x":304,"y":392}), even though validate_html accepts them: coordinates`,
      `depend on the viewport, fonts and layout of THIS run and are worthless`,
      `to a later pass, while a selector survives any re-render. If an element`,
      `has no usable selector, ADD an id to it in the artefact — that is a`,
      `legitimate, tiny improvement to the deliverable, not a workaround.`,
    ];
  }
  return [
    `PROBE MANIFEST ON DISK — USE record_probe, DO NOT TRANSCRIBE BY HAND.`,
    `When you verify an invocation of a runnable artefact (a CLI, a script)`,
    `and that invocation is EVIDENCE the deliverable works, run it with`,
    `record_probe instead of run_shell. It executes the command and writes`,
    `the real exit code and the real, complete output into`,
    `"${PROBE_MANIFEST_FILENAME}" itself, merging by command.`,
    `PASS THE WHOLE COMMAND LINE as "cmd", exactly as a user would type it:`,
    `  record_probe {"cmd": "node <entry> <args>"}`,
    `Do NOT wrap it in \`bash -c\` — the tool adds a shell only when the line`,
    `truly needs one (a pipe, a redirect, &&) and records the bare command`,
    `either way. A recorded \`bash -c "..."\` breaks the replay: a compiled`,
    `verifier deriving arguments from the recorded cmd captures the wrapper's`,
    `closing quote and runs \`node x.js arg"\`, failing a correct artefact.`,
    `WHY IT IS A TOOL AND NOT AN INSTRUCTION: pasting observed output into a`,
    `write_file was measured ABRIDGING long results — the recorded stdout was`,
    `a strict prefix of the real one (371 characters against 2008), so the`,
    `compiled verifier that replays this file byte-for-byte could never match`,
    `and demoted itself on false mismatches. You choose WHICH invocations are`,
    `evidence; the tool decides what the record says.`,
    `Keep using run_shell for everything that is NOT evidence (mkdir, ls,`,
    `scratch checks) — auto-recording those would bury the record in noise.`,
    `The resulting entries look like this; you never write them yourself:`,
    ...exampleLines(EXAMPLE_SHELL_ENTRY),
    `If you must write an entry by hand (no record_probe in your declared`,
    `tools), the rules below apply in full.`,
    `"cmd" is the BARE command exactly as a user would run it. NEVER append`,
    `display decorations like \`; echo EXIT=$?\` to the recorded cmd — the`,
    `exit code belongs in "exitCode". A decorated cmd corrupts the record`,
    `twice: the recorded exitCode becomes echo's (always 0, so the CLI's real`,
    `error-case codes are lost), and the recorded stdout embeds the`,
    `decoration's output, which no clean replay can reproduce.`,
    `Full verbatim stdout/stderr per entry (unlike the in-envelope record,`,
    `size is fine here) — EXCEPT when the output embeds a value that differs`,
    `every run (a bound port, a timestamp, a temp path): then record`,
    `{"cmd","exitCode"} ALONE and omit stdout/stderr. An omitted field is a`,
    `deliberate signal that the value is not comparable; recording it turns`,
    `every later replay into a guaranteed false failure.`,
    `One entry per DISTINCT verified invocation; UPDATE`,
    `the file (merge by cmd) if it already exists, PRESERVING the recorded`,
    `shape — never ADD stdout/stderr to an entry that omitted them. The`,
    `If an ACCIDENTAL probe used the wrong command and the corrected command`,
    `is different, call record_probe on the corrected command with`,
    `supersedes:"<exact old cmd>". It removes only that stale entry AFTER the`,
    `replacement ran; do not leave a known-broken attempt in the durable set.`,
    `manifest ACCUMULATES across phases: READ the existing file first and`,
    `merge — entries you did not write belong to EARLIER phases and must`,
    `survive your update. Never truncate or rewrite the file wholesale`,
    `(observed: one run destroyed 12 recorded entries in two successive`,
    `whole-file rewrites, starving every later replay). WHY: this file is the`,
    `machine-readable interface later verification passes re-run and diff`,
    `against — prose in a README cannot be parsed reliably, this can.`,
  ];
}

/**
 * READER block for the compile prompt: teaches a compiled script how to
 * consume the manifest. All THREE example shapes rendered from the same
 * constants the writers use — the drift class that produced the
 * `entry.cmd === undefined` crash is structurally closed.
 */
export function manifestReaderLines(): string[] {
  const compact = (e: ManifestEntry): string => JSON.stringify(e).replace(/","/g, '", "').replace(/":"/g, '": "').replace(/":(\d)/g, '": $1').replace(/,"/g, ', "');
  return [
    `PROBE MANIFEST — PREFER MACHINE INPUT OVER PROSE. The workspace may`,
    `contain "${PROBE_MANIFEST_FILENAME}": {"version": 1, "entries": [...]}`,
    `— the record of what earlier phases already executed and verified.`,
    `Entries come in THREE SHAPES and a manifest may MIX them; dispatch on`,
    `the fields present, never assume one shape:`,
    `  SHELL:  ${compact(EXAMPLE_SHELL_ENTRY)}`,
    `          → re-run cmd, compare exit/stdout/stderr byte-for-byte`,
    `  HTTP:   ${compact(EXAMPLE_HTTP_ENTRY)}`,
    `          → boot the server, request method+path against the bound`,
    `          port, compare status + body`,
    `  WEB:    ${compact(EXAMPLE_WEB_ENTRY)}`,
    `          → serve the workspace, replay interactions + smoke, compare.`,
    `          NOTE: a compiled script has NO browser tooling, so a WEB`,
    `          entry is verifiable only in the LLM tool-loop (validate_html)`,
    `          — if the recipe's core work is web validation, REFUSE`,
    `          promotion rather than shipping a script that fakes it.`,
    `Skip (do not crash on) any entry whose shape you don't recognise, and`,
    `treat entry ORDER as significant — state-dependent HTTP probes (PUT`,
    `then GET) are recorded in the sequence that made them pass.`,
    `COMPARISON TOLERANCE — exactly one: when comparing recorded vs observed`,
    `stdout/stderr, a difference ONLY in trailing newline is a MATCH`,
    `(transcription trims vary between writers); everything else stays`,
    `byte-for-byte. Mind the TYPES: "exitCode"/"status" are NUMBERS —`,
    `compare them strictly, never through a string-only normalizer (a`,
    `compiled replayer once died on \`(0).replace\` before checking`,
    `anything). And exactly one PATHOLOGY to sidestep: a shell entry`,
    `whose cmd ends in an echo of $? (e.g. \`; echo EXIT=$?\`) is a POLLUTED`,
    `record — its exitCode is echo's (always 0) and its stdout embeds the`,
    `decoration — so SKIP it with an explanatory note instead of replaying`,
    `it (a replay diffs against corrupted expectations and fails a correct`,
    `artefact). Measured: a 30-success verifier was auto-demoted after two`,
    `such phantom mismatches. Related pollution, same treatment at the FIELD`,
    `level: a recorded stdout embedding LISTENING_ON_PORT=<n> is port-bearing`,
    `(the OS assigns a fresh port every run) — for such an entry compare the`,
    `exitCode ONLY, note that the recorded stdout was ignored as run-varying,`,
    `and do NOT write the fresh port back. If skipping leaves nothing to`,
    `verify, exit non-zero saying WHY — never silently pass.`,
    `When the recipe involves re-running / verifying / documenting`,
    `invocations, the script MUST read this manifest as its PRIMARY input`,
    `and fall back to prose parsing only when the manifest is absent. Two`,
    `compile generations of prose-parsing verification failed offline`,
    `regression on 6/6 real workspaces — free-form markdown is not a`,
    `parseable interface; the manifest is. A THIRD generation then crashed`,
    `reading \`entry.cmd\` on http-shaped entries (undefined) — hence the`,
    `explicit three-shape contract above. Conversely, when the script itself`,
    `executes and verifies invocations, it MUST write/merge this manifest`,
    `in the matching shape so later passes inherit a machine-readable`,
    `record — PRESERVING each entry's recorded shape. Never ADD a`,
    `"stdout"/"stderr" to an entry that omitted it: the omission means the`,
    `value varies between runs (an HTTP harness prints the port it bound),`,
    `so re-recording it makes the NEXT replay diff a fresh value against a`,
    `stale one and fail on a correct artefact. Measured: a compiled verifier`,
    `did exactly this, passed once, then failed forever — two such failures`,
    `demote the script. AND write/merge ONLY after every comparison passed:`,
    `on a failing pass leave the manifest UNCHANGED — merging failing`,
    `observations overwrites the recorded expectations with the regressed`,
    `values, and the NEXT replay passes against the corrupted record`,
    `(regression whitewashing — a compiled script shipped with the write`,
    `ahead of the mismatch gate).`,
  ];
}

/* ────────────────── merge semantics — ONE definition ────────────────── */
/**
 * ENTRY IDENTITY — one rule per shape, shared by every manifest writer
 * (write_file's structural merge, record_probe, fetch_url record:true):
 *
 *   SHELL  keyed by `cmd` — re-running an invocation after a fix REPLACES
 *          its stale record in place, never accumulating duplicates.
 *   WEB    keyed by `file` + `smoke` — the same validation re-run REPLACES
 *          its record; a different smoke on the same file is a DISTINCT
 *          validation and keeps its own entry.
 *   HTTP   NO identity: an HTTP manifest is a SEQUENCE. The same route
 *          legitimately appears several times with different outcomes (a
 *          real CRUD manifest recorded POST /recipes four times: 201, 400
 *          malformed, 400 missing-fields, repeat), so the machine recorder
 *          ALWAYS APPENDS in order and never merges by route.
 *
 * CORRUPT-INPUT POLICIES — three, deliberately DIFFERENT, documented side
 * by side because they used to live in three independent implementations
 * inside `src/tools/builtin.ts` and read as drift:
 *
 *   - `mergeProbeManifestWrite` (write_file): when either document fails to
 *     parse or lacks an entries array, PASS THE INCOMING DOCUMENT THROUGH
 *     verbatim. The input is MODEL-owned: the model may be legitimately
 *     REPAIRING a structurally broken manifest, and silently discarding its
 *     whole document would fight that repair.
 *   - `mergeShellProbe` (record_probe) and `appendHttpProbe` (fetch_url
 *     record:true): a corrupt/absent existing manifest RESETS to a fresh
 *     `{version: 1, entries: []}`. The input is MACHINE-owned: half a JSON
 *     document is not a record anyone can replay, and these writers must
 *     leave a valid manifest behind them.
 *
 * PRESERVED DIVERGENCES (moved verbatim; possibly accidental, kept because
 * this consolidation is byte-compatible by contract):
 *   - write_file DEDUPES an http/unknown-shape entry that is an EXACT
 *     JSON.stringify duplicate of an existing one, while the machine append
 *     path keeps exact duplicates (the SEQUENCE contract above).
 *   - `mergeShellProbe`/`appendHttpProbe` rebuild the top-level document as
 *     `{version, entries}` (dropping any extra top-level fields), while
 *     `mergeProbeManifestWrite` preserves the INCOMING document's extra
 *     top-level fields and forces `version: 1`.
 *   - `mergeShellProbe` reads `entry['cmd']` unguarded, so an existing
 *     manifest already holding a non-object entry (reachable only through
 *     write_file's tolerant path, which preserves such entries for the
 *     health check to report) makes it throw, where
 *     `mergeProbeManifestWrite` handles the same entry null-safely.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** SHELL identity — does `candidate` occupy the identity slot for `cmd`? */
export function matchesShellIdentity(candidate: unknown, cmd: string): boolean {
  return isPlainRecord(candidate) && candidate['cmd'] === cmd;
}

/** WEB identity — does `candidate` occupy the identity slot for file+smoke? */
export function matchesWebIdentity(candidate: unknown, file: unknown, smoke: unknown): boolean {
  return (
    isPlainRecord(candidate) &&
    candidate['probe'] === 'web' &&
    candidate['file'] === file &&
    candidate['smoke'] === smoke
  );
}

/**
 * Refusal check for a MODEL-authored whole-document manifest write.
 *
 * The pass-through in `mergeProbeManifestWrite` exists so the model can
 * REPAIR a structurally broken manifest, and that intent is right — but a
 * repair that does not itself parse is not a repair, it is corruption, and
 * the writer must never persist a record no reader can read back. The two
 * machine writers already hold that invariant; this closes the model-owned
 * path to the same standard while leaving repair untouched, because only the
 * INCOMING document is checked (existing-corrupt + incoming-valid still
 * passes through verbatim).
 *
 * MEASURED 2026-08-21, batch 3 / web-progress: `edit_file` refuses manifest
 * edits and tells the caller to "write_file the whole document after
 * read_file", so the model hand-authored 10857 bytes carrying a RAW NEWLINE
 * inside a string ("Bad control character in string literal at position
 * 6408", charCode 10). The merge could not parse it, returned it verbatim,
 * and byte-identical in/out put an unreadable manifest on disk. The
 * supervisor's zero-token ground-truth probe then reported MALFORMED at that
 * exact position, the L2 validator rejected the RESULT, and the run paid a
 * full extra execute cycle to repair a file this tool had accepted. We
 * refused the SURGICAL edit and accepted the risky WHOLESALE rewrite with no
 * check, having just instructed it.
 *
 * Returns the coaching message, or null when the write may proceed.
 */
export function probeManifestWriteRefusal(incomingRaw: string): string | null {
  try {
    JSON.parse(incomingRaw);
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return (
      `write_file: refusing to write "${PROBE_MANIFEST_FILENAME}" because the document you supplied ` +
      `is not valid JSON (${detail}). Nothing was written, so the manifest on disk is unchanged and ` +
      `still readable. This is usually a RAW newline, tab or quote inside a string value — a smoke ` +
      `source or a recorded stdout pasted in literally instead of escaped. Do not hand-author this ` +
      `file: let record_probe, fetch_url record:true and validate_html write their own entries, and ` +
      `if you must repair its structure, read_file it and write back a document you have kept valid.`
    );
  }
}

/**
 * Structural merge for a MODEL-authored whole-document manifest write
 * (write_file). Shell entries replace by `cmd`, web entries replace by
 * `file`+`smoke`, anything else appends unless it is an exact duplicate.
 * Corrupt input → the incoming document passes through verbatim (see the
 * policy block above).
 */
export function mergeProbeManifestWrite(existingRaw: string, incomingRaw: string): string {
  let existing: unknown;
  let incoming: unknown;
  try {
    existing = JSON.parse(existingRaw);
    incoming = JSON.parse(incomingRaw);
  } catch {
    return incomingRaw;
  }
  const existingEntries = isPlainRecord(existing) ? existing['entries'] : undefined;
  const incomingEntries = isPlainRecord(incoming) ? incoming['entries'] : undefined;
  if (!Array.isArray(existingEntries) || !Array.isArray(incomingEntries)) return incomingRaw;

  const merged = [...existingEntries];
  for (const entry of incomingEntries) {
    if (!isPlainRecord(entry)) {
      if (!merged.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) {
        merged.push(entry);
      }
      continue;
    }
    let replaceIndex = -1;
    if (typeof entry['cmd'] === 'string') {
      const cmd = entry['cmd'];
      replaceIndex = merged.findIndex((candidate) => matchesShellIdentity(candidate, cmd));
    } else if (entry['probe'] === 'web') {
      replaceIndex = merged.findIndex((candidate) =>
        matchesWebIdentity(candidate, entry['file'], entry['smoke'])
      );
    } else if (merged.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) {
      continue;
    }
    if (replaceIndex >= 0) merged[replaceIndex] = entry;
    else merged.push(entry);
  }
  return `${JSON.stringify({ ...(incoming as Record<string, unknown>), version: 1, entries: merged }, null, 2)}\n`;
}

/**
 * Merge one MACHINE-recorded shell entry into a probe manifest, by `cmd`
 * (record_probe). `supersedes` removes exactly the named stale SHELL entry
 * — only after its corrected replacement ran, and never an http/web entry,
 * which carry no `cmd`. Corrupt/absent existing manifest → reset (see the
 * policy block above).
 */
export function mergeShellProbe(
  existingRaw: string | null,
  entry: { cmd: string; exitCode: number; stdout?: string; stderr?: string; note?: string },
  supersedes?: string
): string {
  let doc: { version: number; entries: Record<string, unknown>[] } = { version: 1, entries: [] };
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as typeof doc;
      if (parsed && Array.isArray(parsed.entries)) doc = { version: 1, entries: parsed.entries };
    } catch {
      // A corrupt manifest is replaced rather than appended to: half a JSON
      // document is not a record anyone can replay.
    }
  }
  if (supersedes && supersedes !== entry.cmd) {
    doc.entries = doc.entries.filter((e) => e['cmd'] !== supersedes);
  }
  const i = doc.entries.findIndex((e) => e['cmd'] === entry.cmd);
  if (i >= 0) doc.entries[i] = entry;
  else doc.entries.push(entry);
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Append one MACHINE-recorded HTTP observation to a probe manifest
 * (fetch_url record:true). Never merges — HTTP entries are an ordered
 * SEQUENCE (see the identity block above). Corrupt/absent existing
 * manifest → reset.
 */
export function appendHttpProbe(
  existingRaw: string | null,
  entry: {
    probe: 'http';
    method: string;
    path: string;
    status: number;
    body?: string;
    note?: string;
  }
): string {
  let doc: { version: number; entries: Record<string, unknown>[] } = {
    version: 1,
    entries: [],
  };
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as typeof doc;
      if (parsed && Array.isArray(parsed.entries)) {
        doc = { version: 1, entries: parsed.entries };
      }
    } catch {
      // A corrupt manifest is replaced rather than extended with more
      // plausible-looking data.
    }
  }
  doc.entries.push(entry);
  return JSON.stringify(doc, null, 2) + '\n';
}
