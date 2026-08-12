import { describe, it, expect } from 'vitest';
import {
  llmVerdict,
  extractResultFilePaths,
  extractResultFileClaims,
  extractRecordedProbes,
  checkGroundTruth,
} from '../src/atoms/L2Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { makeCtx, jsonText } from './helpers.js';
import type { RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * Tests for #F9 — the supervisor-side FILE READ-BACK probe.
 *
 * The web probe returns '' for any child that does not declare validate_html,
 * so a file-scribe L1's RESULT used to be judged on SELF-REPORTING alone. Two
 * failures followed: a child that under-reported its evidence got rejected
 * for it (a wasted supervise cycle on a correct deliverable), and a FABRICATED
 * claim could pass every validator — on run 2026-07-25T22-10-42 a README
 * asserted a Node version requirement that drifted 10.0.0 → 14.0.0 → 12.0
 * while package.json had no `engines` field, approved three times.
 */

function tool(name: string): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

/** File-bucket child: writes/reads files, NO validate_html. */
function fileChild(): L1Atom {
  return new L1Atom({
    name: 'Lithium',
    ordinal: 3,
    systemPrompt: 'sys',
    tools: [tool('write_file'), tool('read_file'), tool('list_files'), tool('run_shell')],
    params: {},
  });
}

/** Web-bucket child: the existing validate_html probe owns this one. */
function webChild(): L1Atom {
  return new L1Atom({
    name: 'Hydrogen',
    ordinal: 1,
    systemPrompt: 'sys',
    tools: [tool('write_file'), tool('validate_html')],
    params: {},
  });
}

function httpChild(): L1Atom {
  return new L1Atom({
    name: 'Helium',
    ordinal: 2,
    systemPrompt: 'sys',
    tools: [
      tool('write_file'),
      tool('read_file'),
      tool('list_files'),
      tool('fetch_url'),
      tool('start_node_server'),
    ],
    params: {},
  });
}

class FsExecutor implements ToolExecutor {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    private readonly files: Record<string, string>,
    private readonly available = ['read_file', 'list_files', 'write_file']
  ) {}
  has(name: string): boolean {
    return this.available.includes(name);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'read_file') {
      const p = String(args['path']);
      if (!(p in this.files)) throw new Error(`ENOENT: no such file "${p}"`);
      return { path: p, content: this.files[p] };
    }
    if (name === 'list_files') {
      return {
        path: '.',
        entries: Object.entries(this.files).map(([n, c]) => ({
          name: n,
          kind: 'file',
          size: c.length,
        })),
      };
    }
    return { ok: true };
  }
}

function ctxWith(executor: ToolExecutor): RunContext & { llm: ReturnType<typeof makeCtx>['llm'] } {
  const base = makeCtx();
  return { ...base, tools: executor };
}

async function runVerdict(
  ctx: ReturnType<typeof ctxWith>,
  child: L1Atom,
  payload: unknown
): Promise<string> {
  ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
  await llmVerdict({
    ctx,
    model: 'claude-haiku-test',
    supervisorName: 'Ammonia',
    supervisorTier: 2,
    subject: 'RESULT',
    child,
    task: { description: 'write the three project files' },
    payload,
  });
  return ctx.llm.calls[0]!.userContent;
}

