import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import {
  CANONICAL_BOOTSTRAP_MARKER,
  CANONICAL_FILESCRIBE_BOOTSTRAP_MARKER,
  CANONICAL_HTTP_BOOTSTRAP_MARKER,
  capabilityDescription,
  ensureCanonicalFileScribeL1,
  ensureCanonicalHttpL1,
  ensureCanonicalL1,
  PROBE_MANIFEST_FILENAME,
} from '../src/atoms/capability.js';
import { makeTools } from './helpers/factories.js';

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

describe('ensureCanonicalFileScribeL1 — bootstrap (#12)', () => {
  it('creates a file-scribe L1 with the file-scribe bucket label and dedicated marker', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    expect(l1.tier).toBe(1);
    expect(l1.createdBy).toBe(CANONICAL_FILESCRIBE_BOOTSTRAP_MARKER);
    expect(l1.description).toMatch(/file scribe/);
    expect(l1.description).not.toMatch(/web artefact builder/);
    expect(l1.description).not.toMatch(/Node HTTP server builder/);
    expect(l1.systemPrompt).toMatch(/static-file authoring/);
    // Tool set is narrow — no HTTP-specific or web-specific tools.
    const names = l1.tools.map((t) => t.name).sort();
    expect(names).toEqual(['list_files', 'read_file', 'run_shell', 'write_file']);
  });

  it('coexists with web + http canonicals — three distinct L1 markers', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webL1 = ensureCanonicalL1(reg, KITCHEN_SINK, SMOKE);
    const httpL1 = ensureCanonicalHttpL1(reg, KITCHEN_SINK);
    const fsL1 = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);

    // Distinct markers.
    expect(webL1.createdBy).toBe(CANONICAL_BOOTSTRAP_MARKER);
    expect(httpL1.createdBy).toBe(CANONICAL_HTTP_BOOTSTRAP_MARKER);
    expect(fsL1.createdBy).toBe(CANONICAL_FILESCRIBE_BOOTSTRAP_MARKER);

    // Distinct names (taxonomy assigns successive elements).
    expect(new Set([webL1.name, httpL1.name, fsL1.name]).size).toBe(3);

    // Distinct descriptions (bucket labels are discriminative for prefilter).
    expect(webL1.description).toMatch(/single-file web artefact builder/);
    expect(httpL1.description).toMatch(/Node HTTP server builder/);
    expect(fsL1.description).toMatch(/file scribe/);

    // Registry has exactly three L1s (web + http + file-scribe).
    expect(reg.listByTier(1)).toHaveLength(3);
  });

  it('is idempotent — repeated bootstraps patch the existing entry, do not clone', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const first = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    const second = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    expect(second.name).toBe(first.name);
    expect(reg.listByTier(1)).toHaveLength(1);
  });

  it('matches capabilityDescription for its scoped tool signature', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    const scopedTools = KITCHEN_SINK.filter((t) =>
      ['write_file', 'read_file', 'list_files', 'run_shell'].includes(t.name)
    );
    expect(l1.description).toBe(capabilityDescription(scopedTools, 1));
  });

  it('refreshes tool list when the executor set grows between runs', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const minimal = makeTools(['write_file']);
    ensureCanonicalFileScribeL1(reg, minimal);
    const expanded = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    // The entry is the same atom (same taxonomy name) and now advertises
    // the full file-scribe scope (add_tools patches in read_file,
    // list_files, run_shell).
    const names = expanded.tools.map((t) => t.name).sort();
    expect(names).toEqual(['list_files', 'read_file', 'run_shell', 'write_file']);
    expect(reg.listByTier(1)).toHaveLength(1);
  });

  it('system prompt forbids server startup / HTTP probing / HTML rendering (scope boundary)', () => {
    // Regression guard: the whole point of this canonical is that an
    // L2 (HTTP or web) that routes a file-authoring subtask here gets
    // a narrow worker that will NOT silently grow into "HTTP server
    // too, since I have run_shell". The system prompt explicitly
    // forbids those side-effects.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    expect(l1.systemPrompt).toMatch(/do NOT start servers/);
    expect(l1.systemPrompt).toMatch(/do NOT probe HTTP endpoints/);
    expect(l1.systemPrompt).toMatch(/do NOT render HTML/);
  });

  it('system prompt carries the GROUND-TRUTH evidence contract (wc-cli rejection-loop regression)', () => {
    // The doc-phase L1s did correct work but returned narrative-only
    // summaries; the validator rightly rejected them as unverifiable
    // and the run looped through two escalation branches. Non-web/http
    // L1s must be TAUGHT to paste tool outputs into the summary.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1 = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    expect(l1.systemPrompt).toMatch(/== GROUND TRUTH ==/);
    expect(l1.systemPrompt).toMatch(/RESULT-REPORTING CONTRACT/);
    expect(l1.systemPrompt).toMatch(/VERBATIM excerpts/);
    // The on-disk probe manifest — the machine-readable interface that
    // later verification passes re-run and diff against. Two compile
    // generations of prose-parsing verification failed 6/6 real
    // workspaces; this contract is what makes verify scripts compilable.
    expect(l1.systemPrompt).toMatch(/PROBE MANIFEST ON DISK/);
    expect(l1.systemPrompt).toContain(PROBE_MANIFEST_FILENAME);
  });

  it('re-aligns a STALE persisted system prompt on the next bootstrap (idempotent seeder)', () => {
    // The ensure* helpers used to refresh only the tool list — a prompt
    // fix in the seed constants never reached a registry row written by
    // an earlier version. The refresh must be conditional: unchanged
    // prompt → no version bump (the patch no-op guard preserves trust
    // counters); changed prompt → re-aligned, counters legitimately
    // reset (a changed type re-earns trust).
    const reg = new AtomRegistry(openDb(':memory:'));
    const created = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    reg.recordSuccess(created.name);
    // Idempotent re-run: same prompt → no version bump, counters kept.
    const same = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    expect(same.version).toBe(created.version);
    expect(reg.getByName(created.name)!.successes).toBe(1);
    // Simulate a row persisted by an OLDER seed (different prompt).
    reg.patch(created.name, { systemPromptReplace: 'stale legacy prompt' }, 'test');
    const healed = ensureCanonicalFileScribeL1(reg, KITCHEN_SINK);
    expect(healed.systemPrompt).toMatch(/== GROUND TRUTH ==/);
    expect(healed.systemPrompt).not.toMatch(/stale legacy prompt/);
  });
});
