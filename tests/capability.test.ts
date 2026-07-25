import { describe, expect, it } from 'vitest';
import {
  CANONICAL_BOOTSTRAP_MARKER,
  CANONICAL_HTTP_BOOTSTRAP_MARKER,
  CANONICAL_L2_HTTP_DESCRIPTION,
  CANONICAL_L2_WEB_DESCRIPTION,
  capabilityDescription,
  looksTaskThemed,
  resolveCreationDescription,
} from '../src/atoms/capability.js';
import type { Tool } from '../src/core/types.js';

function makeTools(names: readonly string[]): Tool[] {
  return names.map((name) => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ ok: true as const, output: 'noop' as unknown }),
  }));
}

describe('capabilityDescription', () => {
  it('picks the web-artefact-build+validate bucket when write + serve + validate are present (tier 1 = builder)', () => {
    const desc = capabilityDescription(
      makeTools(['write_file', 'read_file', 'list_files', 'start_static_server', 'validate_html']),
      1
    );
    expect(desc).toMatch(/single-file web artefact builder/);
    expect(desc).toMatch(/validate_html/);
    // The task-neutral invariant: no domain terms leak in.
    expect(desc).not.toMatch(/chess|minesweeper|mario|puzzle/i);
  });

  it('picks the http-server-build+probe bucket when Node server tools are present (tier 1)', () => {
    const desc = capabilityDescription(
      makeTools([
        'write_file',
        'read_file',
        'list_files',
        'run_shell',
        'fetch_url',
        'start_node_server',
      ]),
      1
    );
    expect(desc).toMatch(/Node HTTP server builder/);
    expect(desc).toMatch(/LISTENING_ON_PORT/);
    // It must NOT describe itself as a web artefact builder — the whole
    // point of the separate bucket is the structural distinction.
    expect(desc).not.toMatch(/single-file web artefact builder/);
    expect(desc).not.toMatch(/validate_html/);
  });

  it('uses the orchestrator variant for the http-server bucket at tier 2', () => {
    const tools = makeTools([
      'write_file',
      'run_shell',
      'fetch_url',
      'start_node_server',
    ]);
    const leaf = capabilityDescription(tools, 1);
    const orch = capabilityDescription(tools, 2);
    expect(leaf).toMatch(/Node HTTP server builder/);
    expect(orch).toMatch(/Node HTTP server orchestrator/);
    expect(orch).not.toBe(leaf);
  });

  it('labels a KITCHEN-SINK toolset (http + web families together) as general-purpose, not HTTP', () => {
    // Regression for the clone-proliferation bug: the full executor set
    // that dynamic children inherit via mergeTools satisfies BOTH the
    // http bucket AND the web bucket. The old first-match rule labelled
    // every such atom "Node HTTP server orchestrator/builder" — a lying
    // specialty that made the domain-match rule refuse reuse for any
    // non-HTTP task, so every CLI run spawned a fresh clone (Ammonia,
    // CarbonDioxide, Glucose, Sucrose, Ethanol…). The honest label is
    // general-purpose — a legitimate reuse target for ANY family.
    const kitchen = makeTools([
      'write_file',
      'read_file',
      'list_files',
      'run_shell',
      'fetch_url',
      'start_node_server',
      'start_static_server',
      'validate_html',
    ]);
    const leaf = capabilityDescription(kitchen, 1);
    const orch = capabilityDescription(kitchen, 2);
    expect(leaf).toMatch(/general-purpose builder \(web \+ HTTP \+ files\)/);
    expect(orch).toMatch(/general-purpose orchestrator \(web \+ HTTP \+ files\)/);
    expect(leaf).not.toMatch(/Node HTTP server builder/);
    expect(orch).not.toMatch(/Node HTTP server orchestrator/);
    expect(orch).not.toBe(leaf);
  });

  it('still prefers the http-server bucket when the toolset is http-flavoured WITHOUT the full web family', () => {
    // Bucket order discipline survives the general-purpose rule: an
    // http toolset that also carries start_static_server (but NOT
    // validate_html — so the web-build+validate bucket does not match)
    // stays a Node HTTP builder rather than degrading to static-site.
    const httpish = makeTools([
      'write_file',
      'run_shell',
      'fetch_url',
      'start_node_server',
      'start_static_server',
    ]);
    const desc = capabilityDescription(httpish, 1);
    expect(desc).toMatch(/Node HTTP server builder/);
    expect(desc).not.toMatch(/general-purpose/);
  });

  it('falls back to write+serve when validate_html is missing (tier 1)', () => {
    const desc = capabilityDescription(
      makeTools(['write_file', 'read_file', 'start_static_server']),
      1
    );
    expect(desc).toMatch(/static-site runner/);
    expect(desc).not.toMatch(/validate_html/);
  });

  it('appends auxiliary capabilities for fetch_url / run_shell at tier 1', () => {
    const desc = capabilityDescription(
      makeTools(['write_file', 'start_static_server', 'validate_html', 'fetch_url', 'run_shell']),
      1
    );
    expect(desc).toMatch(/single-file web artefact builder/);
    expect(desc).toMatch(/fetches arbitrary HTTP URLs/);
    expect(desc).toMatch(/executes shell commands/);
  });

  it('produces a stable custom-toolset label when no known capability matches (tier 1)', () => {
    const a = capabilityDescription(makeTools(['rare_tool_b', 'rare_tool_a']), 1);
    const b = capabilityDescription(makeTools(['rare_tool_a', 'rare_tool_b']), 1);
    expect(a).toBe(b);
    expect(a).toMatch(/custom leaf toolset/);
    // Stable ordering: sort alphabetically so different insertion orders collapse.
    expect(a).toContain('rare_tool_a, rare_tool_b');
  });

  it('is deterministic across calls for the same tool signature + tier', () => {
    const tools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    expect(capabilityDescription(tools, 1)).toBe(capabilityDescription(tools, 1));
    expect(capabilityDescription(tools, 2)).toBe(capabilityDescription(tools, 2));
  });

  it('uses the orchestrator variant of the bucket at tier 2 so L2s never read as L1 builders', () => {
    const tools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    const leaf = capabilityDescription(tools, 1);
    const orch = capabilityDescription(tools, 2);
    expect(orch).toMatch(/single-file web artefact orchestrator/);
    expect(orch).toMatch(/routes a leaf task to a tier-1 builder/);
    expect(orch).not.toBe(leaf);
    // L1-builder-only phrasing must NOT appear in the L2 label, else
    // prefilter on L3 side could cross-match an L1 as an L2.
    expect(orch).not.toMatch(/^single-file web artefact builder/);
  });

  it('wraps auxiliary tool labels with delegation framing at tier 2', () => {
    const tools = makeTools(['fetch_url', 'run_shell']);
    const leaf = capabilityDescription(tools, 1);
    const orch = capabilityDescription(tools, 2);
    expect(leaf).toMatch(/fetches arbitrary HTTP URLs/);
    expect(orch).toMatch(/delegating to a tier-1 atom that fetches arbitrary HTTP URLs/);
    expect(orch).toMatch(/delegating to a tier-1 atom that executes shell commands/);
  });

  it('distinguishes custom toolsets by tier as well', () => {
    const tools = makeTools(['rare_tool_a', 'rare_tool_b']);
    expect(capabilityDescription(tools, 1)).toMatch(/custom leaf toolset/);
    expect(capabilityDescription(tools, 2)).toMatch(/custom orchestrator toolset/);
    expect(capabilityDescription(tools, 3)).toMatch(/custom top-level cell toolset/);
  });
});

