import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { preservePlanLiteralContracts } from '../src/atoms/prompts.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * Regression tests for the "VERIFICATION MATCHES THE ARTEFACT" rule in
 * both plan prompts. Observed failure (clock-cli live run, 2026-07-25):
 * L3's Opus plan gave a Node CLI build a "serve + validate_html"
 * phase 2 — Hydrogen burned 9 failed start_static_server boots and
 * fabricated a parasitic index.html just to have something to serve.
 * The plan prompts must steer verification to the probe matching the
 * artefact's nature (browser page → validate_html; HTTP API →
 * fetch_url; CLI/files → run_shell + read-back).
 */

const seed = {
  description: 'orchestrator',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('plan prompts — VERIFICATION MATCHES THE ARTEFACT', () => {
  it('the L3 Opus plan prompt carries the artefact-matched verification rule', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    const l3Type = r.create(3, seed);
    r.create(2, seed); // Water
    const l3 = L3Atom.buildWithModel(l3Type, r, FALLBACK_OPUS);
    const ctx = makeCtx();
    // Prefilter escalates; the Opus plan call is call #1.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: 't', preferredChild: 'Water' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'stub',
        }
      )
    );
    await l3.plan({ description: 'build a tiny Node CLI utility' }, ctx);

    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toMatch(/== VERIFICATION MATCHES THE ARTEFACT ==/);
    // The three artefact families each name their probe.
    expect(planPrompt).toMatch(/start_static_server \+ validate_html/);
    expect(planPrompt).toMatch(/start_node_server \+ fetch_url/);
    expect(planPrompt).toMatch(/run_shell executing the/);
    // The observed failure mode is called out as a plan defect.
    expect(planPrompt).toMatch(/PLAN DEFECT/);
    expect(planPrompt).toMatch(/NO static server, NO/);
    expect(planPrompt).toMatch(/== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==/);
    expect(planPrompt).toMatch(/"harden index\.js"/);
    expect(planPrompt).toMatch(/read-only verifier.*replay old probes/s);
    expect(planPrompt).toMatch(/SEMANTIC entry/);
    expect(planPrompt).toMatch(/"csv2json\.js"/);
    expect(planPrompt).toMatch(/generic launcher.*"index\.js"/s);
    expect(planPrompt).toMatch(/HTTP DOCUMENTATION USES A PORT PLACEHOLDER/);
    expect(planPrompt).toMatch(/http:\/\/localhost:<port>/);
    expect(planPrompt).toMatch(/LISTENING_ON_PORT=<port>/);
    expect(planPrompt).toMatch(/PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION/);
    expect(planPrompt).toMatch(/never rename, replace or summarise away/);
  });

  it('the L2 Sonnet plan prompt carries the same rule (short form)', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(2, seed); // Water
    r.create(1, { ...seed, description: 'file scribe' }); // Hydrogen
    const l2 = L2Atom.fromType(r.getByName('Water')!, r);
    const ctx = makeCtx();
    // Prefilter escalates; the Sonnet plan call is call #1.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Hydrogen', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: 't', preferredChild: 'Hydrogen' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'stub',
        }
      )
    );
    await l2.plan({ description: 'build a tiny Node CLI utility' }, ctx);

    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toMatch(/== VERIFICATION MATCHES THE ARTEFACT ==/);
    expect(planPrompt).toMatch(/NEVER send a non-browser/);
    expect(planPrompt).toMatch(/fabricate/);
    expect(planPrompt).toMatch(/== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==/);
    expect(planPrompt).toMatch(/exact intended output path/);
    expect(planPrompt).toMatch(/HTTP DOCUMENTATION USES A PORT PLACEHOLDER/);
    expect(planPrompt).toMatch(/PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION/);
  });
});

describe('preservePlanLiteralContracts', () => {
  it('mechanically carries exact HTTP schema clauses into every phase', () => {
    const goal =
      'Build POST /labels accepting {"name": string, "color": "#RRGGBB"} and GET /labels. ' +
      'Reject blank names, wrong types, and malformed colors with status 400.';
    const plan = makePlan({
      subtasks: [
        { description: 'Build the labels API.', preferredChild: 'Methane', inputs: {} },
        { description: 'Verify proper validation.', preferredChild: 'Methane', inputs: {} },
      ],
      aggregation: { mode: 'sequential' },
    });
    const enriched = preservePlanLiteralContracts(plan, goal);
    for (const subtask of enriched.subtasks) {
      expect(subtask.description).toContain('== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==');
      expect(subtask.description).toContain('{"name": string, "color": "#RRGGBB"}');
      expect(subtask.description).toContain('Reject blank names, wrong types');
    }
    expect(
      preservePlanLiteralContracts(enriched, enriched.subtasks[0]!.description).subtasks[0]!
        .description.match(/LITERAL CONTRACTS FROM TOP-LEVEL GOAL/g)
    ).toHaveLength(1);
  });

  it('leaves tasks without a structured literal contract untouched', () => {
    const plan = makePlan();
    expect(preservePlanLiteralContracts(plan, 'Write a friendly introduction.')).toBe(plan);
  });
});