describe('extractResultFilePaths', () => {
  it('picks up structured fields (path, entry, paths[], files[])', () => {
    expect(extractResultFilePaths({ output: { path: 'README.md' } })).toEqual(['README.md']);
    expect(extractResultFilePaths({ output: { entry: 'index.js' } })).toEqual(['index.js']);
    expect(
      extractResultFilePaths({ output: { files: ['a.js', 'nested/b.json'] } })
    ).toEqual(['a.js', 'nested/b.json']);
  });

  it('a COMMAND in a path-flavoured field is not a file claim (whitespace guard)', () => {
    // Observed live (labels run, 2026-08-07): a structured entry field
    // carried 'node server.js'; the probe read a file literally named that,
    // and the ENOENT rendered as a fabricated MISSING contradiction — the
    // validator (correctly, per its framing) rejected a flawless deliverable.
    expect(extractResultFilePaths({ output: { entry: 'node server.js' } })).toEqual([]);
    expect(
      extractResultFilePaths({ output: { path: 'npm start -- fixtures/valid.env' } })
    ).toEqual([]);
    // The real file still surfaces through the prose sweep.
    const paths = extractResultFilePaths({
      output: { entry: 'node server.js' },
      summary: 'entry point server.js verified',
    });
    expect(paths).toEqual(['server.js']);
  });

  it('sweeps free text in output and summary', () => {
    const paths = extractResultFilePaths({
      output: 'wrote the files',
      summary: 'created package.json and index.js, then ran cat README.md',
    });
    expect(paths).toContain('package.json');
    expect(paths).toContain('index.js');
    expect(paths).toContain('README.md');
  });

  it('does NOT mistake version strings for filenames (regression)', () => {
    // `1.0.0` matches a naive [\w.]+\.\w+ filename regex; requiring the
    // extension to start with a LETTER keeps phantom "missing file" reports
    // out of the evidence block.
    const paths = extractResultFilePaths({
      output: 'ok',
      summary: 'package.json declares version 1.0.0 and node 18.2.1',
    });
    expect(paths).toEqual(['package.json']);
  });

  it('does NOT mistake dotted JSON key paths for filenames (slug-cli regression)', () => {
    // Real payload shape from the slug-cli run: the summary described the
    // package.json structure, and `bin.main` / `scripts.start` were extracted
    // as filenames, reported MISSING, and that false contradiction overrode
    // the trust fast-path on a perfectly good result. Dotted keys are
    // ubiquitous in these summaries, so a "looks like name.ext" rule would
    // defeat the fast-path systematically.
    const paths = extractResultFilePaths({
      output: { files: ['package.json', 'index.js'] },
      summary:
        'package.json declares bin.main -> index.js and scripts.start -> node index.js; ' +
        'engines.node is unset; dependencies.express absent. Wrote README.md too.',
    });
    expect(paths).not.toContain('bin.main');
    expect(paths).not.toContain('scripts.start');
    expect(paths).not.toContain('engines.node');
    expect(paths).not.toContain('dependencies.express');
    // …while the genuine files still come through.
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'index.js', 'README.md']));
  });

  it('still probes an unusual extension when the child claims it STRUCTURALLY', () => {
    // Two tiers of trust: an explicit structured claim is probed whatever the
    // extension; only the free-text guess needs the allowlist.
    expect(extractResultFilePaths({ output: { path: 'report.xyz' } })).toEqual(['report.xyz']);
    expect(
      extractResultFilePaths({ output: 'ok', summary: 'wrote report.xyz' })
    ).toEqual([]);
  });

  it('drops absolute paths, parent traversals and URLs', () => {
    const paths = extractResultFilePaths({
      output: { files: ['/etc/passwd', '../outside.txt', 'http://localhost:8000/x.html'] },
    });
    expect(paths).toEqual([]);
  });

  it('separates STRUCTURED claims from prose MENTIONS (pad-cli regression)', () => {
    // Exact shape from the pad-cli run. The child correctly reported that it
    // had cleaned up its scaffolding — "no _skill_*.js present" — and the old
    // sweep read that as a claim of EXISTENCE, then flagged the (desired)
    // absence as a contradiction, overriding the trust fast-path on a flawless
    // result. Prose cannot distinguish "file I wrote" from "file I confirm is
    // gone", so it may never signal a contradiction.
    const claims = extractResultFileClaims({
      output: {
        files: ['package.json', 'index.js', 'README.md'],
        readme_path: 'README.md',
        file_count: 3,
      },
      summary:
        'README.md created. No scaffolding files (_skill_document-cli-from-source.js or similar) present.',
    });
    expect(claims.structured).toEqual(['package.json', 'index.js', 'README.md']);
    // `_skill_*` is framework scaffolding whose absence is the goal — never probed.
    expect(claims.mentioned).not.toContain('_skill_document-cli-from-source.js');
    expect(claims.structured).not.toContain('_skill_document-cli-from-source.js');
  });

  it('skips runtime/library names and URL leftovers in prose (measured noise)', () => {
    // Replaying 85 recorded runs through the extractor: "Node.js" was the most
    // frequent prose "path" at 40 payloads — twice the next entry — and
    // "8000/index.html" (a scheme-stripped localhost URL) appeared 13 times.
    // Both are pure noise. They never caused a false verdict (prose is
    // advisory) but they burned a read attempt and a probe slot.
    const claims = extractResultFileClaims({
      output: 'ok',
      summary:
        'Requires Node.js >= 12. Served at http://localhost:8000/index.html. Wrote README.md.',
    });
    expect(claims.mentioned).not.toContain('Node.js');
    expect(claims.mentioned).not.toContain('8000/index.html');
    expect(claims.mentioned).toContain('README.md');
  });

  it('picks up path-advertising field NAMES like readme_path', () => {
    const claims = extractResultFileClaims({ output: { readme_path: 'docs/GUIDE.md' } });
    expect(claims.structured).toEqual(['docs/GUIDE.md']);
  });

  it('caps the number of probed files', () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    expect(extractResultFilePaths({ output: { files: many } }).length).toBeLessThanOrEqual(6);
  });

  it('returns nothing for payloads that name no files', () => {
    expect(extractResultFilePaths({ output: 'done', summary: 'all good' })).toEqual([]);
    expect(extractResultFilePaths(null)).toEqual([]);
  });
});

