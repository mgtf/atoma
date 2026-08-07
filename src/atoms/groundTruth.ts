import type { RunContext } from '../core/types.js';
import type { Atom } from '../core/atom.js';
import {
  PROBE_MANIFEST_FILENAME,
  validateProbeManifest,
} from '../contracts/probeManifest.js';
import { extractRecordedProbes, type RecordedProbe } from '../contracts/witness.js';

/**
 * GROUND-TRUTH PROBES (P7 extraction — verbatim from L2Atom).
 * ===========================================================
 * The supervisor-side evidence machinery: render the child's recorded
 * probes, read claimed files back from the workspace, health-check the
 * probe manifest, and report whether the evidence CONTRADICTS the claims.
 * Zero LLM calls anywhere in this module — that is its entire point.
 * Behaviour-preserving move; the history lives in CLAUDE.md (#F9, #9,
 * the manifest health check, the two-probe mutual exclusion).
 */

/**
 * Ground-truth probe result. `contradiction` is set ONLY on hard, unambiguous
 * evidence that something the child CLAIMED does not exist:
 *   - file bucket: a claimed path is MISSING or EMPTY
 *   - web bucket: the URL could not be probed at all (unreachable)
 * Console errors / `ok: false` deliberately do NOT set it — those are judgment
 * calls that belong to the LLM validator, and tripping on them would make the
 * trust fast-path fire false alarms on working deliverables.
 *
 * Used by `checkGroundTruth`, which the trust fast-path consults before
 * rubber-stamping a trusted child (the probe costs no tokens, so there is no
 * reason for the cheapest path to be the blindest one).
 */
export interface GroundTruthCheck {
  readonly block: string;
  readonly contradiction: boolean;
}

/**
 * Render the recorded probes for the validator, and flag the ONLY two
 * mechanically unambiguous self-reported failures:
 *   - `match: false`
 *   - `expected` and `actual` both present and different
 * Nothing else is decided in code. In particular a non-zero `exitCode` is NOT
 * a failure — error-case probes are supposed to exit non-zero — and whether a
 * documented claim matches the record is a judgment left to the validator,
 * which now has both sides in front of it.
 */
function renderRecordedProbes(probes: RecordedProbe[]): {
  lines: string[];
  selfReportedFailure: boolean;
} {
  if (probes.length === 0) return { lines: [], selfReportedFailure: false };
  const lines: string[] = ['', "The child's OWN recorded probe outputs (from output.probes):"];
  let selfReportedFailure = false;
  for (const p of probes) {
    const mismatch =
      p.match === false ||
      (p.expected !== undefined && p.actual !== undefined && p.expected !== p.actual);
    if (mismatch) selfReportedFailure = true;
    const bits: string[] = [];
    if (p.exitCode !== undefined) bits.push(`exit=${p.exitCode}`);
    if (p.stdout !== undefined) bits.push(`stdout=${JSON.stringify(p.stdout.slice(0, 160))}`);
    if (p.expected !== undefined && p.actual !== undefined) {
      bits.push(
        `expected=${JSON.stringify(p.expected.slice(0, 80))} actual=${JSON.stringify(p.actual.slice(0, 80))}`
      );
    }
    if (p.note) bits.push(`note=${JSON.stringify(p.note.slice(0, 80))}`);
    lines.push(
      `- ${JSON.stringify(p.cmd.slice(0, 120))}: ${bits.join(', ') || '(no outcome recorded)'}` +
        (mismatch ? '  <-- SELF-REPORTED MISMATCH' : '')
    );
  }
  lines.push(
    'Cross-check the read-back file contents against these records: a claim',
    'documented in a file that the child\'s own probe output contradicts (e.g. a',
    'documented exit code that differs from the recorded one) is a CONTRADICTION.'
  );
  return { lines, selfReportedFailure };
}

/**
 * STRUCTURED FACTS from the probes (audit: the contradiction decision used
 * to re-parse, via regex, marker strings the probes themselves had rendered
 * — any wording edit silently disarmed the check). The probes now RETURN
 * what they observed; the rendered block is for the validator's eyes only.
 */
export interface GroundTruthFacts {
  /** Structured claims whose read-back failed (path missing/unreadable). */
  missingOrUnreadable: string[];
  /** Structured claims that read back EMPTY. */
  emptyClaimedFiles: string[];
  /** The web re-validation tool call itself failed (URL unreachable…). */
  probeToolFailure: boolean;
  /** The child's own probe record contains a mismatch. */
  selfReportedMismatch: boolean;
}

