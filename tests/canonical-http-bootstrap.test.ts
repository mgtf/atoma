import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import {
  CANONICAL_BOOTSTRAP_MARKER,
  CANONICAL_HTTP_BOOTSTRAP_MARKER,
  CANONICAL_L2_HTTP_DESCRIPTION,
  capabilityDescription,
  ensureCanonicalHttpL1,
  ensureCanonicalHttpL2,
  ensureCanonicalL1,
  ensureCanonicalL2,
} from '../src/atoms/capability.js';
import type { Tool } from '../src/core/types.js';

function makeTools(names: readonly string[]): Tool[] {
  return names.map((name) => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ ok: true as const, output: 'noop' }),
  }));
}

// Kitchen-sink toolset, as build-app.ts would pass it after the #4 refactor.
const KITCHEN_SINK = makeTools([
  'write_file',
  'read_file',
  'list_files',
  'run_shell',
  'start_static_server',
  'validate_html',
  'fetch_url',
  'start_node_server',
]);

const SMOKE = '== SMOKE-TEST DESIGN ==\nstub';

describe('ensureCanonicalHttpL1 / ensureCanonicalHttpL2 — bootstrap', () => {
  it('creates a canonical HTTP L1 with the HTTP bucket label and dedicated marker', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalHttpL1(reg, KITCHEN_SINK);
    expect(l1.tier).toBe(1);
    expect(l1.createdBy).toBe(CANONICAL_HTTP_BOOTSTRAP_MARKER);
    expect(l1.description).toMatch(/Node HTTP server builder/);
    expect(l1.systemPrompt).toMatch(/LISTENING_ON_PORT/);
    // The HTTP L1 must NOT advertise web tools.
    expect(l1.tools.map((t) => t.name)).not.toContain('start_static_server');
    expect(l1.tools.map((t) => t.name)).not.toContain('validate_html');
    // But DOES carry its own scope.
    expect(l1.tools.map((t) => t.name).sort()).toEqual(
      ['fetch_url', 'list_files', 'read_file', 'run_shell', 'start_node_server', 'write_file']
    );
  });

  it('creates a canonical HTTP L2 with the matching orchestrator label', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2 = ensureCanonicalHttpL2(reg, KITCHEN_SINK);
    expect(l2.tier).toBe(2);
    expect(l2.createdBy).toBe(CANONICAL_HTTP_BOOTSTRAP_MARKER);
    expect(l2.description).toBe(CANONICAL_L2_HTTP_DESCRIPTION);
    expect(l2.systemPrompt).toMatch(/Node HTTP server builds/);
  });

  it('web and HTTP canonicals coexist — neither overwrites the other', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webL1 = ensureCanonicalL1(reg, KITCHEN_SINK, SMOKE);
    const httpL1 = ensureCanonicalHttpL1(reg, KITCHEN_SINK);
    expect(webL1.name).not.toBe(httpL1.name);
    expect(webL1.createdBy).toBe(CANONICAL_BOOTSTRAP_MARKER);
    expect(httpL1.createdBy).toBe(CANONICAL_HTTP_BOOTSTRAP_MARKER);
    expect(webL1.description).toMatch(/single-file web artefact builder/);
    expect(httpL1.description).toMatch(/Node HTTP server builder/);

    const webL2 = ensureCanonicalL2(reg, KITCHEN_SINK);
    const httpL2 = ensureCanonicalHttpL2(reg, KITCHEN_SINK);
    expect(webL2.name).not.toBe(httpL2.name);
    expect(webL2.description).toMatch(/single-file web artefact orchestrator/);
    expect(httpL2.description).toMatch(/Node HTTP server orchestrator/);

    // Registry has exactly two L1s and two L2s.
    expect(reg.listByTier(1)).toHaveLength(2);
    expect(reg.listByTier(2)).toHaveLength(2);
  });

  it('is idempotent — repeated bootstraps patch the existing entries rather than cloning', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const first1 = ensureCanonicalHttpL1(reg, KITCHEN_SINK);
    const second1 = ensureCanonicalHttpL1(reg, KITCHEN_SINK);
    expect(second1.name).toBe(first1.name);
    expect(reg.listByTier(1)).toHaveLength(1);

    const first2 = ensureCanonicalHttpL2(reg, KITCHEN_SINK);
    const second2 = ensureCanonicalHttpL2(reg, KITCHEN_SINK);
    expect(second2.name).toBe(first2.name);
    expect(reg.listByTier(2)).toHaveLength(1);
  });

  it('web canonical stays web-scoped even when the caller passes the kitchen-sink toolset', () => {
    // This is the scope-filter invariant: without it, passing all 8
    // tools would make the web canonical match the http bucket first
    // (it's listed before the web bucket in CAPABILITY_BUCKETS).
    const reg = new AtomRegistry(openDb(':memory:'));
    const webL1 = ensureCanonicalL1(reg, KITCHEN_SINK, SMOKE);
    expect(webL1.description).toMatch(/single-file web artefact builder/);
    expect(webL1.description).not.toMatch(/Node HTTP server builder/);
    expect(webL1.tools.map((t) => t.name)).not.toContain('start_node_server');
    expect(webL1.tools.map((t) => t.name)).not.toContain('fetch_url');
  });

  it('matches capabilityDescription for its scoped tool signature', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalHttpL1(reg, KITCHEN_SINK);
    // The description is derived from the SCOPED toolset (not the
    // caller-supplied kitchen-sink), so replicating the same filter
    // reproduces the label.
    const scopedTools = KITCHEN_SINK.filter((t) =>
      ['write_file', 'read_file', 'list_files', 'run_shell', 'fetch_url', 'start_node_server'].includes(
        t.name
      )
    );
    expect(l1.description).toBe(capabilityDescription(scopedTools, 1));
  });
});
