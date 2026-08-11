import { describe, it, expect } from 'vitest';
import { checkGroundTruth, extractQuotedSpans } from '../src/atoms/groundTruth.js';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { makeCtx } from './helpers.js';
import type { RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * QUOTED SPAN verification — the enabling half of the already-satisfied rule.
 *
 * Round 7 (benchmark/ROUND7.md): an earlier sequential phase applied a code
 * edit; a later phase, whose subtask text still said "apply ONE minimal edit",
 * correctly reported the work done and quoted the line. The validator rejected
 * it four more times. It was not short of evidence — every rejection carried a
 * ground-truth block — but the block renders a 400-char HEAD of each file and
 * the line at issue sat at byte 1000 of 1312, so the quote was uncorroborable
 * and a fabricated one would have read identically. Cost: $0.325/run averaged
 * over the round, three atom branches.
 *
 * The probe now checks quoted spans against the WHOLE file. The direction of
 * failure is the whole design: a false NOT-FOUND would invent a contradiction
 * on a correct deliverable, so anything uncertain stays SILENT.
 */

function tool(name: string): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

function fileChild(): L1Atom {
  return new L1Atom({
    name: 'Lithium',
    ordinal: 3,
    systemPrompt: 'sys',
    tools: [tool('write_file'), tool('read_file'), tool('list_files'), tool('run_shell')],
    params: {},
  });
}

class FsExecutor implements ToolExecutor {
  constructor(private readonly files: Record<string, string>) {}
  has(name: string): boolean {
    return ['read_file', 'list_files', 'write_file'].includes(name);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'read_file') {
      const p = String(args['path']);
      if (!(p in this.files)) throw new Error(`ENOENT: no such file "${p}"`);
      return { path: p, content: this.files[p] };
    }
    if (name === 'list_files') {
      return {
        path: '.',
        entries: Object.entries(this.files).map(([n, c]) => ({ name: n, kind: 'file', size: c.length })),
      };
    }
    return { ok: true };
  }
}

function ctxWith(files: Record<string, string>): RunContext {
  return { ...makeCtx(), tools: new FsExecutor(files) };
}

/** The real seed, and the same file after the round-7 edit. */
const EDIT = "const chars = text.replace(/\\n+$/, '').length;";
const PRE_EDIT = 'const chars = text.length;';
const PADDING = Array.from({ length: 40 }, (_, i) => `console.log('usage line ${i}');`).join('\n');
const EDITED_FILE = `#!/usr/bin/env node\n${PADDING}\n${EDIT}\nprocess.stdout.write(String(chars));\n`;
const UNEDITED_FILE = `#!/usr/bin/env node\n${PADDING}\n${PRE_EDIT}\nprocess.stdout.write(String(chars));\n`;

/** The quote shape the round-7 children actually emitted. */
function alreadySatisfiedResult(): unknown {
  return {
    output: { files: ['wclite.js'] },
    summary:
      'No edit needed — wclite.js already excludes trailing newlines.\n' +
      '== GROUND TRUTH ==\n' +
      `Line 42 of wclite.js:\n${EDIT}\n` +
      'All 6 documented invocations verified.',
  };
}

