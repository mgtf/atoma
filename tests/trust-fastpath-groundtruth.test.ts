import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import {
  L2Atom,
  recordedJsonShapeMismatch,
  requiredCommandManifestMismatch,
  requiredPassingCommands,
  webStylingEvidenceMissing,
} from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { Result, RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * The trust fast-path skips the LLM validator — but it must NOT skip the
 * ground-truth probe, which costs zero tokens. Observed on the json-cli live
 * run: Ammonia at 6 successes and Idioblast at 8 meant ZERO validation calls for
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

const withInheritedLiteralContract = (phase: string, contract: string): string =>
  `${phase}\n\n== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==\n${contract}`;

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

  const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
  const l1 = L1Atom.fromType(reg.getByName(l1Type.name)!);
  const exec = new FsExecutor(files);
  const base = makeCtx();
  return { l2, l1, ctx: { ...base, tools: exec }, exec };
}

function result(payload: {
  output: unknown;
  summary: string;
  evidence?: Result['evidence'];
  toolCallResults?: Result['toolCallResults'];
}): Result {
  return {
    output: payload.output,
    summary: payload.summary,
    trace: [],
    producedBy: { tier: 1, name: 'Water', viaFallback: false },
    ...(payload.evidence ? { evidence: payload.evidence } : {}),
    ...(payload.toolCallResults !== undefined
      ? { toolCallResults: payload.toolCallResults }
      : {}),
  };
}

describe('webStylingEvidenceMissing', () => {
  it('requires class/style/color values when the task claims conditional styling', () => {
    const task = { description: 'verify controls and conditional styling' };
    expect(
      webStylingEvidenceMissing(
        task,
        result({
          output: {
            probes: [
              {
                probe: 'web',
                smoke: '({ok: widget.streak === 0, streak: widget.streak})',
                smokeResult: { ok: true, streak: 0 },
              },
            ],
          },
          summary: 'verified',
        })
      )
    ).toBe(true);
    expect(
      webStylingEvidenceMissing(
        task,
        result({
          output: {
            probes: [
              {
                probe: 'web',
                smoke:
                  '({ok: resetClass === "streak-0", resetClass: widget.className})',
                smokeResult: { ok: true, resetClass: 'streak-0' },
              },
            ],
          },
          summary: 'verified reset only',
        })
      )
    ).toBe(true);
    expect(
      webStylingEvidenceMissing(
        task,
        result({
          output: {
            probes: [
              {
                probe: 'web',
                smoke: '({ok: milestone.className === "streak-3", className: milestone.className})',
                smokeResult: { ok: true, milestoneClass: 'streak-3', resetClass: 'streak-0' },
              },
            ],
          },
          summary: 'verified',
        })
      )
    ).toBe(false);
  });

  it('ignores styling language inherited from another phase', () => {
    expect(
      webStylingEvidenceMissing(
        {
          description: withInheritedLiteralContract(
            'Verify the CLI output and report the recorded values.',
            'The browser UI uses conditional styling and changes class at the milestone.'
          ),
        },
        result({ output: { files: ['cli.js'] }, summary: 'CLI verified' })
      )
    ).toBe(false);
  });
});

describe('recordedJsonShapeMismatch', () => {
  const probeResult = (stdout: string): Result =>
    result({
      output: {
        probes: [{ cmd: 'node word-frequency.js input.txt', exitCode: 0, stdout }],
      },
      summary: 'verified output',
    });

  it('distinguishes requested JSON objects and arrays from recorded stdout', () => {
    expect(
      recordedJsonShapeMismatch(
        { description: 'print a JSON object mapping words to counts' },
        probeResult('[{"word":"hello","count":2}]\n')
      )
    ).toMatch(/requires JSON object.*returned a JSON array/);
    expect(
      recordedJsonShapeMismatch(
        { description: 'print a JSON object mapping words to counts' },
        probeResult('{"hello":2}\n')
      )
    ).toBeNull();
    expect(
      recordedJsonShapeMismatch(
        { description: 'print a JSON array of records' },
        probeResult('{"hello":2}\n')
      )
    ).toMatch(/requires JSON array.*returned a JSON object/);
  });

  it('ignores a JSON container requirement inherited from another phase', () => {
    expect(
      recordedJsonShapeMismatch(
        {
          description: withInheritedLiteralContract(
            'Verify word-frequency.js exists and report the file size.',
            'The CLI must print a JSON object mapping words to counts.'
          ),
        },
        probeResult('[{"word":"hello","count":2}]\n')
      )
    ).toBeNull();
  });
});