describe('recorded probe records (evidence format, no execution)', () => {
  it('normalises the shapes children already emit spontaneously', () => {
    // `examples_verified` with snake_case expected/actual is the real shape
    // from the pad-cli run — formalising `probes` in the prompt must not
    // invalidate what children were already producing.
    const probes = extractRecordedProbes({
      output: {
        examples_verified: [
          { cmd: 'node index.js 10 "hi"', expected_stdout: 'hi        \n', actual_stdout: 'hi        \n', match: true },
        ],
      },
    });
    expect(probes).toHaveLength(1);
    expect(probes[0]!.cmd).toBe('node index.js 10 "hi"');
    expect(probes[0]!.expected).toBe('hi        \n');
    expect(probes[0]!.match).toBe(true);
  });

  it('reads the documented `probes` shape including exit codes', () => {
    const probes = extractRecordedProbes({
      output: {
        probes: [
          { cmd: 'node index.js', exitCode: 1, stdout: 'Usage: pad-cli', note: 'missing-args' },
        ],
      },
    });
    expect(probes[0]!.exitCode).toBe(1);
    expect(probes[0]!.note).toBe('missing-args');
  });

  it('returns nothing when the payload carries no record', () => {
    expect(extractRecordedProbes({ output: { files: ['a.js'] } })).toEqual([]);
    expect(extractRecordedProbes(null)).toEqual([]);
  });
});

