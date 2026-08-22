import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom, taskRequiresRealBrowser } from '../src/atoms/L2Atom.js';
import { L3Atom, routeCrossBucketVerification } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { preservePlanLiteralContracts } from '../src/atoms/prompts.js';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * Regression tests for the "VERIFICATION MATCHES THE ARTEFACT" rule in
 * both plan prompts. Observed failure (clock-cli live run, 2026-07-25):
 * L3's Opus plan gave a Node CLI build a "serve + validate_html"
 * phase 2 — Water burned 9 failed start_static_server boots and
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

/**
 * A3+ is deliberately a planning-policy change, not a mechanical plan gate.
 * Pin the concepts rather than one long paragraph so harmless wrapping edits
 * stay possible while none of the independently load-bearing exceptions can
 * disappear unnoticed.
 */
function expectCohesiveProofClosureGuidance(prompt: string): void {
  expect(prompt).toMatch(
    /verification\s+is\s+an?\s+(?:required\s+)?outcome,\s+not\s+a\s+default(?:\s+extra)?\s+(?:phase|responsibility)/i
  );
  expect(prompt).toMatch(/write\s*(?:→|->)\s*(?:boot\/serve|boot|serve)\s*(?:→|->)\s*probe/i);
  expect(prompt).toMatch(/cohesive[\s\S]{0,320}(?:one|same)[\s\S]{0,60}(?:tool )?bucket/i);
  expect(prompt).toMatch(/(?:N\s*=\s*1[\s\S]{0,100}valid|valid N\s*=\s*1)/i);
  expect(prompt).toMatch(/explicit(?:ly)?[\s\S]{0,80}(?:separate[- ]phase|demands them)/i);
  expect(prompt).toMatch(/cross(?:ing|es)?[\s\S]{0,40}(?:executable |L1 )?tool buckets?/i);
  expect(prompt).toMatch(/later\s+(?:phase\s+)?mutation[\s\S]{0,50}invalidates prior proof/i);
  expect(prompt).toMatch(/new[\s\S]{0,25}claim[\s\S]{0,30}fresh (?:proof|evidence)/i);
  expect(prompt).toMatch(/different expertise/i);
  expect(prompt).toMatch(/volatile[- ]state[\s\S]{0,100}(?:fresh|observ|distinct)/i);
}

