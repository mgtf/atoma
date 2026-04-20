import { describe, it, expect } from 'vitest';
import {
  VALIDATION_SYSTEM_PROMPT,
  llmVerdict,
  extractResultUrl,
} from '../src/atoms/L2Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { makeCtx, jsonText } from './helpers.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * Regression tests for the ground-truth re-validation feature.
 *
 * Motivation: the WebGL Minesweeper build run was approved despite producing
 * a non-functional game. The RESULT said "smokeTests: all passed" and every
 * validator rubber-stamped the self-report. The ground-truth probe makes the
 * validator re-run validate_html itself and inject the objective outcome into
 * the userContent, breaking the self-report → approve loop.
 */

function makeChild(): L1Atom {
  return new L1Atom({
    name: 'Hydrogen',
    ordinal: 1,
    systemPrompt: 'sys',
    tools: [],
    params: {},
  });
}

class MockToolExecutor implements ToolExecutor {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly replies: Record<string, unknown>;
  constructor(replies: Record<string, unknown> = {}) {
    this.replies = replies;
  }
  has(name: string): boolean {
    return name in this.replies || name === 'validate_html';
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name in this.replies) {
      const reply = this.replies[name];
      if (reply instanceof Error) throw reply;
      return reply;
    }
    // Default: pretend validate_html loaded cleanly.
    return { ok: true, errors: [], warnings: [], failedRequests: [] };
  }
}

describe('extractResultUrl', () => {
  it('picks output.url when present', () => {
    expect(
      extractResultUrl({ output: { url: 'http://localhost:8000/' } })
    ).toBe('http://localhost:8000/');
  });

  it('falls back to top-level url', () => {
    expect(extractResultUrl({ url: 'http://localhost:8000/' })).toBe(
      'http://localhost:8000/'
    );
  });

  it('picks output when output is a bare URL string', () => {
    // The common Haiku RESULT shape:
    //   {"output":"http://localhost:8000/index.html","summary":"…"}
    // Missing this shape was the core false-negative in the 23:03 run.
    expect(
      extractResultUrl({
        output: 'http://localhost:8000/index.html',
        summary: 'built',
      })
    ).toBe('http://localhost:8000/index.html');
  });

  it('extracts a URL embedded in output free text', () => {
    expect(
      extractResultUrl({
        output: 'Server now serving at http://localhost:8080/app/ done.',
        summary: 's',
      })
    ).toBe('http://localhost:8080/app/');
  });

  it('extracts a URL embedded in summary free text', () => {
    expect(
      extractResultUrl({
        output: { note: 'artefact ready' },
        summary: 'Open http://127.0.0.1:3000 to test.',
      })
    ).toBe('http://127.0.0.1:3000');
  });

  it('accepts a bare URL passed as the entire payload', () => {
    expect(extractResultUrl('http://localhost:8000/')).toBe('http://localhost:8000/');
  });

  it('stops at whitespace / quotes / brackets in free-text extraction', () => {
    expect(
      extractResultUrl({
        output: 'try "http://localhost:8000/a.html" now',
        summary: 's',
      })
    ).toBe('http://localhost:8000/a.html');
  });

  it('ignores non-http(s) strings', () => {
    expect(extractResultUrl({ output: { url: 'file:///tmp/x.html' } })).toBeNull();
    expect(extractResultUrl({ output: { url: '/relative/path' } })).toBeNull();
    expect(extractResultUrl('/relative/path')).toBeNull();
  });

  it('returns null when no url is present anywhere', () => {
    expect(extractResultUrl({ output: { summary: 'no url here' } })).toBeNull();
    expect(extractResultUrl(null)).toBeNull();
    expect(
      extractResultUrl({ output: 'plain text result', summary: 'also no url' })
    ).toBeNull();
  });
});

