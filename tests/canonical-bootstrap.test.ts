import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import {
  CANONICAL_BOOTSTRAP_MARKER,
  CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES,
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
    execute: async () => ({ ok: true as const, output: 'noop' }),
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

  it('WEB L1 system prompt carries the ground-truth evidence contract (pomodoro triple-rejection regression)', () => {
    // Three consecutive live attempts at a web deliverable died with the
    // SAME validator complaint — "narrative claims are not evidence" — and
    // the root cause was here: the http and file-scribe canonicals carry
    // explicit evidence contracts, the web canonical carried NONE. Hydrogen
    // was never told HOW to prove its work.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalL1(reg, WEB_TOOLS, SMOKE);
    expect(l1.systemPrompt).toMatch(/== GROUND TRUTH ==/);
    expect(l1.systemPrompt).toMatch(/RESULT-REPORTING CONTRACT/);
    expect(l1.systemPrompt).toMatch(/validate_html outcome VERBATIM/);
    expect(l1.systemPrompt).toMatch(/"probes"/);
    expect(l1.systemPrompt).toMatch(/NARRATIVE claim .* WILL be rejected/s);
    // Web probes need the FILE + interactions + smoke recorded, never the
    // ephemeral served URL — that is what makes a validation replayable.
    expect(l1.systemPrompt).toMatch(/PROBE MANIFEST ON DISK/);
    expect(l1.systemPrompt).toMatch(/"probe": "web"/);
    expect(l1.systemPrompt).toMatch(/served\s+URL is EPHEMERAL/);
    expect(l1.systemPrompt).toMatch(/INTERACTIONS MUST BE SELECTOR-BASED/);
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

  it('HTTP L1 system prompt instructs the child to embed a == GROUND TRUTH == block in its summary', () => {
    // Regression for the LoL-SSR run: the HTTP L1 was producing
    // self-reported summaries ("server started, all endpoints work") that
    // the validator kept rejecting on a rotating no-evidence theme. The
    // result-reporting contract now requires a verbatim block listing
    // LISTENING_ON_PORT, bound URL, per-endpoint probes with status +
    // body[0:200], and a schema/state line. Drift this prompt and the
    // validator-side EXCEPTION clause that whitelists the embedded block
    // becomes meaningless.
    const prompt = CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES.join('\n');
    expect(prompt).toMatch(/== GROUND TRUTH ==/);
    expect(prompt).toMatch(/LISTENING_ON_PORT=/);
    expect(prompt).toMatch(/probe: /);
    expect(prompt).toMatch(/body\[0:200\]/);
    expect(prompt).toMatch(/schema\/state:/);
    // HTTP probes are fetch_url-shaped, not shell-shaped — the on-disk
    // manifest needs its own entry kind or compiled HTTP verifiers are
    // forced back to prose parsing. Observed live (http-ping closer 3):
    // the compiled verify script found no manifest, tried to parse the
    // README's probe lines, and exited 1 on format variance — the exact
    // failure class the manifest exists to close.
    expect(prompt).toMatch(/PROBE MANIFEST ON DISK/);
    expect(prompt).toMatch(/"probe": "http"/);
    expect(prompt).toContain('.atoma-probes.json');
    // Phase-2 of the LoL-SSR run: Helium stuffed the block into the
    // "output" field as prose, validator rejected on placement. The
    // prompt must explicitly forbid that and show the canonical shape.
    expect(prompt).toMatch(/NEVER stuff prose[\s\S]+?GROUND-TRUTH block into "output"/);
    expect(prompt).toMatch(/"summary"\s*:\s*"Built Node SSR app/);
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