export function emptyGroundTruthFacts(): GroundTruthFacts {
  return {
    missingOrUnreadable: [],
    emptyClaimedFiles: [],
    probeToolFailure: false,
    selfReportedMismatch: false,
  };
}

/**
 * Probe wrapper that reports whether the evidence CONTRADICTS the child's
 * claims, not just what the evidence says. See `GroundTruthCheck`.
 */
export async function checkGroundTruth(args: {
  ctx: RunContext;
  subject: 'PLAN' | 'RESULT';
  payload: unknown;
  child: Atom;
}): Promise<GroundTruthCheck> {
  const { block, facts } = await probeGroundTruthEx(args);
  if (!block) return { block: '', contradiction: false };
  // Decided from the probes' STRUCTURED facts — never by re-parsing the
  // rendered block (a wording edit used to silently disarm this check).
  const contradiction =
    facts.missingOrUnreadable.length > 0 ||
    facts.emptyClaimedFiles.length > 0 ||
    facts.probeToolFailure ||
    // The child's own probe record says an expectation did not hold. Nothing
    // read this before, so a self-reported mismatch could sail through the
    // trust fast-path unexamined.
    facts.selfReportedMismatch;
  return { block, contradiction };
}

/** Compat wrapper: the rendered block only (llmVerdict's evidence input). */
export async function probeGroundTruth(
  args: Parameters<typeof probeGroundTruthEx>[0]
): Promise<string> {
  return (await probeGroundTruthEx(args)).block;
}

export async function probeGroundTruthEx(args: {
  ctx: RunContext;
  subject: 'PLAN' | 'RESULT';
  payload: unknown;
  /**
   * The child atom whose RESULT we are validating. We inspect its
   * declared tool names to decide whether a validate_html ground-truth
   * probe even makes sense: an HTTP-bucket L1 produces a JSON REST API
   * URL, and running Puppeteer against it returns "errors" that the
   * supervisor then (incorrectly) treats as a child failure. The probe
   * is a web-bucket invariant, not a universal one — #9.
   */
  child: import('../core/atom.js').Atom;
}): Promise<{ block: string; facts: GroundTruthFacts }> {
  const empty = { block: '', facts: emptyGroundTruthFacts() };
  if (args.subject !== 'RESULT') return empty;
  if (args.ctx.signal?.aborted) return empty;
  const tools = args.ctx.tools;
  if (!tools) return empty;
  // Bucket dispatch. The two probes are MUTUALLY EXCLUSIVE: a child that
  // declares validate_html gets the web load-and-look probe below; every
  // other file-producing child gets the read-back probe (#F9). Running both
  // would double the cost and, for a non-web artefact, add Puppeteer noise
  // the validator reads as contradiction.
  if (!tools.has('validate_html') || !args.child.toolNames().includes('validate_html')) {
    return probeFilesGroundTruth(args);
  }
  // (Bucket gate handled by the dispatch above: reaching here means BOTH the
  // context and the child declare validate_html, so this really is a web
  // artefact. The gate exists because Helium — HTTP-scope — once returned a
  // bound API URL, the supervisor ran Puppeteer against the JSON endpoint,
  // read the errors as a contradiction, and cascaded into escalations.)
  const url = extractResultUrl(args.payload);
  if (!url) return empty;

  try {
    // Minimal load-and-look probe: no interactions, no smoke. The goal is
    // "does this URL load cleanly?", not "does gameplay work?". Invented
    // interactions could false-positive-fail a working deliverable; the
    // clean-load bar is conservative.
    const raw = await tools.execute('validate_html', { url, waitMs: 1500 });
    const summary = summarizeValidateHtml(raw);
    return {
      block: [
        '',
        '== GROUND-TRUTH EVIDENCE (independent re-validation) ==',
        `Supervisor independently re-ran validate_html on ${url}.`,
        'This is OBJECTIVE evidence — weight it above the child\'s self-reported claims.',
        'If this evidence contradicts the child\'s RESULT, REJECT the verdict.',
        summary,
      ].join('\n'),
      facts: emptyGroundTruthFacts(),
    };
  } catch (err) {
    // Probe failures are themselves signal (e.g. URL unreachable → the
    // child's deliverable isn't actually running). Surface, don't swallow.
    return {
      block: [
        '',
        '== GROUND-TRUTH EVIDENCE (independent re-validation) ==',
        `Supervisor tried to re-run validate_html on ${url} but the tool call failed:`,
        `  ${(err as Error).message}`,
        'This strongly suggests the child\'s deliverable is not actually running.',
      ].join('\n'),
      facts: { ...emptyGroundTruthFacts(), probeToolFailure: true },
    };
  }
}

