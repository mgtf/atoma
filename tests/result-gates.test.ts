import { describe, it, expect } from 'vitest';
import {
  RESULT_GATE_IDS,
  buildResultGateEnv,
  renderResultGateFindings,
  runResultGates,
  type ResultGateFinding,
} from '../src/atoms/resultGates.js';
import { makeCtx } from './helpers.js';
import type { Result, ToolExecutor } from '../src/core/types.js';

/**
 * The declarative RESULT-gate pipeline (2026-08-14 review, §3.1/§3.2): every
 * mechanical gate is a table row with an explicit disposition, workspace
 * reads are cached per validation cycle, and prose-triggered gates never
 * reject on their own. End-to-end behavior through L2.validateResult is
 * pinned in tests/trust-fastpath-groundtruth.test.ts; these cases pin the
 * pipeline's own contract.
 */

function result(partial: Partial<Result>): Result {
  return {
    output: {},
    summary: 'done',
    trace: [],
    producedBy: { tier: 1, name: 'Water', viaFallback: false },
    ...partial,
  };
}

class CountingExecutor implements ToolExecutor {
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string>) {}
  has(name: string): boolean {
    return name === 'read_file';
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const p = String(args['path']);
    this.reads.push(p);
    if (!(p in this.files)) throw new Error(`ENOENT: ${p}`);
    return { path: p, content: this.files[p] };
  }
}

function env(args: {
  description: string;
  result: Result;
  files?: Record<string, string>;
  toolNames?: readonly string[];
  requireObservedToolAction?: boolean;
}): { gateEnv: ReturnType<typeof buildResultGateEnv>; exec: CountingExecutor } {
  const exec = new CountingExecutor(args.files ?? {});
  const ctx = {
    ...makeCtx(),
    tools: exec,
    ...(args.requireObservedToolAction !== undefined
      ? { requireObservedToolAction: args.requireObservedToolAction }
      : {}),
  };
  return {
    gateEnv: buildResultGateEnv({
      task: { description: args.description },
      result: args.result,
      childName: 'Water',
      childToolNames: args.toolNames ?? ['write_file', 'read_file'],
      ctx,
    }),
    exec,
  };
}

describe('result-gate pipeline', () => {
  it('pins the gate order — hard witnesses, then disk evidence, then prose-triggered reviews', () => {
    expect(RESULT_GATE_IDS).toEqual([
      'observed-tool-action',
      'required-command-manifest',
      'portable-http-docs',
      'non-json-envelope',
      'internal-validation-failed',
      'recorded-json-shape',
      'web-styling-evidence',
    ]);
  });

  it('reads a workspace file ONCE per cycle even when two gates consume it', async () => {
    // `node data-check.js` makes the command gate read the manifest; the JSON
    // object requirement makes the shape gate read it too. One read total.
    const manifest = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node data-check.js', exitCode: 0, stdout: '{"ok":true}\n' }],
    });
    const { gateEnv, exec } = env({
      description:
        'print a JSON object of results; running node data-check.js must exit 0',
      result: result({}),
      files: { '.atoma-probes.json': manifest },
    });
    const outcome = await runResultGates(gateEnv, new Set());
    expect(outcome.rejection).toBeNull();
    expect(outcome.reviewFindings).toEqual([]);
    expect(exec.reads.filter((p) => p === '.atoma-probes.json')).toHaveLength(1);
  });

  it('reject-once: first offense rejects, the identical repeat becomes a review finding', async () => {
    const files = {
      '.atoma-probes.json': JSON.stringify({
        version: 1,
        entries: [{ cmd: 'node api-test.js', exitCode: 1, stdout: '' }],
      }),
    };
    const description = 'running node api-test.js must exit 0';
    const memo = new Set<string>();

    const first = await runResultGates(
      env({ description, result: result({}), files }).gateEnv,
      memo
    );
    expect(first.rejection?.gateId).toBe('required-command-manifest');

    const second = await runResultGates(
      env({ description, result: result({}), files }).gateEnv,
      memo
    );
    expect(second.rejection).toBeNull();
    expect(second.reviewFindings.map((f) => f.gateId)).toEqual(['required-command-manifest']);
  });

  it('requires-review findings never reject, and hard gates still win outright', async () => {
    // Styling finding present AND an internal-validation-failed prefix: the
    // hard gate rejects; the prose gate could only ever add a review finding.
    const styled = result({
      summary: '[INTERNAL VALIDATION FAILED — smoke] widget done',
      output: { probes: [] },
    });
    const { gateEnv } = env({
      description: 'build a widget with conditional styling',
      result: styled,
      toolNames: ['write_file', 'validate_html'],
    });
    const outcome = await runResultGates(gateEnv, new Set());
    expect(outcome.rejection?.gateId).toBe('internal-validation-failed');

    const stylingOnly = await runResultGates(
      env({
        description: 'build a widget with conditional styling',
        result: result({ output: { probes: [] } }),
        toolNames: ['write_file', 'validate_html'],
      }).gateEnv,
      new Set()
    );
    expect(stylingOnly.rejection).toBeNull();
    expect(stylingOnly.reviewFindings.map((f) => f.gateId)).toEqual(['web-styling-evidence']);
  });

  it('renders findings as leads to verify, never verdicts to obey', () => {
    const findings: ResultGateFinding[] = [
      {
        gateId: 'web-styling-evidence',
        disposition: 'requires-review',
        reasoning: 'no styling evidence recorded',
        coaching: 'capture milestone and reset class snapshots',
      },
    ];
    const block = renderResultGateFindings(findings);
    expect(block).toMatch(/== MECHANICAL GATE FINDINGS ==/);
    expect(block).toMatch(/leads to VERIFY/);
    expect(block).toMatch(/\[web-styling-evidence\] no styling evidence recorded/);
    expect(renderResultGateFindings([])).toBe('');
  });
});
