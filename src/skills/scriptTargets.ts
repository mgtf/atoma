import path from 'node:path';
import { extractResultFilePaths } from '../atoms/groundTruth.js';

/**
 * WHICH FILE does a compiled script write, and does the subtask need THAT one?
 *
 * Round 6 added a match-time filter asking "does this body write at all?"
 * (`scriptWritesFiles`). Round 7 measured it firing ZERO times across a whole
 * round: almost every compiled verifier merges its observations back into
 * `.atoma-probes.json`, so the any-write test calls it a writer and the filter
 * is inert on the entire class it was built for. The failure mode had been
 * registered before that round shipped, which is worse, not better.
 *
 * The right question is per-DESTINATION: a verifier that only ever writes the
 * probe manifest must not be offered for "update README.md". That is
 * statically decidable on the bodies this project actually compiles.
 *
 * DIRECTION OF ERROR — refuse ONLY on a PROVEN disjunction. A false refusal is
 * permanent and expensive (a lost zero-token dispatch AND the credit that arms
 * maturation); a false offer costs two tool calls and a scratch file before the
 * deliverable gate catches it — which it did 14 times across rounds 6 and 7
 * without a single wrong deliverable. Same rule as the `edit_file`
 * double-escape fix: act only when the defect is PROVABLE for the call in hand.
 *
 * ACCEPTED RESIDUAL, stated plainly: a write performed by a subprocess
 * (`spawnSync('sed', ['-i', …])`) is invisible to this scan and reads as "writes
 * nothing", so it could be refused wrongly. Do NOT fix that by treating every
 * body that spawns as opaque — all ten compiled bodies in the corpus use
 * `spawnSync` to replay the CLI, so that rule would make the predicate inert
 * again, which is precisely round 7's mistake. The residual stays with the
 * deliverable gate.
 */

/** Write APIs and the argument index that names the DESTINATION. */
const WRITE_APIS: ReadonlyArray<readonly [name: string, destArg: number]> = [
  ['writeFileSync', 0],
  ['writeFile', 0],
  ['appendFileSync', 0],
  ['appendFile', 0],
  ['createWriteStream', 0],
  ['outputFileSync', 0],
  ['outputFile', 0],
  ['truncateSync', 0],
  ['unlinkSync', 0],
  ['rmSync', 0],
  // Destination is the SECOND argument for these.
  ['copyFileSync', 1],
  ['copyFile', 1],
  ['renameSync', 1],
  ['rename', 1],
];
// `mkdir`/`mkdirSync` are deliberately absent: a directory is not a deliverable.

/**
 * A resolved literal must have a non-empty stem. Without this guard
 * `base + '.md'` resolves to the phantom basename `.md`, which matches no
 * subtask and therefore reads as "writes nothing" — a SILENT false refusal
 * rather than the honest `opaque` the expression deserves.
 */
const NON_EMPTY_STEM_RE = /[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,8}$/;

/**
 * Verbs that make a named file an OUTPUT of the subtask rather than an input.
 *
 * The deliverable gate checks EXISTENCE, which is inert on a maintenance task:
 * every file already exists, so a script that writes nothing passes. MEASURED
 * on the 2026-08-11 maintenance round — the compiled verifier was matched to
 * "update README.md so that only the invocations whose behaviour legitimately
 * changed are corrected", printed a valid envelope, exited 0, and left the
 * README asserting `chars 36` while the CLI it documents now prints 35. Seven
 * of nine deliverables shipped documentation that contradicted their own
 * artefact, and the gate could not see it.
 *
 * Kept to unambiguous mutating verbs: a subtask that only asks to RE-RUN or
 * CHECK something legitimately writes nothing, and rejecting that would send
 * healthy dispatches back to the LLM loop for no reason. Measured consequence,
 * and a load-bearing one: neither legitimate dispatch of rounds 6-7 matches a
 * mutating verb ("Re-execute", "Record", "Report"), so the path comparison
 * never even runs on them.
 *
 * Lives HERE rather than in lifecycle.ts so the capability test can use it
 * without an import cycle; lifecycle.ts re-exports it under its historical name.
 */
const MUTATING_VERB_RE =
  /\b(update|updating|rewrite|rewriting|edit|editing|correct|correcting|fix|fixing|amend|amending|revise|revising|write|writing|add|adding|append|appending|regenerate|regenerating)\b/i;

