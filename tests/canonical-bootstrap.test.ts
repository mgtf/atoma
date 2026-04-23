import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import {
  CANONICAL_BOOTSTRAP_MARKER,
  CANONICAL_L2_WEB_DESCRIPTION,
  capabilityDescription,
  ensureCanonicalL1,
  ensureCanonicalL2,
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

const WEB_TOOLS = makeTools([
  'write_file',
  'read_file',
  'list_files',
  'start_static_server',
  'validate_html',
]);

const SMOKE = '== SMOKE-TEST DESIGN ==\ntest block';

describe('ensureCanonicalL1 / ensureCanonicalL2 — idempotent bootstrap', () => {
  it('creates canonical L1 on first call with capability-derived description + bootstrap marker', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalL1(reg, WEB_TOOLS, SMOKE);
    expect(l1.tier).toBe(1);
    expect(l1.description).toBe(capabilityDescription(WEB_TOOLS, 1));
    expect(l1.createdBy).toBe(CANONICAL_BOOTSTRAP_MARKER);
    expect(l1.systemPrompt).toContain('ONE narrow responsibility');
    expect(l1.systemPrompt).toContain('SMOKE-TEST DESIGN');
    expect(reg.listByTier(1)).toHaveLength(1);
  });

  it('creates canonical L2 on first call with canonical description + bootstrap marker', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2 = ensureCanonicalL2(reg, WEB_TOOLS);
    expect(l2.tier).toBe(2);
    expect(l2.description).toBe(CANONICAL_L2_WEB_DESCRIPTION);
    expect(l2.createdBy).toBe(CANONICAL_BOOTSTRAP_MARKER);
    expect(l2.systemPrompt).toContain('domain-neutral L2 orchestrator');
    expect(reg.listByTier(2)).toHaveLength(1);
  });

  it('is idempotent — repeated calls reuse the canonical entry instead of cloning it', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const first1 = ensureCanonicalL1(reg, WEB_TOOLS, SMOKE);
    const second1 = ensureCanonicalL1(reg, WEB_TOOLS, SMOKE);
    expect(second1.name).toBe(first1.name);
    expect(reg.listByTier(1)).toHaveLength(1);
    const first2 = ensureCanonicalL2(reg, WEB_TOOLS);
    const second2 = ensureCanonicalL2(reg, WEB_TOOLS);
    expect(second2.name).toBe(first2.name);
    expect(reg.listByTier(2)).toHaveLength(1);
  });

  it('coexists with legacy task-themed entries without touching them', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    // Simulate a legacy pre-capability registry: a task-themed L1 from
    // an old run still lives in the catalog.
    const legacy = reg.create(1, {
      description: 'L1 for subtask: Build a chess puzzle with 8x8 grid',
      systemPrompt: 'legacy',
      tools: WEB_TOOLS,
      params: {},
      createdBy: 'Water',
    });
    const canonical = ensureCanonicalL1(reg, WEB_TOOLS, SMOKE);
    // Both present. Canonical is the new one; legacy is untouched.
    const all = reg.listByTier(1);
    expect(all).toHaveLength(2);
    const stillLegacy = reg.getByName(legacy.name)!;
    expect(stillLegacy.description).toBe(legacy.description);
    expect(stillLegacy.createdBy).toBe('Water');
    expect(canonical.createdBy).toBe(CANONICAL_BOOTSTRAP_MARKER);
    expect(canonical.description).toBe(capabilityDescription(WEB_TOOLS, 1));
  });

  it('refreshes the canonical tool list when the executor set grows between runs', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    ensureCanonicalL1(reg, makeTools(['write_file', 'start_static_server']), SMOKE);
    const expanded = ensureCanonicalL1(reg, WEB_TOOLS, SMOKE);
    // The entry is the same atom (same taxonomy name) but now advertises
    // the richer toolset — prefilter will see validate_html as available.
    expect(expanded.tools.map((t) => t.name).sort()).toEqual(
      WEB_TOOLS.map((t) => t.name).sort()
    );
    expect(reg.listByTier(1)).toHaveLength(1);
  });
});
