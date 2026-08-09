import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceRecorder } from '../src/viz/trace.js';
import type { VizRunIndexEntry } from '../src/viz/trace.js';

/**
 * An in-flight index entry must carry WHEN it was last alive.
 *
 * `inFlight` alone cannot separate "running right now" from "died without
 * its closing stamp": a hard kill (uncatchable SIGKILL, a crash) leaves the
 * trace with no `endedAt` forever. Measured on the run of 2026-08-08T18:32
 * — wedged on a Sonnet call, killed by the burn-in harness of the day,
 * which went straight to group SIGKILL — it sat in the sidebar flagged
 * "● LIVE" eleven hours later, and kept the UI's `anyInflight` true so the
 * index re-polled endlessly. The run detail view could tell (it holds the
 * events and applies a 12-minute silence rule); the LIST could not, because
 * index entries carry no events.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newRecorder(): { rec: TraceRecorder; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-trace-abandoned-'));
  dirs.push(dir);
  return { rec: new TraceRecorder(dir), dir };
}

function readIndex(dir: string): VizRunIndexEntry[] {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as VizRunIndexEntry[];
}

describe('index entries carry lastEventAt while in flight', () => {
  it('stamps the newest event time on an in-flight entry', () => {
    const { rec, dir } = newRecorder();
    rec.beginRun({ description: 'wedged' } as never, 'build-app: wedged', {
      initialTypes: [],
    } as never);
    rec.record({ id: 'a', ts: 1_000, kind: 'llm-start', model: 'm' } as never);
    rec.record({ id: 'b', ts: 5_000, kind: 'llm-start', model: 'm' } as never);
    // Out-of-order arrival must not win — we want the NEWEST, not the last.
    rec.record({ id: 'c', ts: 2_000, kind: 'llm-start', model: 'm' } as never);
    rec.flushPartial();

    const entry = readIndex(dir)[0]!;
    expect(entry.inFlight).toBe(true);
    expect(entry.lastEventAt).toBe(5_000);
  });

  it('omits it once the run is closed — a finished run is judged by endedAt', () => {
    const { rec, dir } = newRecorder();
    rec.beginRun({ description: 'clean' } as never, 'build-app: clean', {
      initialTypes: [],
    } as never);
    rec.record({ id: 'a', ts: 1_000, kind: 'llm-start', model: 'm' } as never);
    rec.endRun({ result: { summary: 'done', output: 'x', producedBy: {} as never } });

    const entry = readIndex(dir)[0]!;
    expect(entry.inFlight).toBeUndefined();
    expect(entry.lastEventAt).toBeUndefined();
    expect(entry.endedAt).toBeTruthy();
  });

  it('an event-less in-flight run leaves it absent, so consumers fall back to startedAt', () => {
    const { rec, dir } = newRecorder();
    rec.beginRun({ description: 'empty' } as never, 'build-app: empty', {
      initialTypes: [],
    } as never);
    rec.flushPartial();

    const entry = readIndex(dir)[0]!;
    expect(entry.inFlight).toBe(true);
    expect(entry.lastEventAt).toBeUndefined();
    expect(Date.parse(entry.startedAt)).toBeGreaterThan(0);
  });
});