describe('file read-back probe (#F9)', () => {
  it('injects real sizes and excerpts for the files the RESULT claims', async () => {
    const exec = new FsExecutor({
      'package.json': '{"name":"temp-cli","version":"1.0.0"}',
      'index.js': 'console.log("hi")',
      'README.md': '# temp-cli\n\n## Install\n\n## Usage\n',
    });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: { files: ['package.json', 'index.js', 'README.md'] },
      summary: 'wrote three files',
    });

    expect(content).toMatch(/GROUND-TRUTH EVIDENCE \(independent file read-back\)/);
    // Real sizes, read from the workspace — not the child's word for it.
    expect(content).toMatch(/package\.json: EXISTS \(\d+ chars\)/);
    expect(content).toMatch(/index\.js: EXISTS \(17 chars\)/);
    expect(content).toMatch(/## Usage/); // excerpt made it in
    expect(content).toMatch(/workspace root now contains:/);
    // The probe read each claimed file back itself.
    expect(exec.calls.filter((c) => c.name === 'read_file')).toHaveLength(3);
  });

  it('flags a claimed-but-MISSING file as a contradiction', async () => {
    const exec = new FsExecutor({ 'index.js': 'x' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: { files: ['index.js', 'README.md'] },
      summary: 'wrote both files',
    });
    expect(content).toMatch(/README\.md: MISSING or unreadable/);
    expect(content).toMatch(/REJECT only on a CONTRADICTION/);
  });

  it('flags a claimed-but-EMPTY file', async () => {
    const exec = new FsExecutor({ 'README.md': '   \n' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: { path: 'README.md' },
      summary: 'documented everything',
    });
    expect(content).toMatch(/README\.md: EXISTS.*WARNING: file is EMPTY/s);
  });

  it('does not call an intentional empty negative-test fixture a broken deliverable', async () => {
    const exec = new FsExecutor({ 'samples/empty.csv': '' });
    const checked = await checkGroundTruth({
      ctx: ctxWith(exec),
      subject: 'RESULT',
      payload: {
        output: {
          files: ['samples/empty.csv'],
          probes: [
            {
              cmd: 'node csv2json.js samples/empty.csv',
              exitCode: 1,
              stderr: 'Error: CSV file is empty\n',
              note: 'expected empty-file error',
            },
          ],
        },
        summary: 'verified the empty CSV error case',
      },
      child: fileChild(),
    });
    expect(checked.contradiction).toBe(false);
    expect(checked.block).toMatch(/empty negative-test fixture corroborated/);
    expect(checked.block).not.toMatch(/WARNING: file is EMPTY/);
  });

  it('tells the validator NOT to reject over truncation or terse descriptions', async () => {
    // Guard against re-creating the over-demanding validator behaviour the
    // audit found: evidence being partial must not itself be grounds to fail.
    const exec = new FsExecutor({ 'big.md': 'x'.repeat(5000) });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), { output: { path: 'big.md' } });
    expect(content).toMatch(/…\(truncated\)/);
    expect(content).toMatch(/Do NOT reject merely because an excerpt is truncated/);
  });

  it('surfaces the recorded probes next to the file excerpts', async () => {
    const exec = new FsExecutor({ 'README.md': '# cli\n\nExits 1 on bad input.\n' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: {
        files: ['README.md'],
        probes: [{ cmd: 'node index.js /nope', exitCode: 0, stdout: 'Error: not found' }],
      },
      summary: 'documented the error behaviour',
    });
    expect(content).toMatch(/OWN recorded probe outputs/);
    expect(content).toMatch(/node index\.js \/nope/);
    expect(content).toMatch(/exit=0/);
    // The validator is explicitly invited to cross-check the README excerpt
    // (which says "Exits 1") against the recorded exit=0. That comparison is
    // a judgment, so it is NOT decided in code.
    expect(content).toMatch(/Cross-check the read-back file contents against these records/);
  });

  it('flags a SELF-REPORTED MISMATCH as a contradiction (match:false)', async () => {
    const exec = new FsExecutor({ 'README.md': '# cli' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: {
        files: ['README.md'],
        probes: [
          { cmd: 'node index.js 10 hi', expectedStdout: 'hi        ', actualStdout: 'hi', match: false },
        ],
      },
      summary: 'all verified',
    });
    // Assert the ARROW marker, which is what the contradiction detector keys
    // on — the bare phrase also appears in the block's instruction line.
    expect(content).toMatch(/<-- SELF-REPORTED MISMATCH/);
  });

  it('does NOT treat a non-zero exit as a failure (error-case probes are meant to)', async () => {
    const exec = new FsExecutor({ 'README.md': '# cli' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: {
        files: ['README.md'],
        probes: [{ cmd: 'node index.js', exitCode: 1, note: 'missing-args case' }],
      },
      summary: 'documented',
    });
    expect(content).toMatch(/exit=1/);
    expect(content).not.toMatch(/<-- SELF-REPORTED MISMATCH/);
  });

  it('requires review when durable HTTP docs capture the run\'s numeric port', async () => {
    const exec = new FsExecutor({
      'README.md':
        '# API\nRun against http://localhost:59420\nOutput: LISTENING_ON_PORT=59420\n',
    });
    const checked = await checkGroundTruth({
      ctx: ctxWith(exec),
      subject: 'RESULT',
      payload: {
        output: { files: ['README.md'] },
        summary: 'documented the API',
      },
      child: httpChild(),
    });
    expect(checked.contradiction).toBe(false);
    expect(checked.requiresReview).toBe(true);
    expect(checked.block).toMatch(/DURABLE HTTP DOC CONTAINS A NUMERIC LOOPBACK PORT/);
  });

  it('catches a dynamic port at the file-scribe boundary, before the HTTP parent', async () => {
    // Live failure: Methane delegated README.md to Lithium. Gating this check
    // on the CHILD owning HTTP tools let the port through L2; L3 caught it
    // only after the whole phase had completed and a retry exhausted 900s.
    const exec = new FsExecutor({
      'README.md': '# API\nRun against http://localhost:64871/recipes\n',
    });
    const checked = await checkGroundTruth({
      ctx: ctxWith(exec),
      subject: 'RESULT',
      payload: {
        output: { files: ['README.md'] },
        summary: 'documented the API from the server source',
      },
      child: fileChild(),
    });
    expect(checked.contradiction).toBe(false);
    expect(checked.requiresReview).toBe(true);
    expect(checked.block).toMatch(/DURABLE HTTP DOC CONTAINS A NUMERIC LOOPBACK PORT/);
  });

  it('keeps HTTP docs with port placeholders on the trust fast-path', async () => {
    const exec = new FsExecutor({
      'README.md':
        '# API\nRun against http://localhost:<port>\nOutput: LISTENING_ON_PORT=<port>\n',
    });
    const checked = await checkGroundTruth({
      ctx: ctxWith(exec),
      subject: 'RESULT',
      payload: {
        output: { files: ['README.md'] },
        summary: 'documented the API',
      },
      child: httpChild(),
    });
    expect(checked.requiresReview).toBe(false);
  });

  it('does NOT fire for a web-bucket child (the validate_html probe owns those)', async () => {
    const exec = new FsExecutor({ 'index.html': '<html></html>' }, [
      'read_file',
      'list_files',
      'write_file',
      'validate_html',
    ]);
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, webChild(), {
      output: { path: 'index.html' },
      summary: 'built the page',
    });
    expect(content).not.toMatch(/independent file read-back/);
    expect(exec.calls.some((c) => c.name === 'read_file')).toBe(false);
  });

  it('health-checks a reported web manifest alongside browser re-validation', async () => {
    const exec = new FsExecutor(
      {
        '.atoma-probes.json': JSON.stringify({
          version: 1,
          entries: [
            {
              probe: 'web',
              file: 'index.html',
              smoke: '({ok:true})',
              expected: { ok: true },
            },
          ],
        }),
      },
      ['read_file', 'validate_html']
    );
    const checked = await checkGroundTruth({
      ctx: ctxWith(exec),
      subject: 'RESULT',
      payload: {
        output: {
          url: 'http://localhost:1234/',
          probes: [{ probe: 'web', smoke: '({ok:true})' }],
        },
        summary: 'validated the page',
      },
      child: webChild(),
    });
    expect(checked.requiresReview).toBe(true);
    expect(checked.block).toMatch(/expected.*JSON-encoded string/);
  });

  it('does NOT fire for a child that cannot write files', async () => {
    const reasoner = new L1Atom({
      name: 'Boron',
      ordinal: 5,
      systemPrompt: 'sys',
      tools: [tool('fetch_url')],
      params: {},
    });
    const exec = new FsExecutor({ 'a.txt': 'x' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, reasoner, { output: { path: 'a.txt' } });
    expect(content).not.toMatch(/independent file read-back/);
  });

  it('stays silent when the RESULT names no files', async () => {
    const exec = new FsExecutor({ 'a.txt': 'x' });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), {
      output: 'done',
      summary: 'finished the work',
    });
    expect(content).not.toMatch(/independent file read-back/);
    expect(exec.calls).toHaveLength(0);
  });

  it('is skipped entirely on PLAN verdicts', async () => {
    const exec = new FsExecutor({ 'README.md': '# hi' });
    const ctx = ctxWith(exec);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Ammonia',
      supervisorTier: 2,
      subject: 'PLAN',
      child: fileChild(),
      task: { description: 'write files' },
      payload: { reasoning: 'r', proposedAction: 'write README.md', expectedOutput: 'e' },
    });
    expect(ctx.llm.calls[0]!.userContent).not.toMatch(/independent file read-back/);
    expect(exec.calls).toHaveLength(0);
  });

  it('bails out when the run is aborted (no tool calls)', async () => {
    const exec = new FsExecutor({ 'README.md': '# hi' });
    const controller = new AbortController();
    controller.abort();
    const base = makeCtx();
    const ctx = { ...base, tools: exec, signal: controller.signal };
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Ammonia',
      supervisorTier: 2,
      subject: 'RESULT',
      child: fileChild(),
      task: { description: 'write files' },
      payload: { output: { path: 'README.md' } },
    });
    expect(exec.calls).toHaveLength(0);
  });
});