describe('extractQuotedSpans', () => {
  it('finds a span the RESULT attributes to a file', () => {
    const spans = extractQuotedSpans(alreadySatisfiedResult());
    const attributed = spans.filter((s) => s.path === 'wclite.js');
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed[0]!.span).toContain('text.replace');
  });

  it('does NOT corrupt a literal backslash-n inside the quoted code', () => {
    // The first draft stringified the payload then unescaped \\n → newline,
    // which cut this exact span in half: the code CONTAINS a literal \n.
    const spans = extractQuotedSpans(alreadySatisfiedResult());
    expect(spans.some((s) => s.span === EDIT)).toBe(true);
  });

  it('reads the summary even when output holds many strings', () => {
    // Measured: a payload whose `output` carried 45 strings pushed `summary`
    // past the walk budget, and the quote went unchecked on a run that had one.
    const noise = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${i}`, `filler string number ${i}`])
    );
    const spans = extractQuotedSpans({ output: noise, summary: `Line 42 of wclite.js:\n${EDIT}` });
    expect(spans.some((s) => s.span === EDIT)).toBe(true);
  });

  it('ignores a span too short to be evidence rather than coincidence', () => {
    expect(extractQuotedSpans({ summary: 'Line 1 of a.js:\nlet x = 1;' })).toHaveLength(0);
  });
});

describe('the QUOTED SPAN check in the read-back probe', () => {
  it('CORROBORATES a true quote — FOUND, and no contradiction', async () => {
    const res = await checkGroundTruth({
      ctx: ctxWith({ 'wclite.js': EDITED_FILE }),
      subject: 'RESULT',
      payload: alreadySatisfiedResult(),
      child: fileChild(),
    });
    expect(res.block).toContain('QUOTED SPAN');
    expect(res.block).toContain('FOUND in the current file');
    expect(res.contradiction).toBe(false);
  });

  it('CATCHES a fabricated quote — NOT FOUND sets a contradiction', async () => {
    // Same payload, unedited file: the child claims the work is already done
    // and quotes a line the file does not contain. Before the span check this
    // was indistinguishable from the truthful case above, and on a trusted
    // child the fast-path approved it with zero LLM calls.
    const res = await checkGroundTruth({
      ctx: ctxWith({ 'wclite.js': UNEDITED_FILE }),
      subject: 'RESULT',
      payload: alreadySatisfiedResult(),
      child: fileChild(),
    });
    expect(res.block).toContain('NOT FOUND');
    expect(res.contradiction).toBe(true);
  });

  it('is not fooled by the 400-char excerpt window — it reads the WHOLE file', async () => {
    // The quoted line sits far past FILE_PROBE_EXCERPT_CHARS, which is exactly
    // why the excerpt alone could never settle the round-7 dispute.
    expect(EDITED_FILE.indexOf(EDIT)).toBeGreaterThan(400);
    const res = await checkGroundTruth({
      ctx: ctxWith({ 'wclite.js': EDITED_FILE }),
      subject: 'RESULT',
      payload: alreadySatisfiedResult(),
      child: fileChild(),
    });
    expect(res.block).toContain('FOUND in the current file');
  });

  it('NEVER contradicts on a PROSE span attributed to a file', async () => {
    // Taken from a real round-7 payload: an attributed pattern matched the
    // prose after a label. It is absent from the file by construction, so
    // treating it as evidence would fail a correct deliverable.
    const res = await checkGroundTruth({
      ctx: ctxWith({ 'wclite.js': EDITED_FILE }),
      subject: 'RESULT',
      payload: {
        output: { files: ['wclite.js'] },
        summary: 'wclite.js line 21 verified: --chars: 35, --lines: 3, --words: 6, all working',
      },
      child: fileChild(),
    });
    expect(res.contradiction).toBe(false);
    expect(res.block).not.toContain('NOT FOUND');
  });

  it('stays SILENT about a span attributed to a file it could not read', async () => {
    const res = await checkGroundTruth({
      ctx: ctxWith({ 'other.js': EDITED_FILE }),
      subject: 'RESULT',
      payload: { output: { files: ['other.js'] }, summary: `Line 42 of ghost.js:\n${EDIT}` },
      child: fileChild(),
    });
    expect(res.contradiction).toBe(false);
  });

  it('tolerates re-indentation but not a different line', async () => {
    const reindented = { output: { files: ['wclite.js'] }, summary: `Line 42 of wclite.js:\n    ${EDIT}` };
    const ok = await checkGroundTruth({
      ctx: ctxWith({ 'wclite.js': EDITED_FILE }),
      subject: 'RESULT',
      payload: reindented,
      child: fileChild(),
    });
    expect(ok.contradiction).toBe(false);

    const wrong = { output: { files: ['wclite.js'] }, summary: 'Line 42 of wclite.js:\nconst chars = countGraphemes(text);' };
    const bad = await checkGroundTruth({
      ctx: ctxWith({ 'wclite.js': EDITED_FILE }),
      subject: 'RESULT',
      payload: wrong,
      child: fileChild(),
    });
    expect(bad.contradiction).toBe(true);
  });
});

describe('VALIDATION_SYSTEM_PROMPT — the already-satisfied rule', () => {
  it('states that an imperative subtask does not by itself refute a completed end state', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toContain('ALREADY-SATISFIED WORK IS COMPLIANCE');
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/IMPERATIVE/);
  });

  it('reconciles with the narration rule instead of silently contradicting it', () => {
    // The rejections it must overturn were the narration rule being applied.
    // A clause that never names the rule it qualifies loses to the older,
    // CRITICAL-marked, worked-example-anchored one.
    expect(VALIDATION_SYSTEM_PROMPT).toContain('does NOT relax the narration rule above');
  });

  it('keys approval on supervisor evidence, not on the child\'s own quote', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toContain('the child did not author');
    expect(VALIDATION_SYSTEM_PROMPT).toContain('QUOTED SPAN');
  });

  it('says a truncated excerpt is silent rather than refuting', () => {
    // One cascade head was a rejection for "the excerpt is truncated — cannot
    // verify the actual edit", on a correctly applied edit.
    expect(VALIDATION_SYSTEM_PROMPT).toContain('A TRUNCATED EXCERPT IS SILENT, NEVER REFUTING');
  });

  it('coaches toward record_probe, never toward quoting a specific string', () => {
    // additionalContext is injected verbatim into the retry, so asking for a
    // string coaches the next attempt to produce that string.
    expect(VALIDATION_SYSTEM_PROMPT).toContain('do NOT ask it to quote a specific string');
  });

  it('anchors the rule with worked examples in both directions', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toContain('Example 9 — RESULT, already-satisfied work, APPROVED');
    expect(VALIDATION_SYSTEM_PROMPT).toContain('Example 10 — RESULT, already-satisfied work, REJECTED');
  });

  it('extends the embedded-ground-truth exception to file and CLI children', () => {
    // GROUND_TRUTH_EVIDENCE_LINES makes the block MANDATORY for every non-web
    // L1, while the exception used to be written for HTTP children only — so a
    // CLI child obeying its own contract met a carve-out that did not cover it.
    expect(VALIDATION_SYSTEM_PROMPT).toContain('for file and CLI children as much as HTTP ones');
  });

  it('stays well above the Haiku prompt-cache threshold', () => {
    expect(VALIDATION_SYSTEM_PROMPT.length / 3.7).toBeGreaterThan(4200);
  });
});