/** Max files the read-back probe will open, and per-file excerpt budget. */
const FILE_PROBE_MAX_FILES = 6;
const FILE_PROBE_EXCERPT_CHARS = 400;

/**
 * File extensions the FREE-TEXT sweep will accept. A closed allowlist, not a
 * shape heuristic, because dotted identifiers are everywhere in these
 * summaries and any "looks like name.ext" rule swallows them: the slug-cli
 * run had `bin.main` and `scripts.start` — package.json KEY PATHS — read as
 * filenames, reported MISSING, and that false contradiction overrode the
 * trust fast-path on a perfectly good result. Since dotted keys are ubiquitous
 * (`scripts.start`, `engines.node`, `dependencies.express`), a loose rule
 * would defeat the fast-path systematically, which is the project's central
 * saving. Failing the other way is safe: an unusual real extension just means
 * the probe gathers less evidence, never a phantom contradiction.
 */
const PROBEABLE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md', 'markdown', 'txt',
  'html', 'htm', 'css', 'scss', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'sh', 'bash', 'py', 'rb', 'sql', 'csv', 'tsv', 'xml', 'svg', 'lock',
]);

/**
 * Runtime and library names that are structurally indistinguishable from
 * filenames (`Node.js` has the same shape as `README.md`) and appear
 * constantly in summaries and READMEs. Measured over 85 recorded runs:
 * `Node.js` was the single most frequent prose "path" at 40 payloads, twice
 * the next entry, and every hit was noise. Prose mentions are advisory so
 * these never caused a false verdict, but skipping them saves a pointless
 * read attempt and keeps a probe slot for a real file.
 */
const NON_FILE_PROSE_TOKENS = new Set([
  'node.js', 'next.js', 'nuxt.js', 'vue.js', 'three.js', 'd3.js', 'express.js',
  'react.js', 'angular.js', 'jquery.js', 'socket.io',
]);

/**
 * Extract the workspace-relative file paths a RESULT claims to have produced.
 * Mirrors `extractResultUrl`'s tolerance: structured fields first, then a
 * constrained free-text scan of `output` / `summary`.
 *
 * Two tiers of trust, deliberately different:
 *   - STRUCTURED fields (`output.path`, `output.files[]`, …) are explicit
 *     claims by the child, so any plausible extension is probed.
 *   - FREE TEXT is a guess we are making on its behalf, so it must clear
 *     `PROBEABLE_EXTENSIONS`. The extension must also start with a letter, or
 *     version strings like "1.0.0" parse as filenames.
 *
 * Absolute paths and `..` segments are dropped here rather than left for
 * `sandbox.resolve` to throw on: a path escaping the workspace is not
 * evidence about the deliverable, it is noise.
 *
 * Exported for tests.
 */
export function extractResultFilePaths(payload: unknown): string[] {
  const claims = extractResultFileClaims(payload);
  return [...claims.structured, ...claims.mentioned].slice(0, FILE_PROBE_MAX_FILES);
}

/**
 * File paths a RESULT refers to, split by how much they can be trusted as an
 * EXISTENCE CLAIM:
 *
 *   - `structured` — the child put the path in a dedicated field
 *     (`output.files[]`, `output.path`, `output.readme_path`, …). That is an
 *     explicit assertion that the file was produced, so a miss here is a real
 *     contradiction.
 *   - `mentioned` — the path only appears in prose. Prose is semantically
 *     blind: it cannot tell "the file I wrote" from "the file I confirm is
 *     GONE". The pad-cli run proved the cost of ignoring that distinction —
 *     the child correctly reported "no scaffolding files
 *     (_skill_document-cli-from-source.js) present" (F3 working as designed),
 *     the sweep read that as a claim of existence, and the phantom miss
 *     overrode the trust fast-path on a flawless result.
 *
 * The probe therefore reports mentioned paths only when they EXIST (as
 * corroboration) and never lets them signal a contradiction. `list_files`
 * already covers the "what is actually in the workspace" question, which is
 * the real defence against stray files.
 *
 * `_skill_*` scaffolding is excluded outright: it is framework-generated, and
 * its ABSENCE is the desired end state (see `removeScratchScript`).
 */
