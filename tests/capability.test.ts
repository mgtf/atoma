import { describe, expect, it } from 'vitest';
import {
  CANONICAL_BOOTSTRAP_MARKER,
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
  it('picks the web-artefact-build+validate bucket when write + serve + validate are present', () => {
    const desc = capabilityDescription(
      makeTools(['write_file', 'read_file', 'list_files', 'start_static_server', 'validate_html'])
    );
    expect(desc).toMatch(/single-file web artefact builder/);
    expect(desc).toMatch(/validate_html/);
    // The task-neutral invariant: no domain terms leak in.
    expect(desc).not.toMatch(/chess|minesweeper|mario|puzzle/i);
  });

  it('falls back to write+serve when validate_html is missing', () => {
    const desc = capabilityDescription(
      makeTools(['write_file', 'read_file', 'start_static_server'])
    );
    expect(desc).toMatch(/static-site runner/);
    expect(desc).not.toMatch(/validate_html/);
  });

  it('appends auxiliary capabilities for fetch_url / run_shell', () => {
    const desc = capabilityDescription(
      makeTools(['write_file', 'start_static_server', 'validate_html', 'fetch_url', 'run_shell'])
    );
    expect(desc).toMatch(/single-file web artefact builder/);
    expect(desc).toMatch(/fetches arbitrary HTTP URLs/);
    expect(desc).toMatch(/executes shell commands/);
  });

  it('produces a stable custom-toolset label when no known capability matches', () => {
    const a = capabilityDescription(makeTools(['rare_tool_b', 'rare_tool_a']));
    const b = capabilityDescription(makeTools(['rare_tool_a', 'rare_tool_b']));
    expect(a).toBe(b);
    expect(a).toMatch(/custom toolset/);
    // Stable ordering: sort alphabetically so different insertion orders collapse.
    expect(a).toContain('rare_tool_a, rare_tool_b');
  });

  it('is deterministic across calls for the same tool signature', () => {
    const tools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    expect(capabilityDescription(tools)).toBe(capabilityDescription(tools));
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

  it('flags descriptions longer than 140 chars as narrative', () => {
    expect(looksTaskThemed('x'.repeat(141))).toBe(true);
    expect(looksTaskThemed('x'.repeat(50))).toBe(false);
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

  it('returns the canonical capability label when no suggestion is provided', () => {
    const out = resolveCreationDescription(undefined, webTools);
    expect(out).toBe(capabilityDescription(webTools));
  });

  it('replaces task-themed suggestions with the canonical label', () => {
    const out = resolveCreationDescription(
      'L1 for subtask: build a chess puzzle with 8x8 grid and drag-and-drop',
      webTools
    );
    expect(out).toBe(capabilityDescription(webTools));
  });

  it('honours a clean, generic suggestion', () => {
    const suggestion = 'focused HTML writer specialised for single-file deliverables';
    const out = resolveCreationDescription(suggestion, webTools);
    expect(out).toBe(suggestion);
  });

  it('treats blank suggestions as missing', () => {
    expect(resolveCreationDescription('   ', webTools)).toBe(capabilityDescription(webTools));
  });
});

describe('canonical-bootstrap constants', () => {
  it('exposes a marker + L2 description callers can rely on', () => {
    expect(CANONICAL_BOOTSTRAP_MARKER).toBe('bootstrap-canonical');
    expect(CANONICAL_L2_WEB_DESCRIPTION).toMatch(/web artefact orchestrator/);
  });
});
