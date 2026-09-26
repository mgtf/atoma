import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { inheritProbeManifest, validateProbeManifest } from '../src/contracts/probeManifest.js';
import { describeSeedManifest, seedWorkspace } from '../src/run/workspace.js';
import { localToolBackend } from '../src/run/toolBackend.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { makeCtx, jsonText, silentLogger } from './helpers.js';
import type { Result, Tool } from '../src/core/types.js';

/**
 * What a seeded run inherits — docs/seed-inheritance-2026-09-25.md.
 *
 * The manifest below is the SHAPE of the one run `d677d824` inherited on
 * 2026-09-24: real machine-recorded HTTP entries, followed by prose entries a
 * run wrote by hand on 2026-08-23 (`"exitCode": null`, `"result": "PASS"`).
 * Root acceptance refused once over the prose entries, four runs after they
 * were written.
 */
const INHERITED = {
  version: 1,
  entries: [
    { probe: 'http', method: 'GET', path: '/api/expenses', status: 200, body: '[]', entry: 'server.js' },
    { probe: 'http', method: 'PUT', path: '/api/expenses/1', status: 428, entry: 'server.js' },
    { cmd: 'node server.js --check', exitCode: 0, stdout: 'ok\n' },
    { cmd: 'curl -s http://localhost:3000/api/expenses', exitCode: null, note: 'Would verify the list' },
    { cmd: 'Code Review - app.js', result: 'PASS' },
    { probe: 'http', method: 'POST', path: '/api/expenses', note: 'Would create one' },
    'verified by hand',
    { scenario: 'offline', result: 'PASS' },
  ],
};

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('inheritProbeManifest', () => {
  it('keeps every well-formed entry, in order, and drops each unreplayable one on its own', () => {
    const out = inheritProbeManifest(JSON.stringify(INHERITED));
    expect(out).toMatchObject({ kept: 3, dropped: 5, unreadable: false });
    const doc = JSON.parse(out.text!) as { version: number; entries: unknown[] };
    expect(doc.version).toBe(1);
    // HTTP entries are judged one by one: the malformed POST goes, the two
    // recorded requests before it stay, with their machine `entry` stamp.
    expect(doc.entries).toEqual([INHERITED.entries[0], INHERITED.entries[1], INHERITED.entries[2]]);
    // The result is exactly what the health check calls well-formed.
    expect(validateProbeManifest(out.text!)).toEqual([]);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.problems.length).toBeLessThanOrEqual(4);
  });

  it('returns the input BYTES untouched when nothing is dropped', () => {
    const raw = `{"version":1,"entries":[{"cmd":"node a.js","exitCode":0}],"note":"kept"}`;
    expect(inheritProbeManifest(raw)).toMatchObject({ text: raw, kept: 1, dropped: 0 });
  });

  it('leaves no manifest when nothing replayable is left, or the document is not a version-1 manifest', () => {
    expect(inheritProbeManifest(JSON.stringify({ version: 1, entries: [{ cmd: 'x', exitCode: null }] })))
      .toMatchObject({ text: null, kept: 0, dropped: 1, unreadable: false });
    expect(inheritProbeManifest(JSON.stringify({ version: 1, entries: [] })))
      .toMatchObject({ text: null, dropped: 0, unreadable: false });
    for (const raw of ['{"version":1,"entries":[', '[]', '{"version":2,"entries":[]}', '{"version":1}']) {
      expect(inheritProbeManifest(raw)).toMatchObject({ text: null, unreadable: true });
    }
  });

  it('is idempotent: a filtered manifest seeds unchanged the next time', () => {
    const once = inheritProbeManifest(JSON.stringify(INHERITED)).text!;
    expect(inheritProbeManifest(once)).toMatchObject({ text: once, dropped: 0 });
  });

  it('keeps a harness entry that recorded its bound port, without the run-varying stdout (review 2.9)', () => {
    // The HTTP writer contract makes this entry MANDATORY, and the reader
    // compares it on its exit code alone: it is replayable, and it is the
    // anchor a compiled verifier replays against.
    const harness = { cmd: 'node test-api.js', exitCode: 0, stdout: 'LISTENING_ON_PORT=41234\nall green\n' };
    const out = inheritProbeManifest(JSON.stringify({ version: 1, entries: [INHERITED.entries[0], harness] }));
    expect(out).toMatchObject({ kept: 2, dropped: 0, repaired: 1 });
    const doc = JSON.parse(out.text!) as { entries: unknown[] };
    expect(doc.entries[1]).toEqual({ cmd: 'node test-api.js', exitCode: 0 });
    expect(validateProbeManifest(out.text!)).toEqual([]);
    // And the repaired document is stable.
    expect(inheritProbeManifest(out.text!)).toMatchObject({ text: out.text, repaired: 0, dropped: 0 });
  });
});