describe('looksTaskThemed', () => {
  it('flags well-known game/app themes', () => {
    expect(looksTaskThemed('L1 for subtask: Build a chess puzzle')).toBe(true);
    expect(looksTaskThemed('minesweeper builder with flag icons')).toBe(true);
    expect(looksTaskThemed('Mate-in-1 puzzle engine')).toBe(true);
  });

  it('flags grid dimensions', () => {
    expect(looksTaskThemed('builder for a 10x10 board')).toBe(true);
    expect(looksTaskThemed('8 x 8 grid rendering engine')).toBe(true);
  });

  it('flags UI verbs that always come from the task', () => {
    expect(looksTaskThemed('drag-and-drop builder')).toBe(true);
  });

  it('flags the legacy "L1 for subtask:" preamble', () => {
    expect(looksTaskThemed('L1 for subtask: fetch some URL')).toBe(true);
  });

  it('flags descriptions longer than 200 chars as narrative', () => {
    // 200, not the original 140: Opus/Sonnet-authored role seeds
    // ("CLI/file project orchestrator: routes file-authoring leaves…")
    // routinely run 150-190 chars, and at 140 nearly every legitimate
    // seed was dropped in favour of the tool-derived label — which for
    // kitchen-sink toolsets used to be the lying HTTP one.
    expect(looksTaskThemed('x'.repeat(201))).toBe(true);
    expect(looksTaskThemed('x'.repeat(180))).toBe(false);
    expect(looksTaskThemed('x'.repeat(50))).toBe(false);
  });

  it('honours a realistic 150-190 char planner role seed (regression: clone proliferation)', () => {
    const plannerSeed =
      'CLI/file project orchestrator: routes file-authoring and shell-verified build leaves to a tier-1 file scribe; verifies deliverables via node and npm probes, no HTTP serving';
    expect(plannerSeed.length).toBeGreaterThan(140); // would have been dropped before
    expect(plannerSeed.length).toBeLessThanOrEqual(200);
    expect(looksTaskThemed(plannerSeed)).toBe(false);
  });

  it('does NOT flag capability-style descriptions', () => {
    expect(
      looksTaskThemed(
        'single-file web artefact builder: writes an index.html on disk, serves it locally'
      )
    ).toBe(false);
    expect(looksTaskThemed('file scribe: reads, writes, and lists workspace files')).toBe(false);
  });
});