describe('llmVerdict — ground-truth re-validation', () => {
  it('re-runs validate_html for RESULT payloads that contain a URL', async () => {
    const tools = new MockToolExecutor();
    const ctx = makeCtx();
    (ctx as { tools?: ToolExecutor }).tools = tools;
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 'build something' },
      payload: { output: { url: 'http://localhost:8000/' }, summary: 's' },
    });

    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]!.name).toBe('validate_html');
    expect(tools.calls[0]!.args['url']).toBe('http://localhost:8000/');
  });

  it('skips the probe for PLAN verdicts (too early for runtime evidence)', async () => {
    const tools = new MockToolExecutor();
    const ctx = makeCtx();
    (ctx as { tools?: ToolExecutor }).tools = tools;
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'PLAN',
      child: makeChild(),
      task: { description: 't' },
      payload: {
        reasoning: 'r',
        proposedAction: 'a',
        expectedOutput: 'e',
        // Even if the plan contains a URL (e.g. a reference link), don't probe.
        url: 'http://localhost:8000/',
      },
    });

    expect(tools.calls).toHaveLength(0);
  });

  it('skips the probe when no URL is in the payload', async () => {
    const tools = new MockToolExecutor();
    const ctx = makeCtx();
    (ctx as { tools?: ToolExecutor }).tools = tools;
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 't' },
      payload: { output: { summary: 'no url' }, summary: 's' },
    });

    expect(tools.calls).toHaveLength(0);
  });

  it('skips the probe when ctx has no tools or no validate_html', async () => {
    const ctx = makeCtx(); // no tools set
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    const before = ctx.llm.calls.length;
    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 't' },
      payload: { output: { url: 'http://localhost:8000/' }, summary: 's' },
    });
    // LLM was still called exactly once (for the verdict). No crash.
    expect(ctx.llm.calls.length).toBe(before + 1);
  });

  it('injects the probe outcome into the validator userContent', async () => {
    const tools = new MockToolExecutor({
      validate_html: {
        ok: false,
        errors: ['TypeError: foo is not a function'],
        warnings: [],
        failedRequests: [{ url: 'x.js', reason: 'net::ERR_FAILED' }],
      },
    });
    const ctx = makeCtx();
    (ctx as { tools?: ToolExecutor }).tools = tools;
    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: 'page broken', modifications: {}, scope: 'ephemeral' })
    );

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 't' },
      payload: { output: { url: 'http://localhost:8000/' }, summary: 'works' },
    });

    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).toContain('GROUND-TRUTH EVIDENCE');
    expect(userContent).toContain('ok: false');
    expect(userContent).toContain('consoleErrors: 1');
    expect(userContent).toContain('failedRequests: 1');
    expect(userContent).toContain('TypeError: foo is not a function');
  });

  it('surfaces probe failure as an additional evidence block', async () => {
    const tools = new MockToolExecutor({
      validate_html: new Error('ECONNREFUSED'),
    });
    const ctx = makeCtx();
    (ctx as { tools?: ToolExecutor }).tools = tools;
    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: 'unreachable', modifications: {}, scope: 'ephemeral' })
    );

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 't' },
      payload: { output: { url: 'http://localhost:8000/' }, summary: 's' },
    });

    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).toContain('GROUND-TRUTH EVIDENCE');
    expect(userContent).toContain('ECONNREFUSED');
    expect(userContent).toContain('not actually running');
  });
});

describe('VALIDATION_SYSTEM_PROMPT — hardening against self-report and domain drift', () => {
  it('states that self-report is NOT evidence', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/self-report/i);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/NOT evidence/);
  });

  it('teaches validators to honor GROUND-TRUTH EVIDENCE blocks', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/GROUND-TRUTH EVIDENCE/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/outrank anything the child claims/);
  });

  it('tells validators that absence of a GROUND-TRUTH block is not a rejection reason', () => {
    // Previously Haiku over-indexed on the presence of the block, rejecting
    // every RESULT that didn't include one even when the probe couldn't
    // fire (no URL extractable). The prompt must now explicitly allow
    // approval on own-merits when the block is absent.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /absence of a GROUND-TRUTH EVIDENCE block is NOT itself grounds/i
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /do NOT demand the child produce a GROUND-TRUTH block/i
    );
  });

  it('keeps a narrow visible-deliverables rule that only rejects on materially wrong artefacts', () => {
    // Post-softening: we no longer demand prose enumeration of affordances.
    // The rule now rejects only when the plan commits to producing an
    // artefact that clearly cannot satisfy task-named elements (e.g.
    // colored shapes in place of task-stated numbers/icons). These tokens
    // are the narrow-rule fingerprint; the old aggressive enumeration
    // wording was removed deliberately.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/VISIBLE-DELIVERABLES RULE/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/materially WRONG artefact/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/task-stated[\s\S]*numbers\/icons/);
  });

  it('teaches branch creators to use systemPromptReplace on domain drift', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/BRANCHING ACROSS DOMAINS/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/systemPromptReplace/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Frankenstein/);
  });
});

describe('llmVerdict — probe fires on output-as-URL-string payloads (regression)', () => {
  it('triggers validate_html when output is a bare URL string', async () => {
    const tools = new MockToolExecutor();
    const ctx = makeCtx();
    (ctx as { tools?: ToolExecutor }).tools = tools;
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Sucrose',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 'build' },
      // The exact shape Haiku emits in practice — and which the old
      // extractor missed, causing every RESULT to be rejected for
      // "no GROUND-TRUTH EVIDENCE block".
      payload: {
        output: 'http://localhost:8000/index.html',
        summary: 'done',
      },
    });

    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]!.name).toBe('validate_html');
    expect(tools.calls[0]!.args['url']).toBe('http://localhost:8000/index.html');
  });
});