describe('seedWorkspace', () => {
  it('filters the copy and never touches the seed source', () => {
    const seed = tempDir('atoma-seed-src-');
    const raw = JSON.stringify(INHERITED, null, 2);
    writeFileSync(join(seed, '.atoma-probes.json'), raw);
    writeFileSync(join(seed, 'server.js'), 'module.exports = {};');
    const workspace = join(tempDir('atoma-seed-dst-'), 'workspace');
    const report = seedWorkspace(seed, workspace);
    expect(report).toMatchObject({ entries: 2, manifest: 'filtered', kept: 3, dropped: 5 });
    expect(describeSeedManifest(report)).toMatch(/^seed \.atoma-probes\.json: kept 3 entries, dropped 5 unreplayable — /);
    expect(readFileSync(join(seed, '.atoma-probes.json'), 'utf8')).toBe(raw);
    expect(validateProbeManifest(readFileSync(join(workspace, '.atoma-probes.json'), 'utf8'))).toEqual([]);
    expect(existsSync(join(workspace, 'server.js'))).toBe(true);
  });

  it('passes the maintenance benchmark seeds through byte for byte', () => {
    for (const name of ['tabstat', 'wclite']) {
      const seed = join(process.cwd(), 'benchmark', 'seeds', name);
      const workspace = join(tempDir(`atoma-seed-${name}-`), 'workspace');
      const report = seedWorkspace(seed, workspace);
      expect(report.manifest).toBe('kept');
      expect(describeSeedManifest(report)).toBeNull();
      expect(readFileSync(join(workspace, '.atoma-probes.json'), 'utf8'))
        .toBe(readFileSync(join(seed, '.atoma-probes.json'), 'utf8'));
    }
  });

  it('removes a manifest with nothing replayable, and reports a seed without one as absent', () => {
    const seed = tempDir('atoma-seed-src-');
    writeFileSync(join(seed, '.atoma-probes.json'), '{"version":1,"entries":[{"cmd":"x","exitCode":null}]}');
    const workspace = join(tempDir('atoma-seed-dst-'), 'workspace');
    const report = seedWorkspace(seed, workspace);
    expect(report).toMatchObject({ manifest: 'removed', dropped: 1 });
    expect(describeSeedManifest(report)).toMatch(/not inherited, nothing replayable \(1 entries dropped\)/);
    expect(existsSync(join(workspace, '.atoma-probes.json'))).toBe(false);

    const bare = tempDir('atoma-seed-bare-');
    writeFileSync(join(bare, 'index.html'), '<p>hi</p>');
    expect(seedWorkspace(bare, join(tempDir('atoma-seed-dst-'), 'workspace')).manifest).toBe('absent');
  });

  it.skipIf(process.platform === 'win32')('never follows a symlinked manifest', () => {
    const outside = tempDir('atoma-seed-outside-');
    const target = join(outside, 'target.json');
    writeFileSync(target, JSON.stringify(INHERITED));
    const seed = tempDir('atoma-seed-src-');
    symlinkSync(target, join(seed, '.atoma-probes.json'));
    const workspace = join(tempDir('atoma-seed-dst-'), 'workspace');
    expect(seedWorkspace(seed, workspace)).toMatchObject({ manifest: 'removed' });
    expect(() => lstatSync(join(workspace, '.atoma-probes.json'))).toThrow();
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(INHERITED));
    expect(readlinkSync(join(seed, '.atoma-probes.json'))).toBe(target);
  });
});

/**
 * The production path that failed: a trusted molecule's RESULT validated over
 * the REAL local tool backend, in a workspace that inherited the manifest.
 * An HTTP-tooled child always has its manifest health-checked, so an
 * inherited malformation used to reach the validator as MALFORMED and force a
 * paid review of work that had nothing wrong with it.
 */
describe('a seeded workspace at result validation', () => {
  const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
  const base = { description: 'seed', systemPrompt: 'sys', tools: [], params: {}, createdBy: 'test' };

  async function validate(copy: (seed: string, workspace: string) => void) {
    const seed = tempDir('atoma-seed-src-');
    writeFileSync(join(seed, '.atoma-probes.json'), JSON.stringify(INHERITED, null, 2));
    writeFileSync(join(seed, 'server.js'), 'module.exports = { ready: true };\n');
    const workspace = join(tempDir('atoma-seed-dst-'), 'workspace');
    copy(seed, workspace);
    const backend = localToolBackend({ workspaceRoot: workspace, logger: silentLogger() });
    try {
      const reg = new AtomRegistry(openDb(':memory:'));
      reg.create(2, base);
      const l1Type = reg.create(1, {
        ...base,
        tools: ['write_file', 'read_file', 'list_files', 'fetch_url'].map(tool),
      });
      for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
      const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
      const l1 = L1Atom.fromType(reg.getByName(l1Type.name)!);
      const ctx = { ...makeCtx(), tools: backend.executor };
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'reviewed' }));
      const result: Result = {
        output: { files: ['server.js'] },
        summary: 'wrote server.js',
        trace: [],
        producedBy: { tier: 1, name: l1Type.name, viaFallback: false },
      };
      const verdict = await l2.validateResult(l1, result, { description: 'write server.js' }, ctx);
      return { verdict, calls: ctx.llm.calls };
    } finally {
      await backend.cleanup();
    }
  }

  it('an unfiltered copy reaches the validator as MALFORMED — the defect, reproduced', async () => {
    const { calls } = await validate((seed, workspace) => {
      mkdirSync(workspace, { recursive: true });
      cpSync(seed, workspace, { recursive: true });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userContent).toMatch(/\.atoma-probes\.json: MALFORMED/);
  });

  it('the seed copy keeps the trusted fast path: well-formed baseline, zero LLM calls', async () => {
    const { verdict, calls } = await validate((seed, workspace) => { seedWorkspace(seed, workspace); });
    expect(verdict.approved).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