describe('resolveCreationDescription', () => {
  const webTools = makeTools(['write_file', 'start_static_server', 'validate_html']);

  it('returns the canonical capability label at the requested tier when no suggestion is provided', () => {
    expect(resolveCreationDescription(undefined, webTools, 1)).toBe(
      capabilityDescription(webTools, 1)
    );
    expect(resolveCreationDescription(undefined, webTools, 2)).toBe(
      capabilityDescription(webTools, 2)
    );
  });

  it('replaces task-themed suggestions with the tier-appropriate canonical label', () => {
    const themed = 'L1 for subtask: build a chess puzzle with 8x8 grid and drag-and-drop';
    expect(resolveCreationDescription(themed, webTools, 1)).toBe(
      capabilityDescription(webTools, 1)
    );
    expect(resolveCreationDescription(themed, webTools, 2)).toBe(
      capabilityDescription(webTools, 2)
    );
  });

  it('honours a clean, generic suggestion regardless of tier', () => {
    const suggestion = 'focused HTML writer specialised for single-file deliverables';
    expect(resolveCreationDescription(suggestion, webTools, 1)).toBe(suggestion);
    expect(resolveCreationDescription(suggestion, webTools, 2)).toBe(suggestion);
  });

  it('treats blank suggestions as missing', () => {
    expect(resolveCreationDescription('   ', webTools, 1)).toBe(
      capabilityDescription(webTools, 1)
    );
  });
});

describe('canonical-bootstrap constants', () => {
  it('exposes a marker + L2 description callers can rely on', () => {
    expect(CANONICAL_BOOTSTRAP_MARKER).toBe('bootstrap-canonical');
    expect(CANONICAL_L2_WEB_DESCRIPTION).toMatch(/single-file web artefact orchestrator/);
  });

  it('CANONICAL_L2_WEB_DESCRIPTION matches capabilityDescription at tier 2 for the web bucket', () => {
    const webTools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    expect(CANONICAL_L2_WEB_DESCRIPTION).toBe(capabilityDescription(webTools, 2));
  });

  it('exposes a distinct HTTP marker + L2 description alongside the web ones', () => {
    expect(CANONICAL_HTTP_BOOTSTRAP_MARKER).toBe('bootstrap-canonical-http');
    expect(CANONICAL_HTTP_BOOTSTRAP_MARKER).not.toBe(CANONICAL_BOOTSTRAP_MARKER);
    expect(CANONICAL_L2_HTTP_DESCRIPTION).toMatch(/Node HTTP server orchestrator/);
  });

  it('CANONICAL_L2_HTTP_DESCRIPTION matches capabilityDescription at tier 2 for the http bucket', () => {
    const httpTools = makeTools([
      'write_file',
      'run_shell',
      'fetch_url',
      'start_node_server',
    ]);
    expect(CANONICAL_L2_HTTP_DESCRIPTION).toBe(capabilityDescription(httpTools, 2));
  });
});
