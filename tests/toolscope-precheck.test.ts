import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { undeclaredToolMentions, BUILTIN_TOOL_VOCABULARY } from '../src/atoms/verdict.js';
import { probeGroundTruth } from '../src/atoms/groundTruth.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * F1(a) — the mechanical toolset pre-check (app-task-tracker run,
 * 2026-08-07): an Opus plan demanded validate_html for the UI phase, the
 * phase routed to an HTTP-bucket L1 that cannot declare it, the L1's plan
 * promised the tool seven times, and the plan validator approved — nothing
 * showed it the child's toolset. The whole verification phase then silently
 * never happened while every downstream validator credited it.
 */

const HTTP_TOOLS = ['write_file', 'read_file', 'run_shell', 'fetch_url', 'start_node_server'];

describe('undeclaredToolMentions', () => {
  it('flags a non-negated mention of an undeclared tool', () => {
    expect(
      undeclaredToolMentions('start the server then validate_html the returned URL', HTTP_TOOLS)
    ).toEqual(['validate_html']);
  });

  it('does NOT flag declared tools or prose words', () => {
    expect(
      undeclaredToolMentions('write_file server.js then start_node_server and fetch_url it', HTTP_TOOLS)
    ).toEqual([]);
  });

  it('a negated echo of a task constraint is an acknowledgement, not an intent', () => {
    expect(
      undeclaredToolMentions('per the task: no static server, no validate_html needed', HTTP_TOOLS)
    ).toEqual([]);
    expect(
      undeclaredToolMentions('validate_html is unavailable to this atom, so probe over HTTP', HTTP_TOOLS)
    ).toEqual([]);
  });

  it('one non-negated mention among negated ones still flags', () => {
    const text =
      'no validate_html in phase 1; later I will run validate_html against the URL';
    expect(undeclaredToolMentions(text, HTTP_TOOLS)).toEqual(['validate_html']);
  });

  it('the vocabulary is the closed builtin list', () => {
    expect(BUILTIN_TOOL_VOCABULARY).toContain('validate_html');
    expect(BUILTIN_TOOL_VOCABULARY).toContain('start_node_server');
  });
});

