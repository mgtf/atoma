import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SentinelWatch, MAX_TRACE_BYTES } from '../src/sentinel/watch.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';

/**
 * The sentinel watch (P1b). What these hold:
 *   - detection is the live predicate, so a finished run is not re-screened;
 *   - de-duplication is against the JOURNAL, so a restarted watcher repeats
 *     nothing and two watchers cannot double-report;
 *   - a run it cannot read is REPORTED as skipped, never silently dropped;
 *   - it writes `system`-attributed rows and nothing else.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A journal that records appends and answers list() from them. */
function fakeJournal() {
  const appended: PlatformEventInput[] = [];
  return {
    appended,
    append(input: PlatformEventInput) {
      appended.push(input);
      return input;
    },
    list(query: { kind?: string; runId?: string }) {
      return {
        events: appended
          .filter((e) => (query.kind ? e.kind === query.kind : true))
          .filter((e) => (query.runId ? e.runId === query.runId : true))
          .map((e) => ({ detail: e.detail })),
      };
    },
  };
}

function runsFixture(
  entries: unknown[],
  traces: Record<string, unknown>
): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-sentinel-'));
  roots.push(root);
  writeFileSync(join(root, 'index.json'), JSON.stringify(entries), 'utf8');
  for (const [id, trace] of Object.entries(traces)) {
    writeFileSync(join(root, `${id}.json`), JSON.stringify(trace), 'utf8');
  }
  return root;
}

const NOW = 1_700_000_000_000;

function liveEntry(id: string) {
  return {
    id,
    label: 'a run',
    startedAt: new Date(NOW - 60_000).toISOString(),
    hasError: false,
    inFlight: true,
    lastEventAt: NOW - 5_000,
  };
}

/** A trace with one stalled identical-call streak. */
function stalledTrace(id: string) {
  return {
    id,
    label: 'a run',
    startedAt: new Date(NOW - 60_000).toISOString(),
    events: Array.from({ length: 5 }, (_unused, index) => ({
      id: `ev-${index}`,
      ts: NOW - 50_000 + index,
      kind: 'tool',
      llmEventId: 'llm-1',
      name: 'validate_html',
      args: { url: 'http://localhost:1/' },
      durationMs: 10,
    })),
  };
}

describe('detection', () => {
  it('screens a live run and journals a system-attributed row', () => {
    const journal = fakeJournal();
    const dir = runsFixture([liveEntry('run-a')], { 'run-a': stalledTrace('run-a') });
    const report = new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick();

    expect(report.liveRuns).toEqual(['run-a']);
    expect(report.emitted).toHaveLength(1);
    const row = journal.appended[0]!;
    expect(row.kind).toBe('run.anomaly');
    expect(row.actorType).toBe('system');
    expect(row.runId).toBe('run-a');
    expect(row.detail?.['dedupeKey']).toBeTruthy();
  });

  it('ignores a run the live predicate calls finished', () => {
    const journal = fakeJournal();
    const finished = { ...liveEntry('run-a'), inFlight: false, endedAt: new Date(NOW).toISOString() };
    const dir = runsFixture([finished], { 'run-a': stalledTrace('run-a') });
    const report = new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick();
    expect(report.liveRuns).toEqual([]);
    expect(journal.appended).toEqual([]);
  });

  it('ignores a run that went silent past the abandoned threshold', () => {
    const journal = fakeJournal();
    const stale = { ...liveEntry('run-a'), lastEventAt: NOW - 60 * 60 * 1000 };
    const dir = runsFixture([stale], { 'run-a': stalledTrace('run-a') });
    expect(new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick().liveRuns).toEqual([]);
  });

  it('answers an absent runs directory with silence, not a throw', () => {
    const journal = fakeJournal();
    const report = new SentinelWatch({
      journal,
      runsDir: join(tmpdir(), 'atoma-sentinel-does-not-exist'),
      now: () => NOW,
    }).tick();
    expect(report).toEqual({ liveRuns: [], emitted: [], skipped: [] });
  });
});

describe('de-duplication against the journal', () => {
  it('says the same thing once across ticks', () => {
    const journal = fakeJournal();
    const dir = runsFixture([liveEntry('run-a')], { 'run-a': stalledTrace('run-a') });
    const watch = new SentinelWatch({ journal, runsDir: dir, now: () => NOW });
    expect(watch.tick().emitted).toHaveLength(1);
    expect(watch.tick().emitted).toHaveLength(0);
    expect(watch.tick().emitted).toHaveLength(0);
    expect(journal.appended).toHaveLength(1);
  });

  it('says nothing a RESTARTED watcher would repeat', () => {
    // The reason de-duplication reads the journal instead of process memory.
    const journal = fakeJournal();
    const dir = runsFixture([liveEntry('run-a')], { 'run-a': stalledTrace('run-a') });
    new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick();
    const fresh = new SentinelWatch({ journal, runsDir: dir, now: () => NOW });
    expect(fresh.tick().emitted).toHaveLength(0);
    expect(journal.appended).toHaveLength(1);
  });

  it('treats a journal it cannot read as "already said", and reports the skip', () => {
    // A flood is worse than a gap: a journal read that fails must not make
    // every tick re-report the whole run.
    const journal = {
      append: () => undefined,
      list: () => {
        throw new Error('store locked');
      },
    };
    const dir = runsFixture([liveEntry('run-a')], { 'run-a': stalledTrace('run-a') });
    const report = new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick();
    expect(report.emitted).toEqual([]);
    expect(report.skipped).toEqual([
      { runId: 'run-a', reason: 'journal unavailable for read-back' },
    ]);
  });
});

describe('bounded reading', () => {
  it('reports an unreadable trace as skipped instead of dropping it', () => {
    const journal = fakeJournal();
    const dir = runsFixture([liveEntry('run-a')], {});
    const report = new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick();
    expect(report.liveRuns).toEqual(['run-a']);
    expect(report.skipped[0]!.reason).toMatch(/unreadable or over the size cap/);
  });

  it('has a size cap that is a real cap', () => {
    expect(MAX_TRACE_BYTES).toBeGreaterThan(1_000_000);
    expect(MAX_TRACE_BYTES).toBeLessThan(1_024 * 1_024 * 1_024);
  });
});