describe('required passing command manifest gate', () => {
  const task =
    'In a final phase run the existing test-api.js end-to-end with node test-api.js and confirm it passes.';

  it('extracts finite test harnesses but not long-running server commands', () => {
    expect(
      requiredPassingCommands(
        `${task} Start with node server.js. A file named contest.js is unrelated.`
      )
    ).toEqual(['node test-api.js']);
  });

  it('ignores a finite harness inherited from another phase', () => {
    expect(
      requiredPassingCommands(
        withInheritedLiteralContract(
          'Build server.js and record its bound URL.',
          'A later verification phase must run node test-api.js and require it to pass.'
        )
      )
    ).toEqual([]);
  });

  it('requires the latest exact recorded command to exit zero', () => {
    expect(
      requiredCommandManifestMismatch(
        task,
        JSON.stringify({
          version: 1,
          entries: [{ cmd: 'node test-api.js', exitCode: 1, stderr: 'proxy failed' }],
        })
      )
    ).toMatch(/latest recorded exit code is 1/);
    expect(
      requiredCommandManifestMismatch(
        task,
        JSON.stringify({
          version: 1,
          entries: [
            { cmd: 'node test-api.js', exitCode: 1 },
            { cmd: 'node test-api.js', exitCode: 0 },
          ],
        })
      )
    ).toBeNull();
  });
});

