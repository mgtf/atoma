import { z } from 'zod';

/**
 * SCRIPT STDOUT ENVELOPE — the contract between a compiled skill script
 * and the deterministic dispatch path.
 * ====================================================================
 * A `kind: script` skill must print, as the LAST non-empty stdout line,
 * one JSON object `{"output": <non-null>, "summary": "<sentence with an
 * embedded == GROUND TRUTH == block>"}`. This module is the single source
 * of truth for that shape: the schema, the strict parse the deterministic
 * dispatch applies, the cheap pre-flight token check, and the scratch-file
 * extension policy all live here (they used to be spread through L2Atom).
 */

export const scriptEnvelopeSchema = z.object({
  // null/undefined output is OFF-CONTRACT by design — see parse guard below.
  output: z.unknown().refine((v) => v !== null && v !== undefined, {
    message: 'output must be present and non-null',
  }),
  summary: z.string(),
});

export type ScriptEnvelope = { output: unknown; summary: string };

/** Schema-validated example embedded in prompts that teach the envelope. */
export const EXAMPLE_ENVELOPE: ScriptEnvelope = scriptEnvelopeSchema.parse({
  output: '<the deliverable value>',
  summary: '<one sentence>\n== GROUND TRUTH ==\n<evidence lines>',
});

/**
 * Strict parse of the script-skill stdout contract: the LAST non-empty
 * line must be a JSON object with an `output` field and a string
 * `summary`. Anything else returns null — the deterministic dispatch
 * treats a missing envelope as "script off-contract" and falls back to
 * the LLM loop rather than guessing at a wrap. (The LLM path stays
 * tolerant: `skillContextBlock` tells the L1 how to wrap plain stdout.)
 */
export function parseScriptEnvelope(stdout: string): ScriptEnvelope | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const obj = JSON.parse(last) as Record<string, unknown>;
    if (
      obj !== null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      'output' in obj &&
      typeof obj['summary'] === 'string'
    ) {
      // SELF-REPORTED FAILURE GUARD. The deterministic path has no validator
      // downstream (it returns before the supervise loop), so this parse is
      // the ONLY gate between a script's stdout and a result the parent
      // treats as a success — and the exit code cannot be trusted alone:
      // measured on the freshly-promoted `document-cli-from-source`, a run in
      // a workspace without the CLI printed
      //   {"output":null,"summary":"FAILED: index.js ... not found ..."}
      // with EXIT=0, which the old check accepted and then credited with
      // `recordSuccess` — entrenching a broken script at 6/0, 7/0, …
      // A null/absent output or a summary that announces its own failure is
      // therefore treated as OFF-CONTRACT: returning null sends the subtask
      // back through the normal (validated) LLM loop.
      if (obj['output'] === null || obj['output'] === undefined) return null;
      if (/^\s*(FAILED|ERROR)\b/i.test(obj['summary'])) return null;
      return { output: obj['output'], summary: obj['summary'] };
    }
  } catch {
    // not JSON — off-contract
  }
  return null;
}

/**
 * PRE-FLIGHT gate for deterministic dispatch: does this script body even
 * attempt the `{"output", "summary"}` stdout envelope?
 *
 * `parseScriptEnvelope` already catches an off-contract script AFTER the
 * fact — but by then the script has run, and a script written against a
 * different calling convention has already had its side effects. Concrete
 * case: a hand-authored `scaffold-package-json` reads argv positionally
 * (`name`, `version`, `description...`) while direct dispatch passes ONE
 * arg — the JSON-encoded subtask description. Dispatching it writes a
 * `package.json` whose `name` is the whole task sentence, exits 0, prints
 * prose, fails the envelope parse, and hands the LLM loop a workspace
 * already polluted with a bogus artefact.
 *
 * A script that never names `output`/`summary` cannot satisfy the envelope,
 * so refusing to run it costs nothing and skips straight to the (validated)
 * LLM tool-loop path — which handles these scripts correctly, because there
 * the L1 derives the positional args from the subtask itself.
 *
 * Deliberately a cheap token check rather than a parse: false negatives only
 * fall back to the LLM loop (safe), whereas the failure we are closing is a
 * false positive. Keep it that way.
 */
export function scriptDeclaresEnvelope(body: string): boolean {
  return /\boutput\b/.test(body) && /\bsummary\b/.test(body);
}

export function scriptExtension(language: 'node' | 'python' | 'bash'): string {
  // 'mjs', NEVER bare 'js': the scratch file lands in the WORKSPACE, whose
  // `.js` semantics belong to the deliverable — a task-authored root
  // package.json with `"type": "module"` flipped a `.js` scratch to ESM and
  // a CommonJS script died with "require is not defined in ES module
  // scope" (observed live, triov batch 2026-08-02: two dispatch failures →
  // natural #C4b demotion of a logically sound script). The invariant is
  // the EXPLICIT extension; `.mjs` (over `.cjs`) is the house choice —
  // the repo itself is ESM (`"type": "module"`, NodeNext) and compiled
  // skills follow the same dialect. The compile prompt pins ESM (import,
  // no __dirname); a legacy CommonJS body written to `.mjs` crashes
  // cleanly on first dispatch and the directFailures streak demotes it —
  // the self-healing path covers stragglers.
  if (language === 'node') return 'mjs';
  if (language === 'python') return 'py';
  return 'sh';
}
