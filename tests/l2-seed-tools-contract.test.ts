import { describe, it, expect, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import type { Tool } from '../src/core/types.js';
import { makeCtx, jsonTextPair, silentLogger } from './helpers.js';

/**
 * A "create" seed's `tools` are NAMES the schema drops: the created L1
 * inherits exactly its cell's toolset. The notes-app run of 2026-09-07
 * showed the cost of leaving that implicit — the web cell "created" an L1
 * for a Node-server subtask, its start_node_server/fetch_url request was
 * silently dropped, the child's plans were mechanically rejected for
 * naming them, and three escalations later the fallback rewrote a
 * validated server.js with a python static server as its only probe.
 *
 * The contract is now stated where the planner decides (the prompt names
 * the peers' toolsets so "mutualize" is a visible way out) and the drop is
 * logged at plan time.
 */
const tool = (name: string): Tool => ({
  name,
  description: `${name} element`,
  inputSchema: { type: 'object', properties: {} },
});

function makeCells(): { web: L2Atom; http: L2Atom; reg: AtomRegistry } {
  const reg = new AtomRegistry(openDb(':memory:'));
  const webType = reg.create(2, {
    description: 'single-file web artefact orchestrator',
    systemPrompt: 'sys',
    tools: [tool('write_file'), tool('start_static_server'), tool('validate_html')],
    params: {},
    createdBy: 'test',
  });
  const httpType = reg.create(2, {
    description: 'Node HTTP server orchestrator',
    systemPrompt: 'sys',
    tools: [tool('write_file'), tool('start_node_server'), tool('fetch_url')],
    params: {},
    createdBy: 'test',
  });
  const web = L2Atom.fromType(webType, reg);
  const http = L2Atom.fromType(httpType, reg);
  web.addPeer(http);
  http.addPeer(web);
  return { web, http, reg };
}

const createPlan = (seedTools: string[]) =>
  jsonTextPair(
    {
      strategy: 'create',
      seed: { description: 'node + browser builder', systemPrompt: 'y', tools: seedTools, params: {} },
      reasoning: 'no catalogued L1 combines both',
    },
    {
      reasoning: 'r',
      subtasks: [{ description: 'build and verify', outputs: ['server.js'] }],
      aggregation: { mode: 'concat' },
      expectedOutput: 'e',
    }
  );

describe('L2 create seed — tool names cannot grow the toolset', () => {
  it('the plan prompt names each peer WITH its toolset and states that a seed cannot add tools', async () => {
    const { web } = makeCells();
    const ctx = makeCtx();
    ctx.llm.enqueueText(createPlan([]));

    await web.plan({ description: 'verify the notes page against the running server' }, ctx);

    const prompt = ctx.llm.calls[ctx.llm.calls.length - 1]!.userContent;
    expect(prompt).toMatch(/Sclereid — tools: write_file, start_node_server, fetch_url/);
    expect(prompt).toContain('A "create" seed CANNOT add tools');
    expect(prompt).toContain('"mutualize" to the peer that lists it');
  });

  it('warns at plan time when the seed asks for tools the cell does not hold', async () => {
    const { web } = makeCells();
    const logger = { ...silentLogger(), warn: vi.fn() };
    const ctx = makeCtx({ logger });
    ctx.llm.enqueueText(createPlan(['write_file', 'start_node_server', 'fetch_url', 'validate_html']));

    await web.plan({ description: 'verify the notes page against the running server' }, ctx);

    const warnings = logger.warn.mock.calls.map((c) => String(c[0]));
    const dropped = warnings.find((w) => w.includes('create seed asked for tool(s) this cell does not hold'));
    expect(dropped).toBeDefined();
    expect(dropped).toContain('start_node_server, fetch_url');
    expect(dropped).not.toContain('validate_html,');
    expect(dropped).toContain('inherits only write_file, start_static_server, validate_html');
  });

  it('stays silent when every requested tool is already held', async () => {
    const { web } = makeCells();
    const logger = { ...silentLogger(), warn: vi.fn() };
    const ctx = makeCtx({ logger });
    ctx.llm.enqueueText(createPlan(['write_file', 'validate_html']));

    await web.plan({ description: 'build a page' }, ctx);

    expect(
      logger.warn.mock.calls.some((c) => String(c[0]).includes('create seed asked for tool(s)'))
    ).toBe(false);
  });
});

describe('L3 plan catalogue — each cell is listed with the tools its L1s can hold', () => {
  it('shows the toolset under every cell and tells the planner not to route past it', async () => {
    const { reg } = makeCells();
    const l3Type = reg.create(3, {
      description: 'builds apps end-to-end',
      systemPrompt: 'sys',
      tools: [tool('write_file'), tool('start_static_server'), tool('validate_html'), tool('start_node_server'), tool('fetch_url')],
      params: {},
      createdBy: 'test',
    });
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const ctx = makeCtx();
    // Prefilter (haiku) escalates, then the Opus plan pair.
    ctx.llm.enqueueText(JSON.stringify({ kind: 'escalate', reasoning: 'composite' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Sclereid', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [{ description: 'build the server', preferredChild: 'Sclereid', outputs: ['server.js'] }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'e',
        }
      )
    );

    await l3.plan({ description: 'a notes server with a page' }, ctx);

    const prompt = ctx.llm.calls[ctx.llm.calls.length - 1]!.userContent;
    expect(prompt).toContain('L2 catalog (cells, each with the tools its L1s can hold):');
    expect(prompt).toMatch(/- Tracheid: [^\n]*\n\s+tools: write_file, start_static_server, validate_html/);
    expect(prompt).toMatch(/- Sclereid: [^\n]*\n\s+tools: write_file, start_node_server, fetch_url/);
    expect(prompt).toContain('do not route a phase to a cell that lacks the tool its proof needs');
  });
});