describe('trust fast-path × ground-truth probe', () => {
  it('rejects a production L1 result when the transport observed no successful action', async () => {
    const { l2, l1, ctx, exec } = setup({ 'index.js': 'console.log("real")' });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: ['index.js'] },
        summary: 'claimed it built index.js',
        toolCallResults: [],
      }),
      { description: 'build index.js' },
      { ...ctx, requireObservedToolAction: true }
    );

    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toMatch(/without any successful tool action/);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(exec.calls).toEqual([]); // rejection precedes even the trust probe
  });

  it('rejects a tolerant non-JSON result before a trusted type can approve it', async () => {
    const { l2, l1, ctx, exec } = setup({ 'server.js': 'console.log("done")' });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: 'The verification is complete.',
        summary: 'fallback produced non-JSON output (29 chars)',
        toolCallResults: [{ name: 'read_file', ok: true }],
      }),
      { description: 'verify server.js' },
      { ...ctx, requireObservedToolAction: true }
    );

    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toMatch(/required final.*JSON envelope/);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(exec.calls).toEqual([]);
  });

  it('rejects an explicit internal validate_html failure before trust', async () => {
    const { l2, l1, ctx, exec } = setup({ 'index.html': '<main>widget</main>' });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: ['index.html'] },
        summary:
          '[INTERNAL VALIDATION FAILED — last validate_html: smoke check failed] widget done',
        toolCallResults: [
          { name: 'write_file', ok: true },
          { name: 'validate_html', ok: false },
        ],
      }),
      { description: 'build and verify index.html' },
      { ...ctx, requireObservedToolAction: true }
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toMatch(/final validate_html call failed/);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(exec.calls).toEqual([]);
  });

  it('forces a full verdict for a recorded JSON container mismatch instead of trusting', async () => {
    // The "JSON object" requirement is a regex reading of task prose, so the
    // gate is requires-review: it must override the trust fast-path and hand
    // the facts to the LLM validator — never reject on its own (2026-08-14
    // review: a false trigger becomes one cheap validator call instead of a
    // deterministic rejection cascade).
    const { l2, l1, ctx } = setup({ 'word-frequency.js': 'console.log("[]")' });
    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: 'the recorded stdout is a JSON array' })
    );
    const verdict = await l2.validateResult(
      l1,
      result({
        output: {
          files: ['word-frequency.js'],
          probes: [
            {
              cmd: 'node word-frequency.js input.txt',
              exitCode: 0,
              stdout: '[{"word":"hello","count":2}]\n',
            },
          ],
        },
        summary: 'verified JSON output',
        toolCallResults: [{ name: 'record_probe', ok: true }],
      }),
      { description: 'print a JSON object mapping lowercase words to counts' },
      { ...ctx, requireObservedToolAction: true }
    );
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/MECHANICAL GATE FINDINGS/);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/\[recorded-json-shape\]/);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/requires JSON object.*JSON array/);
    // Leads to verify, not verdicts to obey — the framing is part of the contract.
    expect(ctx.llm.calls[0]!.userContent).toMatch(/leads to VERIFY/);
  });

  it('forces a full verdict for a manifest-only JSON container mismatch, reading the manifest ONCE', async () => {
    const { l2, l1, ctx, exec } = setup({
      '.atoma-probes.json': JSON.stringify({
        version: 1,
        entries: [
          {
            cmd: 'node word-frequency.js input.txt',
            exitCode: 0,
            stdout: '[{"word":"hello","count":2}]\n',
          },
        ],
      }),
    });
    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: 'manifest stdout contradicts the object shape' })
    );
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: [] },
        summary: 'verified output without inline probes',
        toolCallResults: [{ name: 'record_probe', ok: true }],
      }),
      { description: 'print a JSON object mapping lowercase words to counts' },
      { ...ctx, requireObservedToolAction: true }
    );
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/\[recorded-json-shape\]/);
    // Shared per-cycle read cache: the gate pipeline pays ONE manifest read.
    expect(exec.calls.filter((c) => c === 'read_file')).toHaveLength(1);
  });

  it('gives a reject-once gate ONE mechanical rejection, then hands the repeat to the LLM', async () => {
    // The $2.03 lesson (types.ts mechanicalPlanRejections), applied to the
    // RESULT side: a byte-identical mechanical rejection repeated against the
    // same task would trip the 3-strike tracker and escalate a healthy child.
    const files = {
      'test-api.js': 'process.exit(1)',
      '.atoma-probes.json': JSON.stringify({
        version: 1,
        entries: [{ cmd: 'node test-api.js', exitCode: 1, stdout: '' }],
      }),
    };
    const { l2, l1, ctx } = setup(files);
    const task = { description: 'running node test-api.js must exit 0' };
    const failing = () =>
      result({
        output: { files: ['test-api.js'] },
        summary: 'harness present',
        toolCallResults: [{ name: 'write_file', ok: true }],
      });

    const first = await l2.validateResult(l1, failing(), task, ctx);
    expect(first.approved).toBe(false);
    expect(first.reasoning).toMatch(/latest recorded exit code is 1/);
    expect(ctx.llm.calls).toHaveLength(0); // one free coached rejection

    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: 'harness still failing, keep fixing it' })
    );
    const second = await l2.validateResult(l1, failing(), task, ctx);
    expect(second.approved).toBe(false);
    // The repeat is NOT another byte-identical mechanical rejection: the LLM
    // judges, with the gate finding attached.
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/\[required-command-manifest\]/);
  });

  it('does not load an inherited JSON shape requirement from the probe manifest', async () => {
    const { l2, l1, ctx } = setup({
      'word-frequency.js': 'console.log("ready")',
      '.atoma-probes.json': JSON.stringify({
        version: 1,
        entries: [
          {
            cmd: 'node word-frequency.js input.txt',
            exitCode: 0,
            stdout: '[{"word":"hello","count":2}]\n',
          },
        ],
      }),
    });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: ['word-frequency.js'] },
        summary: 'word-frequency.js is present',
        toolCallResults: [{ name: 'read_file', ok: true }],
      }),
      {
        description: withInheritedLiteralContract(
          'Inspect word-frequency.js and report its current state.',
          'The CLI must print a JSON object mapping lowercase words to counts.'
        ),
      },
      { ...ctx, requireObservedToolAction: true }
    );

    expect(verdict.approved).toBe(true);
    expect(verdict.reasoning).toMatch(/trust fast-path/);
  });

  it('rejects a required harness whose manifest entry still fails', async () => {
    const { l2, l1, ctx, exec } = setup({
      'test-api.js': 'process.exit(1)',
      '.atoma-probes.json': JSON.stringify({
        version: 1,
        entries: [{ cmd: 'node test-api.js', exitCode: 1, stderr: 'proxy failed' }],
      }),
    });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: ['test-api.js'] },
        summary: 'substituted another passing harness',
        toolCallResults: [{ name: 'run_shell', ok: true }],
      }),
      {
        description:
          'Run existing test-api.js end-to-end with node test-api.js and confirm it passes.',
      },
      { ...ctx, requireObservedToolAction: true }
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toMatch(/node test-api\.js.*exit code is 1/);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(exec.calls).toEqual(['read_file']);
  });

  it('reads task-required portable README docs even when the result omits them', async () => {
    const { l2, l1, ctx, exec } = setup({
      'README.md': 'Start server\nLISTENING_ON_PORT=3000\nhttp://localhost:<port>/',
    });
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'README.md contains a numeric port forbidden by this task', scope: 'ephemeral' }));
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { url: 'http://localhost:55555/' },
        summary: 'server verified',
        toolCallResults: [{ name: 'fetch_url', ok: true }],
      }),
      {
        description:
          'Confirm README.md keeps portable <port> and LISTENING_ON_PORT=<port> examples, never a numeric port.',
      },
      { ...ctx, requireObservedToolAction: true }
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toMatch(/README\.md contains a numeric/);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('LISTENING_ON_PORT=3000');
    expect(exec.calls).toEqual(['read_file']);
  });

  it('lets the validator honor a requested fixed port despite portable wording in the phase', async () => {
    const { l2, l1, ctx } = setup({
      'README.md': 'PORT=3000 npm start\nOpen http://localhost:3000/',
    });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the user explicitly requested port 3000' }));
    const verdict = await l2.validateResult(l1, result({
      output: { files: ['README.md'] }, summary: 'documented the requested command',
      toolCallResults: [{ name: 'write_file', ok: true }],
    }), {
      description: withInheritedLiteralContract(
        'Update README.md with portable startup documentation.',
        'Document PORT=3000 npm start and http://localhost:3000/.',
      ),
    }, { ...ctx, requireObservedToolAction: true });

    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain('http://localhost:3000/');
    expect(ctx.llm.calls[0]!.userContent).toContain('portable-http-docs');
  });

  it('does not impose inherited portable-doc requirements on another phase', async () => {
    const { l2, l1, ctx } = setup({
      'server.js': 'console.log("LISTENING_ON_PORT=3000")',
      'README.md': 'Start server at http://localhost:3000/',
    });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: ['server.js'] },
        summary: 'server.js built',
        toolCallResults: [{ name: 'write_file', ok: true }],
      }),
      {
        description: withInheritedLiteralContract(
          'Build server.js and emit its readiness marker.',
          'A later docs phase must keep README.md portable with <port>, never a numeric port.'
        ),
      },
      { ...ctx, requireObservedToolAction: true }
    );

    expect(verdict.approved).toBe(true);
    expect(verdict.reasoning).toMatch(/trust fast-path/);
  });

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

  it('preserves the fast-path when a required probe manifest is well-formed', async () => {
    const { l2, l1, ctx, exec } = setup({
      'index.js': 'console.log("ok")',
      '.atoma-probes.json': JSON.stringify({
        version: 1,
        entries: [{ cmd: 'node index.js', exitCode: 0, stdout: 'ok\n', stderr: '' }],
      }),
    });
    const verdict = await l2.validateResult(
      l1,
      result({
        output: {
          files: ['index.js'],
          probes: [{ cmd: 'node index.js', exitCode: 0, stdout: 'ok\n', stderr: '' }],
        },
        summary: 'wrote and verified index.js',
      }),
      { description: 'write index.js' },
      ctx
    );

    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
    // One manifest read + one claimed-file read. A clean health check remains
    // zero-token and does not run twice.
    expect(exec.calls.filter((c) => c === 'read_file')).toHaveLength(2);
  });

  it('forces a full verdict for a MALFORMED manifest without rejecting mechanically', async () => {
    const { l2, l1, ctx, exec } = setup({
      'index.js': 'console.log("ok")',
      '.atoma-probes.json': JSON.stringify({ version: 2, entries: [] }),
    });
    ctx.llm.enqueueText(
      jsonText({ approved: true, reasoning: 'the deliverable works, but repair the manifest' })
    );

    const verdict = await l2.validateResult(
      l1,
      result({
        output: {
          files: ['index.js'],
          probes: [{ cmd: 'node index.js', exitCode: 0, stdout: 'ok\n', stderr: '' }],
        },
        summary: 'wrote and verified index.js',
      }),
      { description: 'write index.js' },
      ctx
    );

    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/\.atoma-probes\.json: MALFORMED/);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/expected "version": 1/);
    // The already-computed block is threaded into llmVerdict, so the manifest
    // and claimed file are each read once.
    expect(exec.calls.filter((c) => c === 'read_file')).toHaveLength(2);
  });

  it('consumes typed Result.evidence instead of requiring probes to remain in the payload', async () => {
    const { l2, l1, ctx } = setup({ 'index.js': 'console.log("actual")' });
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'typed witness reports mismatch' }));
    const verdict = await l2.validateResult(
      l1,
      result({
        output: { files: ['index.js'] },
        summary: 'verified index.js',
        evidence: [
          {
            source: 'recorded-probe',
            cmd: 'node index.js',
            expected: 'expected',
            actual: 'actual',
            match: false,
          },
        ],
      }),
      { description: 'write and verify index.js' },
      ctx
    );

    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/SELF-REPORTED MISMATCH/);
    expect(ctx.llm.calls[0]!.userContent).toMatch(/"node index\.js"/);
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
