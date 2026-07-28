import { describe, it, expect } from 'vitest';
import {
  llmVerdict,
  extractResultFilePaths,
  extractResultFileClaims,
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

  it('tells the validator NOT to reject over truncation or terse descriptions', async () => {
    // Guard against re-creating the over-demanding validator behaviour the
    // audit found: evidence being partial must not itself be grounds to fail.
    const exec = new FsExecutor({ 'big.md': 'x'.repeat(5000) });
    const ctx = ctxWith(exec);
    const content = await runVerdict(ctx, fileChild(), { output: { path: 'big.md' } });
    expect(content).toMatch(/…\(truncated\)/);
    expect(content).toMatch(/Do NOT reject merely because an excerpt is truncated/);
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