describe('L2.validatePlan — mechanical pre-check before any LLM call', () => {
  function setup(): { water: L2Atom; child: L1Atom; reg: AtomRegistry } {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    const t = reg.create(1, {
      description: 'http builder',
      systemPrompt: 'l1',
      tools: HTTP_TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
      params: {},
      createdBy: 't',
    });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, []);
    // `fromType`'s second parameter is the MODEL id, not the registry — the
    // arg passed here was a copy-paste of the L2 signature above and is
    // unused on every path this file exercises (the verdict runs on the
    // supervisor's validationModel, the probes run on ctx.tools).
    const child = L1Atom.fromType(t);
    return { water, child, reg };
  }

  it('rejects an off-scope plan with ZERO LLM calls and coaching that names the declared set', async () => {
    const { water, child } = setup();
    const ctx = makeCtx();
    const verdict = await water.validatePlan(
      child,
      makePlan({
        // Two non-negated mentions — a plan that USES a tool names it
        // repeatedly (the motivating run: seven times); the pre-check
        // threshold is 2 so single echoes never auto-reject.
        reasoning: 'serve then validate_html with interactions',
        proposedAction: 'start_node_server, then validate_html the URL covering each control',
        expectedOutput: 'zero console errors',
      }),
      { description: 'build the UI phase' },
      ctx
    );
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(0); // the cost guard: mechanical, free
    if (!verdict.approved) {
      expect(verdict.reasoning).toContain('validate_html');
      expect(verdict.modifications.additionalContext).toContain('fetch_url');
    }
  });

  it('mechanical rejection is ONE-SHOT per (subtask, tool) — the retry goes to the LLM validator', async () => {
    // Measured (guest-counter retry, 2026-08-08): the subtask TEXT itself
    // carried the tool name (Opus plan prose), the child's plans echoed it,
    // and three byte-identical mechanical rejections tripped the repeat
    // tracker into escalation + branch + fallback — $2.03 vs $0.40 siblings.
    const { water, child } = setup();
    const ctx = makeCtx();
    const task = { description: 'author the page; validate with validate_html per the plan' };
    const offPlan = makePlan({
      reasoning: 'validate_html then assert',
      proposedAction: 'validate_html per the subtask, then run checks',
      expectedOutput: 'e',
    });
    const first = await water.validatePlan(child, offPlan, task, ctx);
    expect(first.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(0); // the one free mechanical rejection
    // Same subtask, the child re-plans still echoing the name: the LLM
    // validator (toolset line + echo nuance) judges now — no repeat loop.
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'echo of the subtask, intent is in-scope' }));
    const second = await water.validatePlan(child, offPlan, task, ctx);
    expect(second.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);
    // A DIFFERENT subtask still gets its own free mechanical rejection.
    const other = await water.validatePlan(child, offPlan, { description: 'another phase entirely' }, ctx);
    expect(other.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('pre-check outranks the trust fast-path — a trusted child gets no blind approval', async () => {
    const { water, child, reg } = setup();
    for (let i = 0; i < 3; i++) reg.recordSuccess(child.name);
    const ctx = makeCtx();
    const verdict = await water.validatePlan(
      child,
      makePlan({
        reasoning: 'validate_html pass required',
        proposedAction: 'validate_html the page',
        expectedOutput: 'e',
      }),
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('F1(b) hybrid gate: an HTTP child SERVING html gets the browser probe after a content sniff', async () => {
    const { child } = setup();
    const ctx = makeCtx();
    const calls: string[] = [];
    (ctx as { tools?: ToolExecutor }).tools = {
      has: (n: string) => ['validate_html', 'fetch_url', 'read_file', 'list_files'].includes(n),
      execute: async (n: string) => {
        calls.push(n);
        if (n === 'fetch_url')
          return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!DOCTYPE html><html><body>UI</body></html>' };
        if (n === 'validate_html') return { ok: true, url: 'x', errors: [], warnings: [], failedRequests: [] };
        if (n === 'list_files') return { path: '.', entries: [] };
        if (n === 'read_file') return { path: 'server.js', content: 'const http = require("http");' };
        throw new Error('ENOENT');
      },
    };
    const block = await probeGroundTruth({
      ctx,
      subject: 'RESULT',
      // Claims BOTH a file and an html-serving URL — the hybrid shape the
      // review flagged: the browser block must APPEND to the read-back
      // probe, never displace it (the #F9 fabrication guard stays).
      payload: {
        output: { url: 'http://localhost:4321/', files: ['server.js'] },
        summary: 'UI served at http://localhost:4321/, wrote server.js',
      },
      child,
    });
    expect(calls).toContain('read_file'); // the #F9 read-back ran
    expect(calls).toContain('fetch_url'); // the sniff
    expect(calls).toContain('validate_html'); // the browser probe FIRED despite the child not declaring it
    expect(block).toContain('independent file read-back');
    expect(block).toContain('browser probe — hybrid server');
  });

  it('F1(b) hybrid gate is LOOPBACK-ONLY: an external URL triggers no supervisor egress', async () => {
    const { child } = setup();
    const ctx = makeCtx();
    const calls: string[] = [];
    (ctx as { tools?: ToolExecutor }).tools = {
      has: (n: string) => ['validate_html', 'fetch_url', 'read_file', 'list_files'].includes(n),
      execute: async (n: string) => {
        calls.push(n);
        if (n === 'list_files') return { path: '.', entries: [] };
        throw new Error('ENOENT');
      },
    };
    await probeGroundTruth({
      ctx,
      subject: 'RESULT',
      payload: { output: 'done', summary: 'see https://nodejs.org/api/http.html for reference' },
      child,
    });
    expect(calls).not.toContain('fetch_url'); // no egress to model-quoted external URLs
    expect(calls).not.toContain('validate_html');
  });

  it('F1(b) requires a 200: an HTML-flavoured 404 keeps the JSON-API exclusion', async () => {
    const { child } = setup();
    const ctx = makeCtx();
    const calls: string[] = [];
    (ctx as { tools?: ToolExecutor }).tools = {
      has: (n: string) => ['validate_html', 'fetch_url', 'read_file', 'list_files'].includes(n),
      execute: async (n: string) => {
        calls.push(n);
        if (n === 'fetch_url')
          return { status: 404, headers: { 'content-type': 'text/html' }, body: '<html>Cannot GET /</html>' };
        if (n === 'list_files') return { path: '.', entries: [] };
        throw new Error('ENOENT');
      },
    };
    await probeGroundTruth({
      ctx,
      subject: 'RESULT',
      payload: { output: { url: 'http://localhost:4321/' }, summary: 'API at http://localhost:4321/api' },
      child,
    });
    expect(calls).toContain('fetch_url');
    expect(calls).not.toContain('validate_html'); // Express-default 404 page must not flip the probe
  });

  it('F1(b) hybrid gate: a JSON API keeps the original #9 exclusion — no Puppeteer noise', async () => {
    const { child } = setup();
    const ctx = makeCtx();
    const calls: string[] = [];
    (ctx as { tools?: ToolExecutor }).tools = {
      has: (n: string) => ['validate_html', 'fetch_url', 'read_file', 'list_files'].includes(n),
      execute: async (n: string) => {
        calls.push(n);
        if (n === 'fetch_url')
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
        if (n === 'list_files') return { path: '.', entries: [] };
        throw new Error('ENOENT');
      },
    };
    await probeGroundTruth({
      ctx,
      subject: 'RESULT',
      payload: { output: { url: 'http://localhost:4321/api' }, summary: 'API at http://localhost:4321/api' },
      child,
    });
    expect(calls).toContain('fetch_url');
    expect(calls).not.toContain('validate_html'); // the incident-#9 protection holds
  });

  it('an in-scope plan (with a negated echo) falls through to the LLM validator', async () => {
    const { water, child } = setup();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'fine' }));
    const verdict = await water.validatePlan(
      child,
      makePlan({
        reasoning: 'probe over HTTP',
        proposedAction: 'start_node_server then fetch_url every route; no validate_html needed',
        expectedOutput: 'all routes verified',
      }),
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);
    // The validator now SEES the declared surface.
    expect(ctx.llm.calls[0]!.userContent).toContain("Child's DECLARED TOOLS");
    expect(ctx.llm.calls[0]!.userContent).toContain('fetch_url');
  });
});