export function extractResultFileClaims(payload: unknown): {
  structured: string[];
  mentioned: string[];
} {
  const structured: string[] = [];
  const mentioned: string[] = [];
  const accept = (v: unknown, into: string[], requireKnownExt: boolean): void => {
    if (typeof v !== 'string') return;
    const p = v.trim();
    if (!p || p.startsWith('/') || p.includes('..') || /^https?:\/\//i.test(p)) return;
    // A candidate containing whitespace is a COMMAND, not a path. Observed
    // (labels run, 2026-08-07): a structured entry field carried
    // 'node server.js', the probe read a file literally named that, and the
    // ENOENT rendered as 'MISSING or unreadable' — a fabricated
    // contradiction the validator is TOLD to reject on. Under-extraction is
    // the safe direction: the real file was independently probed via the
    // prose sweep, and list_files covers the workspace either way.
    if (/\s/.test(p)) return;
    if (/(^|\/)_skill_/.test(p)) return;
    const m = p.match(/\.([A-Za-z][A-Za-z0-9]{0,8})$/);
    if (!m) return;
    if (requireKnownExt) {
      if (!PROBEABLE_EXTENSIONS.has(m[1]!.toLowerCase())) return;
      if (NON_FILE_PROSE_TOKENS.has(p.toLowerCase())) return;
      // URL leftovers: the sweep runs after the scheme is gone, so
      // "http://localhost:8000/index.html" surfaces as "8000/index.html".
      // A leading all-digits segment is never a real workspace path.
      if (/^\d+\//.test(p)) return;
    }
    if (structured.includes(p) || mentioned.includes(p)) return;
    into.push(p);
  };
  const claim = (v: unknown): void => accept(v, structured, false);
  const mention = (v: unknown): void => accept(v, mentioned, true);

  if (!payload || typeof payload !== 'object') return { structured, mentioned };
  const obj = payload as Record<string, unknown>;
  const output = obj['output'];

  // STRUCTURED: dedicated fields. Any plausible extension is accepted here
  // because the child chose to put the path in a field, not in a sentence.
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const o = output as Record<string, unknown>;
    for (const key of ['paths', 'files', 'written']) {
      const arr = o[key];
      if (Array.isArray(arr)) for (const item of arr) claim(item);
    }
    // Any string field whose NAME advertises a path (`path`, `entry`,
    // `readme_path`, `output_file`, …). Observed in the wild: `readme_path`.
    for (const [key, value] of Object.entries(o)) {
      if (typeof value !== 'string') continue;
      if (/(^|_)(path|file|entry)s?$/i.test(key)) claim(value);
    }
  }
  if (Array.isArray(output)) for (const item of output) claim(item);
  claim(obj['path']);
  claim(output);

  // MENTIONED: prose sweep. Informational only — never a contradiction.
  const freeText: string[] = [];
  if (typeof output === 'string') freeText.push(output);
  if (typeof obj['summary'] === 'string') freeText.push(obj['summary'] as string);
  for (const text of freeText) {
    for (const m of text.matchAll(/[\w./-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,8}\b/g)) {
      mention(m[0]);
      if (structured.length + mentioned.length >= FILE_PROBE_MAX_FILES) break;
    }
  }
  const room = Math.max(0, FILE_PROBE_MAX_FILES - structured.length);
  return {
    structured: structured.slice(0, FILE_PROBE_MAX_FILES),
    mentioned: mentioned.slice(0, room),
  };
}

/**
 * #F9 — supervisor-side READ-BACK probe for file-producing children.
 *
 * Why it exists: `probeGroundTruth`'s web probe returns '' for any child that
 * does not declare `validate_html`, so a file-scribe L1's RESULT was judged on
 * SELF-REPORTING alone. Two failure modes followed from that. A child could
 * under-report its evidence and be rejected for it (costing a full supervise
 * cycle even though the deliverable was correct), and — worse — a FABRICATED
 * claim could pass every validator: on run 2026-07-25T22-10-42 a README
 * asserted a Node version requirement that drifted 10.0.0 → 14.0.0 → 12.0
 * across cycles while `package.json` had no `engines` field at all, and three
 * validators approved it.
 *
 * The probe reads the workspace back itself and hands the validator facts
 * instead of narration: which claimed paths exist, their real sizes, a bounded
 * excerpt of each, plus a `list_files` of the root (which also surfaces debris
 * the deliverable should not contain). It needs no prompt cooperation from the
 * child and no LLM call — only local fs tool calls.
 *
 * Deliberately conservative: it reports, and tells the validator to reject
 * only on a CONTRADICTION (claimed-but-missing, claimed-but-empty). A file
 * being smaller or differently worded than described is not grounds to fail —
 * that framing is what kept the web probe from producing false rejections.
 */

async function probeFilesGroundTruth(args: {
  ctx: RunContext;
  payload: unknown;
  child: import('../core/atom.js').Atom;
}): Promise<{ block: string; facts: GroundTruthFacts }> {
  const empty = { block: '', facts: emptyGroundTruthFacts() };
  const facts = emptyGroundTruthFacts();
  const tools = args.ctx.tools;
  if (!tools || !tools.has('read_file')) return empty;
  // Only for children that actually write files — otherwise there is nothing
  // to read back and the probe would just add an empty evidence block.
  if (!args.child.toolNames().includes('write_file')) return empty;
  const claims = extractResultFileClaims(args.payload);
  const recorded = renderRecordedProbes(extractRecordedProbes(args.payload));
  facts.selfReportedMismatch = recorded.selfReportedFailure;
  if (
    claims.structured.length === 0 &&
    claims.mentioned.length === 0 &&
    recorded.lines.length === 0
  ) {
    return empty;
  }

  const lines: string[] = [];
  // Manifest health check — it is the interface later compiled verifiers
  // depend on, and nothing else audits it (written by prompt, read by
  // script). GATED on the child having reported probes: only then is a
  // manifest expected, so a plain file-scribe deliverable pays no extra
  // tool call (the exact-call-count assertions in the #F9 tests are a
  // deliberate cost guard — respect them).
  // GATE (cost guard): plain file-scribe deliverables must not pay an
  // extra tool call — the #F9 tests pin their exact call counts. But the
  // recorded-probes trigger alone was DEAD CODE for the HTTP bucket:
  // extractRecordedProbes requires a `cmd` field, and HTTP children
  // record {method, path, status} probes — so the one family that WRITES
  // http manifests never had them health-checked. An HTTP-tooled child
  // is expected to leave a manifest; check it for them too.
  const httpChild = ['fetch_url', 'start_node_server'].some((t) =>
    args.child.toolNames().includes(t)
  );
  if (recorded.lines.length > 0 || httpChild) try {
    const rawManifest = await tools.execute('read_file', { path: PROBE_MANIFEST_FILENAME });
    const text =
      rawManifest && typeof rawManifest === 'object' && typeof (rawManifest as Record<string, unknown>)['content'] === 'string'
        ? ((rawManifest as Record<string, unknown>)['content'] as string)
        : typeof rawManifest === 'string'
          ? rawManifest
          : '';
    if (text.trim().length > 0) {
      const problems = validateProbeManifest(text);
      lines.push(
        problems.length === 0
          ? `${PROBE_MANIFEST_FILENAME}: well-formed (machine-readable probe record present)`
          : `${PROBE_MANIFEST_FILENAME}: MALFORMED — ${problems.slice(0, 4).join('; ')}`
      );
    }
  } catch {
    // Absent manifest is normal for non-runnable deliverables — say nothing.
  }
  for (const [path, isClaim] of [
    ...claims.structured.map((p) => [p, true] as const),
    ...claims.mentioned.map((p) => [p, false] as const),
  ]) {
    if (args.ctx.signal?.aborted) return empty;
    try {
      const raw = await tools.execute('read_file', { path });
      const content =
        raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['content'] === 'string'
          ? ((raw as Record<string, unknown>)['content'] as string)
          : typeof raw === 'string'
            ? raw
            : JSON.stringify(raw);
      const excerpt = content.slice(0, FILE_PROBE_EXCERPT_CHARS);
      if (content.trim().length === 0 && isClaim) facts.emptyClaimedFiles.push(path);
      lines.push(
        `- ${path}: EXISTS (${content.length} chars)` +
          (content.trim().length === 0 && isClaim ? ' — WARNING: file is EMPTY' : '') +
          `\n    excerpt: ${JSON.stringify(excerpt)}${content.length > excerpt.length ? ' …(truncated)' : ''}`
      );
    } catch (err) {
      // A miss is only reportable for a STRUCTURED claim. A prose mention that
      // does not resolve is usually the child saying a file is absent — which
      // is often the DESIRED state — so reporting it would invent a
      // contradiction out of a correct statement.
      if (isClaim) {
        facts.missingOrUnreadable.push(path);
        lines.push(`- ${path}: MISSING or unreadable (${(err as Error).message})`);
      }
    }
  }
  if (lines.length === 0 && recorded.lines.length === 0) return empty;

  let listing = '';
  if (tools.has('list_files') && !args.ctx.signal?.aborted) {
    try {
      const raw = (await tools.execute('list_files', { path: '.' })) as {
        entries?: Array<{ name?: string; kind?: string; size?: number }>;
      } | null;
      const entries = Array.isArray(raw?.entries) ? raw!.entries! : [];
      listing = entries
        .map((e) => `${e.name}${e.kind === 'dir' ? '/' : ''} (${e.size ?? '?'}b)`)
        .join(', ');
    } catch {
      /* listing is a bonus, not a requirement */
    }
  }

  const block = [
    '',
    '== GROUND-TRUTH EVIDENCE (independent file read-back) ==',
    'The supervisor re-read the workspace itself. This is OBJECTIVE evidence —',
    "weight it above the child's self-reported claims.",
    ...lines,
    listing ? `workspace root now contains: ${listing}` : '',
    ...recorded.lines,
    '',
    'REJECT only on a CONTRADICTION with this evidence — a file the RESULT',
    'claims but which is MISSING or EMPTY, a documented statement the excerpts',
    'or the recorded probe outputs refute, or a SELF-REPORTED MISMATCH above.',
    'Do NOT reject merely because an excerpt is truncated here, or because the',
    'child described a file more briefly than its contents.',
  ]
    .filter(Boolean)
    .join('\n');
  return { block, facts };
}

function summarizeValidateHtml(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return `result: ${JSON.stringify(raw)}`;
  const r = raw as Record<string, unknown>;
  const ok = r['ok'];
  const errors = Array.isArray(r['errors']) ? (r['errors'] as unknown[]) : [];
  const failedRequests = Array.isArray(r['failedRequests'])
    ? (r['failedRequests'] as unknown[])
    : [];
  const lines = [
    `ok: ${ok === true ? 'true' : 'false'}`,
    `consoleErrors: ${errors.length}`,
    `failedRequests: ${failedRequests.length}`,
  ];
  if (errors.length > 0) {
    lines.push(`errors: ${JSON.stringify(errors.slice(0, 5))}`);
  }
  if (failedRequests.length > 0) {
    lines.push(`failedRequests: ${JSON.stringify(failedRequests.slice(0, 5))}`);
  }
  return lines.join('\n');
}

/**
 * Extract a URL to probe from a RESULT payload. We check, in order:
 *   1. `output.url` — the canonical structured shape
 *   2. top-level `url`
 *   3. `output` as a bare URL string (the shape Haiku most often emits:
 *      `{"output":"http://localhost:8000/index.html","summary":"…"}`)
 *   4. any `http(s)://` URL embedded in `output` or `summary` as free text
 *      (regex scan — last-resort so we still auto-probe when the model
 *      narrates "the server is running at http://…" inside the summary).
 *
 * Earlier builds missed (3) and (4), which meant the ground-truth probe
 * never fired on WebGL Minesweeper runs — every RESULT verdict rejected for
 * "no GROUND-TRUTH EVIDENCE block" even though the L1 had just passed
 * validate_html. That false-negative loop burned the 10-minute deadline.
 */
export function extractResultUrl(payload: unknown): string | null {
  const urlRe = /^https?:\/\//i;
  if (typeof payload === 'string' && urlRe.test(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const output = obj['output'];
  if (output && typeof output === 'object') {
    const u = (output as Record<string, unknown>)['url'];
    if (typeof u === 'string' && urlRe.test(u)) return u;
  }

  const topLevel = obj['url'];
  if (typeof topLevel === 'string' && urlRe.test(topLevel)) return topLevel;

  if (typeof output === 'string' && urlRe.test(output)) return output;

  // Free-text fallback: scan `output` (if string) and `summary` for the
  // first http(s) URL. Stops at whitespace, quotes, or angle brackets —
  // conservative enough not to grab trailing punctuation.
  const freeTextRe = /https?:\/\/[^\s"'<>)]+/i;
  const candidates: string[] = [];
  if (typeof output === 'string') candidates.push(output);
  const summary = obj['summary'];
  if (typeof summary === 'string') candidates.push(summary);
  for (const s of candidates) {
    const m = s.match(freeTextRe);
    if (m && m[0]) return m[0];
  }
  return null;
}