function expectNoSupersededPhasePressure(prompt: string): void {
  expect(prompt).not.toMatch(/For non-trivial tasks emit 2-5 subtasks/i);
  expect(prompt).not.toMatch(/Use this whenever phases need to verify each other's work/i);
  expect(prompt).not.toMatch(/One big monolithic subtask[\s\S]{0,160}phase-by-phase smoke validation/i);
  expect(prompt).not.toMatch(/A separate final validation phase is the norm/i);
  expect(prompt).not.toMatch(/For apps, libraries, builds, multi-step procedures: ALWAYS emit ≥2 subtasks/i);
  expect(prompt).not.toMatch(/For app\/game\/library builds, prefer N>=2/i);
  expect(prompt).not.toMatch(/build\s*→\s*extend\s*→\s*smoke/i);
}

describe('plan prompts — VERIFICATION MATCHES THE ARTEFACT', () => {
  it('the L3 Opus plan prompt carries the artefact-matched verification rule', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    const l3Type = r.create(3, seed);
    r.create(2, seed); // Tracheid
    const l3 = L3Atom.buildWithModel(l3Type, r, FALLBACK_OPUS);
    const ctx = makeCtx();
    // Prefilter escalates; the Opus plan call is call #1.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: 't', preferredChild: 'Tracheid' }],
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
    expect(planPrompt).toMatch(/FULL-STACK CROSS-BUCKET RULE/);
    expect(planPrompt).toMatch(/never rename, replace or summarise away/);
    expectCohesiveProofClosureGuidance(planPrompt);
    expectNoSupersededPhasePressure(planPrompt);
  });

  it('the L2 Sonnet plan prompt carries the same rule (short form)', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(2, seed); // Tracheid
    r.create(1, { ...seed, description: 'file scribe' }); // Water
    const l2 = L2Atom.fromType(r.getByName('Tracheid')!, r);
    const ctx = makeCtx();
    // Prefilter escalates; the Sonnet plan call is call #1.
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
    await l2.plan({ description: 'build a tiny Node CLI utility' }, ctx);

    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toMatch(/== VERIFICATION MATCHES THE ARTEFACT ==/);
    expect(planPrompt).toMatch(/NEVER send a non-browser/);
    expect(planPrompt).toMatch(/fabricate/);
    expect(planPrompt).toMatch(/== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==/);
    expect(planPrompt).toMatch(/exact intended output path/);
    expect(planPrompt).toMatch(/HTTP DOCUMENTATION USES A PORT PLACEHOLDER/);
    expect(planPrompt).toMatch(/PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION/);
    expect(planPrompt).toMatch(/REAL browser must route to an L1/);
    expectCohesiveProofClosureGuidance(planPrompt);
    expectNoSupersededPhasePressure(planPrompt);
  });

  it('keeps the A3+ topology contract aligned in the shared plan validator', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /verification\s+is\s+an?\s+(?:required\s+)?outcome,\s+not\s+a\s+default(?:\s+extra)?\s+(?:phase|responsibility)/i
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/cohesive[\s\S]{0,400}N\s*=\s*1/i);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /explicit(?:ly)?[\s\S]{0,40}separate[- ]phase/i
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /later\s+mutation[\s\S]{0,120}(?:invalidates|fresh evidence|new claim)/i
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/new[\s\S]{0,25}claim/i);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /cross(?:ing|es)?[\s\S]{0,40}executable tool buckets/i
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/volatile state/i);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/different expertise/i);
    // Structural failures remain failures: A3+ only changes topology preference.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/NO\s+subtask depends on another's output/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Artefact-collision rule/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/sequential plan has only one subtask/);
    expectNoSupersededPhasePressure(VALIDATION_SYSTEM_PROMPT);
  });

  it('shows the explicit FINAL SEPARATE audit beside the rule that preserves it', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    const l3Type = r.create(3, seed);
    r.create(2, seed);
    const l3 = L3Atom.buildWithModel(l3Type, r, FALLBACK_OPUS);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: 'build', preferredChild: 'Tracheid' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'stub',
        }
      )
    );
    const audit =
      'As a FINAL SEPARATE PHASE, re-verify every documented invocation exactly as written.';

    await l3.plan({ description: `Build a tiny CLI. ${audit}` }, ctx);

    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toContain(audit);
    expect(planPrompt).toMatch(/explicit(?:ly)?[\s\S]{0,80}separate[- ]phase/i);
  });
});

