import { z } from 'zod';

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
export const webInteractionSchema = z
  .object({
    type: z.string().min(1),
    selector: z.string().min(1),
  })
  .passthrough();

export const webEntrySchema = z
  .object({
    probe: z.literal('web'),
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
  probe: 'web',
  file: 'index.html',
  interactions: [{ type: 'click', selector: '#start' }],
  smoke: '<the exact smoke expression you ran>',
  expected: '<its observed result, JSON-encoded>',
  consoleErrors: 0,
});

/* ────────────────────── health check ────────────────────── */

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
      if (typeof en['status'] !== 'number') problems.push(`entry #${i} (http): missing numeric "status"`);
    } else if (kind === 'web') {
      if (typeof en['file'] !== 'string') problems.push(`entry #${i} (web): missing string "file"`);
      if (typeof en['smoke'] !== 'string') problems.push(`entry #${i} (web): missing string "smoke"`);
      const inter = en['interactions'];
      if (Array.isArray(inter)) {
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
      if (typeof en['exitCode'] !== 'number') problems.push(`entry #${i} (shell): missing numeric "exitCode"`);
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
      `PROBE MANIFEST ON DISK: whenever you verified HTTP endpoints, ALSO`,
      `write_file "${PROBE_MANIFEST_FILENAME}" in the workspace root:`,
      ...exampleLines(EXAMPLE_HTTP_ENTRY),
      `One entry per DISTINCT verified request, in the order you ran them`,
      `(state-dependent probes keep their sequence); merge by method+path if`,
      `the file already exists. WHY: this file is the machine-readable`,
      `interface later verification passes re-run and diff against — prose in`,
      `a README cannot be parsed reliably, this can.`,
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
    `PROBE MANIFEST ON DISK: whenever you verified invocations of a runnable`,
    `artefact (a CLI, a script) with run_shell, ALSO write_file`,
    `"${PROBE_MANIFEST_FILENAME}" in the workspace root with the same record:`,
    ...exampleLines(EXAMPLE_SHELL_ENTRY),
    `Full verbatim stdout/stderr per entry (unlike the in-envelope record,`,
    `size is fine here); one entry per DISTINCT verified invocation; UPDATE`,
    `the file (merge by cmd) if it already exists. WHY: this file is the`,
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
    `record.`,
  ];
}
