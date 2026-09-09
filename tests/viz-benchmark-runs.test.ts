import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BenchmarkRuns } from '../src/viz/benchmarkRuns.js';
import { seedBenchmark } from './helpers/retrievalBenchmark.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-benchmark-view-'));
  roots.push(root);
  return { root, reader: new BenchmarkRuns(root), ...seedBenchmark(root) };
}

it('projects a live attempt and its completion without copying or modifying the trace', () => {
  const f = setup();
  expect(f.reader.list(false)).toEqual([]);
  expect(f.reader.resolve(f.start.runId, false)).toBeNull();
  expect(f.reader.list(true)[0]).toMatchObject({ id: f.start.runId, inFlight: true });
  expect(f.reader.list(true)[0]!.label).toContain('Benchmark atoma · northstar-05');
  expect(f.reader.resolve(f.start.runId, true)).toBe(f.file);
  writeFileSync(f.file, JSON.stringify({ ...f.trace, endedAt: new Date().toISOString(), error: 'timeout' }));
  expect(f.reader.list(true)[0]).toMatchObject({ hasError: true });
  expect(new BenchmarkRuns(f.root).resolve(f.start.runId, true)).toBe(f.file);
});

it('refuses external paths, symlink ancestors, and an unregistered attempt', () => {
  const f = setup();
  writeFileSync(f.receipt, JSON.stringify({ ...f.start, executionEnv: { ATOMA_RUNS_DIR: tmpdir() } }));
  expect(f.reader.resolve(f.start.runId, true)).toBeNull();
  writeFileSync(f.receipt, JSON.stringify(f.start));
  rmSync(f.traces, { recursive: true });
  symlinkSync(tmpdir(), f.traces);
  expect(f.reader.resolve(f.start.runId, true)).toBeNull();
  writeFileSync(f.receipt, JSON.stringify({ ...f.start, entry: { ...f.start.entry, ordinal: 199 } }));
  expect(f.reader.list(true)).toEqual([]);
});