describe('preservePlanLiteralContracts', () => {
  it('mechanically carries exact HTTP schema clauses into every phase', () => {
    const goal =
      'Build POST /labels accepting {"name": string, "color": "#RRGGBB"} and GET /labels. ' +
      'Reject blank names, wrong types, and malformed colors with status 400.';
    const plan = makePlan({
      subtasks: [
        { description: 'Build the labels API.', preferredChild: 'Sclereid', inputs: {} },
        { description: 'Verify proper validation.', preferredChild: 'Sclereid', inputs: {} },
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

describe('cross-bucket browser routing', () => {
  it('splits a mixed final checkpoint and routes browser/shell phases separately', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser', inputSchema: { type: 'object' } },
      ],
    });
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'run_shell', description: 'shell', inputSchema: { type: 'object' } },
        {
          name: 'start_node_server',
          description: 'server',
          inputSchema: { type: 'object' },
        },
      ],
    });
    const plan = makePlan({
      subtasks: [
        {
          description:
            'Validate the UI in a real browser with selector-based interactions and zero console errors.',
          preferredChild: 'Sclereid',
          inputs: {},
        },
        {
          description:
            'Reconfirm the UI probe in a real browser with selector-based interactions. Run node test-api.js and require it to pass.',
          preferredChild: 'Sclereid',
          inputs: {},
        },
      ],
      aggregation: { mode: 'sequential' },
    });
    const routed = routeCrossBucketVerification(plan, registry);
    expect(routed.subtasks).toHaveLength(3);
    expect(routed.subtasks[0]!.preferredChild).toBe('Tracheid');
    expect(routed.subtasks[1]!.description).toMatch(/BROWSER VERIFICATION ONLY/);
    expect(routed.subtasks[1]!.preferredChild).toBe('Tracheid');
    expect(routed.subtasks[2]!.description).toMatch(/FINAL SHELL\/HARNESS/);
    expect(routed.subtasks[2]!.description).toContain('node test-api.js');
    expect(routed.subtasks[2]!.preferredChild).toBe('Sclereid');
    expect(taskRequiresRealBrowser(routed.subtasks[2]!.description)).toBe(false);
    expect(routed.aggregation.mode).toBe('sequential');
  });

  it('keeps an already-capable web L2 and preserves explicit parallel aggregation', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser A', inputSchema: { type: 'object' } },
      ],
    });
    const secondWeb = registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser B', inputSchema: { type: 'object' } },
      ],
    });
    const plan = makePlan({
      subtasks: [
        {
          description: 'Validate the UI in a real browser with selector-based interactions.',
          preferredChild: secondWeb.name,
          inputs: {},
        },
      ],
      aggregation: { mode: 'concat' },
    });

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed).toBe(plan);
    expect(routed.subtasks[0]!.preferredChild).toBe(secondWeb.name);
    expect(routed.aggregation.mode).toBe('concat');
  });

  it('does not overwrite concat when a browser subtask needs rerouting', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser', inputSchema: { type: 'object' } },
      ],
    });
    const shell = registry.create(2, {
      ...seed,
      tools: [
        { name: 'run_shell', description: 'shell', inputSchema: { type: 'object' } },
        { name: 'start_node_server', description: 'server', inputSchema: { type: 'object' } },
      ],
    });
    const plan = makePlan({
      subtasks: [
        {
          description: 'Validate the UI in a real browser with selector-based interactions.',
          preferredChild: shell.name,
          inputs: {},
        },
      ],
      aggregation: { mode: 'concat' },
    });

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed.subtasks[0]!.preferredChild).not.toBe(shell.name);
    expect(routed.aggregation.mode).toBe('concat');
  });

  it('redirects a browser prefilter away from an HTTP-only L1', async () => {
    expect(taskRequiresRealBrowser('validate the UI in a real browser')).toBe(true);
    expect(taskRequiresRealBrowser('Reconfirm the recorded web probe remains valid.')).toBe(
      true
    );
    expect(
      taskRequiresRealBrowser(
        'Create server.js and probe its API.\n\n== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==\nRecord a selector-based web probe for window.__test.'
      )
    ).toBe(false);
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, seed);
    registry.create(1, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser', inputSchema: { type: 'object' } },
      ],
    });
    registry.create(1, {
      ...seed,
      tools: [
        {
          name: 'start_node_server',
          description: 'server',
          inputSchema: { type: 'object' },
        },
      ],
    });
    const l2 = L2Atom.fromType(registry.getByName('Tracheid')!, registry);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Methane',
        confidence: 'high',
        reasoning: 'server owns the UI',
      })
    );
    const plan = await l2.plan(
      {
        description:
          'Validate the UI in a real browser with selector-based interactions and zero console errors.',
      },
      ctx
    );
    expect(plan.subtasks[0]!.preferredChild).toBe('Water');
    expect(ctx.llm.calls).toHaveLength(1);
  });
});