/** True when the subtask asks for a named file to be CHANGED, not merely read. */
export function subtaskMutatesFiles(description: string): boolean {
  return MUTATING_VERB_RE.test(description);
}

export interface ScriptWriteTargets {
  /** Basenames the body can be PROVEN to write. */
  readonly paths: ReadonlySet<string>;
  /** At least one write site whose destination could not be resolved statically. */
  readonly opaque: boolean;
}

/** Split a call's argument list on TOP-LEVEL commas, respecting strings. */
function splitArgs(src: string, openParen: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = openParen + 1;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(src.slice(start, i)); return args; }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null; // unbalanced — treat as unresolvable
}

/** Every string literal inside an expression, in source order. */
function literalsIn(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/(['"`])((?:[^\\\n]|\\.)*?)\1/g)) out.push(m[2] ?? '');
  return out;
}

/**
 * Resolve a destination expression to a basename, or null when it cannot be
 * proven. Handles the shapes the corpus actually uses: a literal, a template,
 * `path.join(cwd, 'x.json')` (the dominant one, 9 of 10 bodies), and a bare
 * identifier bound to any of those by a nearby declaration.
 */
function resolveDest(expr: string, body: string, depth = 0): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  const lits = literalsIn(trimmed);
  if (lits.length > 0) {
    // Last literal wins: `path.join(cwd, 'docs', 'INDEX.md')` names the file.
    for (const lit of [...lits].reverse()) {
      const base = path.basename(lit);
      if (NON_EMPTY_STEM_RE.test(base)) return base;
    }
    return null; // literals present but none is a filename → not provable
  }

  // Bare identifier: follow one binding, bounded.
  if (depth < 3 && /^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${trimmed}\\s*=\\s*([^;\\n]+)`).exec(body);
    if (decl?.[1]) return resolveDest(decl[1], body, depth + 1);
  }
  return null;
}

/** Path literals reachable as the DESTINATION argument of a write API. */
export function scriptWriteTargets(body: string): ScriptWriteTargets {
  const paths = new Set<string>();
  let opaque = false;
  for (const [name, destArg] of WRITE_APIS) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (const m of body.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const args = splitArgs(body, open);
      const dest = args?.[destArg];
      if (dest === undefined) { opaque = true; continue; }
      const resolved = resolveDest(dest, body);
      if (resolved) paths.add(resolved);
      else opaque = true;
    }
  }
  return { paths, opaque };
}

/**
 * Basenames the subtask names as files.
 *
 * Reuses `extractResultFilePaths` rather than re-deriving the rule, for the
 * reason this file's siblings keep re-learning: the DRIFT between two copies of
 * one rule IS the bug (`usedOrdinals`, `storeDbPath`). The deliverable gate
 * already calls the same extractor on the same text, so a bespoke second
 * extractor would let the MATCH decision and the DISPATCH decision disagree.
 * It also already encodes traps paid for at full price — the extension
 * allowlist, the letter-initial rule that stops `1.0.0` parsing as a file, and
 * the prose-token list. Passing only `summary` runs the conservative free-text
 * sweep alone. `basename` because a body commonly writes `path.join(cwd, 'x')`
 * where the subtask says `docs/x`; the extractor's 6-path cap can truncate,
 * which under-extracts, and under-extracting is the safe direction here.
 */
export function subtaskNamedPaths(description: string): string[] {
  return [...new Set(extractResultFilePaths({ summary: description }).map((p) => path.basename(p)))];
}

/**
 * Match-time capability test. `false` = do not offer this script for this
 * subtask.
 *
 * ALL, not ANY: one round-6 fallback named the probe manifest ALONGSIDE
 * `README.md` and `wclite.js`, so a non-empty intersection would have let the
 * verifier through on a subtask needing two files it can never write.
 * Measured over the 14 archived gate fallbacks of rounds 6-7: ALL refuses
 * 14/14, ANY 12/14, and neither touches the 2 legitimate dispatches.
 */
export function scriptCanServeSubtask(body: string, description: string): boolean {
  if (!subtaskMutatesFiles(description)) return true; // nothing to protect
  const named = subtaskNamedPaths(description);
  if (named.length === 0) return true; // no target named
  const { paths, opaque } = scriptWriteTargets(body);
  if (opaque) return true; // not provable
  return named.every((n) => paths.has(n));
}

