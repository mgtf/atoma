import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { Result, RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * The trust fast-path skips the LLM validator — but it must NOT skip the
 * ground-truth probe, which costs zero tokens. Observed on the json-cli live
 * run: Lithium at 6 successes and Ammonia at 8 meant ZERO validation calls for
 * the entire run, so the read-back probe never fired at all and a RESULT
 * claiming "exit code 1" shipped while the CLI actually exits 0. A trusted
 * type is precisely the one nobody is watching any more.
 *
 * Contract under test:
 *   - clean probe  → fast-path preserved, ZERO LLM calls (cost discipline)
 *   - contradiction → falls through to a full LLM verdict, with the already
 *     computed evidence block passed along (probe must not run twice)
 *   - never an outright reject: a path-extraction heuristic must not fail a
 *     run on its own.
 */

const seed = {
  description: 'seed',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

function tool(name: string): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

class FsExecutor implements ToolExecutor {
  readonly calls: string[] = [];
  constructor(private readonly files: Record<string, string>) {}
  has(name: string): boolean {
    return ['read_file', 'list_files', 'write_file'].includes(name);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push(name);
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

function setup(files: Record<string, string>): {
  l2: L2Atom;
  l1: L1Atom;
  ctx: RunContext & { llm: ReturnType<typeof makeCtx>['llm'] };
  exec: FsExecutor;
} {
  const reg = new AtomRegistry(openDb(':memory:'));
  reg.create(2, seed);
  const l1Type = reg.create(1, {
    ...seed,
    tools: [tool('write_file'), tool('read_file'), tool('list_files')],
  });
  // Earn trust: this is the whole point — the child is TRUSTED.
  for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);

  const l2 = L2Atom.fromType(reg.getByName('Water')!, reg);
  const l1 = L1Atom.fromType(reg.getByName(l1Type.name)!);
  const exec = new FsExecutor(files);
  const base = makeCtx();
  return { l2, l1, ctx: { ...base, tools: exec }, exec };
}

function result(payload: { output: unknown; summary: string }): Result {
  return {
    output: payload.output,
    summary: payload.summary,
    trace: [],
    producedBy: { tier: 1, name: 'Hydrogen', viaFallback: false },
  };
}

describe('trust fast-path × ground-truth probe', () => {
  it('preserves the fast-path (ZERO LLM calls) when the probe finds no contradiction', async () => {
    const { l2, l1, ctx, exec } = setup({
      'README.md': '# json-cli\n\n## Install\n\n## Usage\n',
      'index.js': 'console.log("x")',
    });
    // No queued LLM response: any validator call would throw.
    const verdict = await l2.validateResult(
      l1,
      result({ output: { files: ['README.md', 'index.js'] }, summary: 'wrote both' }),
      { description: 'write the files' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(verdict.reasoning).toMatch(/trust fast-path/);
    expect(ctx.llm.calls).toHaveLength(0);
    // The probe DID run — that is the fix. It just cost no tokens.
    expect(exec.calls.filter((c) => c === 'read_file')).toHaveLength(2);
  });

  it('falls through to a full LLM verdict when a claimed file is MISSING', async () => {
    const { l2, l1, ctx, exec } = setup({ 'index.js': 'console.log("x")' });
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'README.md does not exist', scope: 'ephemeral' }));

    const verdict = await l2.validateResult(
      l1,
      result({ output: { files: ['index.js', 'README.md'] }, summary: 'wrote both files' }),
      { description: 'write the files' },
      ctx
    );

    // Trust no longer rubber-stamps it.
    expect(ctx.llm.calls).toHaveLength(1);
    expect(verdict.approved).toBe(false);
    // The evidence reached the validator…
    const content = ctx.llm.calls[0]!.userContent;
    expect(content).toMatch(/README\.md: MISSING or unreadable/);
    // …and the probe ran ONCE, not twice (the block was handed over).
    expect(exec.calls.filter((c) => c === 'read_file')).toHaveLength(2);
    expect(exec.calls.filter((c) => c === 'list_files')).toHaveLength(1);
  });

  it('falls through when a claimed file is EMPTY', async () => {
    const { l2, l1, ctx } = setup({ 'README.md': '  \n ' });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'empty but acceptable' }));
    await l2.validateResult(
      l1,
      result({ output: { path: 'README.md' }, summary: 'documented it' }),
      { description: 'write docs' },
      ctx
    );
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/WARNING: file is EMPTY/);
  });

  it('never rejects on its own — the LLM keeps the final say', async () => {
    // Same missing-file contradiction, but this time the validator judges the
    // deliverable acceptable. The fast-path override must not pre-empt that.
    const { l2, l1, ctx } = setup({ 'index.js': 'x' });
    ctx.llm.enqueueText(
      jsonText({ approved: true, reasoning: 'the missing file was not actually required' })
    );
    const verdict = await l2.validateResult(
      l1,
      result({ output: { files: ['index.js', 'optional.md'] }, summary: 'done' }),
      { description: 'write files' },
      ctx
    );
    expect(verdict.approved).toBe(true);
  });

  it('keeps the fast-path free when the RESULT names no files at all', async () => {
    const { l2, l1, ctx, exec } = setup({ 'a.txt': 'x' });
    const verdict = await l2.validateResult(
      l1,
      result({ output: 'done', summary: 'finished' }),
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
    // No paths claimed → no probing at all, so trusted subtasks that return
    // plain summaries stay exactly as cheap as before this change.
    expect(exec.calls).toHaveLength(0);
  });

  it('does not probe on PLAN verdicts (fast-path unchanged there)', async () => {
    const { l2, l1, ctx, exec } = setup({ 'README.md': '# hi' });
    const verdict = await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'write README.md', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(exec.calls).toHaveLength(0);
  });
});
