import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SentinelWatch } from '../src/sentinel/watch.js';
import {
  MAX_TRACE_BYTES,
  operatorRunSource,
  projectRunSource,
} from '../src/sentinel/sources.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';

/**
 * The sentinel watch (P1b). What these hold:
 *   - detection is the live predicate, so a finished run is not re-screened;
 *   - BOTH run corpora are watched: the operator index and the tenant control
 *     plane, whose traces live one directory per run;
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

    expect(report.runs.map((run) => run.runId)).toEqual(['run-a']);
    expect(report.runs[0]!.corpus).toBe('operator');
    expect(report.emitted).toHaveLength(1);
    const row = journal.appended[0]!;
    expect(row.kind).toBe('run.anomaly');
    expect(row.actorType).toBe('system');
    expect(row.runId).toBe('run-a');
    expect(row.orgId ?? null).toBeNull();
    expect(row.projectId ?? null).toBeNull();
    expect(row.detail?.['corpus']).toBe('operator');
    expect(row.detail?.['dedupeKey']).toBeTruthy();
  });

  it('ignores a run the live predicate calls finished', () => {
    const journal = fakeJournal();
    const finished = { ...liveEntry('run-a'), inFlight: false, endedAt: new Date(NOW).toISOString() };
    const dir = runsFixture([finished], { 'run-a': stalledTrace('run-a') });
    const report = new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick();
    expect(report.runs).toEqual([]);
    expect(journal.appended).toEqual([]);
  });

  it('ignores a run that went silent past the abandoned threshold', () => {
    const journal = fakeJournal();
    const stale = { ...liveEntry('run-a'), lastEventAt: NOW - 60 * 60 * 1000 };
    const dir = runsFixture([stale], { 'run-a': stalledTrace('run-a') });
    expect(new SentinelWatch({ journal, runsDir: dir, now: () => NOW }).tick().runs).toEqual([]);
  });

  it('answers an absent runs directory with silence, not a throw', () => {
    const journal = fakeJournal();
    const report = new SentinelWatch({
      journal,
      runsDir: join(tmpdir(), 'atoma-sentinel-does-not-exist'),
      now: () => NOW,
    }).tick();
    expect(report).toEqual({ runs: [], emitted: [], skipped: [] });
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
    expect(report.runs.map((run) => run.runId)).toEqual(['run-a']);
    expect(report.skipped[0]!.reason).toMatch(/unreadable or over the size cap/);
  });

  it('has a size cap that is a real cap', () => {
    expect(MAX_TRACE_BYTES).toBeGreaterThan(1_000_000);
    expect(MAX_TRACE_BYTES).toBeLessThan(1_024 * 1_024 * 1_024);
  });
});

/**
 * THE SECOND CORPUS. A project run gets `ATOMA_RUNS_DIR` pointed at its own
 * directory, so a watch on the operator index sees every burn-in and not one
 * customer run. These hold the seam: the tenant control plane is the detector
 * on that side, the finding carries the org it belongs to, and one corpus
 * failing does not blind the other.
 */
function projectTraceFixture(runId: string, ageMs = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-sentinel-project-'));
  roots.push(root);
  const file = join(root, `${runId}.json`);
  writeFileSync(file, JSON.stringify(stalledTrace(runId)), 'utf8');
  if (ageMs > 0) {
    const seconds = (NOW - ageMs) / 1000;
    utimesSync(file, seconds, seconds);
  } else {
    const seconds = NOW / 1000;
    utimesSync(file, seconds, seconds);
  }
  return file;
}

function projectReader(
  rows: { projectRunId: string; orgId: string; projectId: string; projectSlug: string; file: string | null }[]
) {
  return { listLiveRunTraces: () => rows };
}

describe('the project corpus', () => {
  it('screens a run the control plane calls running, and names its org', () => {
    const journal = fakeJournal();
    const file = projectTraceFixture('proj-run-1');
    const watch = new SentinelWatch({
      journal,
      now: () => NOW,
      sources: [
        projectRunSource({
          reader: projectReader([
            {
              projectRunId: 'proj-run-1',
              orgId: 'org-7',
              projectId: 'project-3',
              projectSlug: 'weather-lab',
              file,
            },
          ]),
        }),
      ],
    });
    const report = watch.tick();

    expect(report.runs.map((run) => run.corpus)).toEqual(['project']);
    expect(report.emitted).toHaveLength(1);
    const row = journal.appended[0]!;
    expect(row.runId).toBe('proj-run-1');
    expect(row.orgId).toBe('org-7');
    expect(row.projectId).toBe('project-3');
    expect(row.actorType).toBe('system');
    expect(row.detail?.['corpus']).toBe('project');
  });

  it('waits for a trace the recorder has not written yet, and says so', () => {
    // `running` is set before the first persist: normal for a few seconds,
    // reported rather than silently dropped, gone by the next tick.
    const journal = fakeJournal();
    const report = new SentinelWatch({
      journal,
      now: () => NOW,
      sources: [
        projectRunSource({
          reader: projectReader([
            {
              projectRunId: 'proj-run-2',
              orgId: 'org-7',
              projectId: 'project-3',
              projectSlug: 'weather-lab',
              file: null,
            },
          ]),
        }),
      ],
    }).tick();

    expect(report.runs).toEqual([]);
    expect(report.skipped).toEqual([
      { runId: 'proj-run-2', reason: 'trace not persisted yet' },
    ]);
    expect(journal.appended).toEqual([]);
  });

  it('stops screening a row that outlived its process, and does not repair it', () => {
    // A SIGKILLed coordinator leaves `running` behind until boot reconciles
    // it. The sentinel bounds its own exposure and writes nothing to the
    // control plane: an observer that repairs state is no longer an observer.
    const journal = fakeJournal();
    const file = projectTraceFixture('proj-run-3', 30 * 60 * 1000);
    const report = new SentinelWatch({
      journal,
      now: () => NOW,
      sources: [
        projectRunSource({
          reader: projectReader([
            {
              projectRunId: 'proj-run-3',
              orgId: 'org-7',
              projectId: 'project-3',
              projectSlug: 'weather-lab',
              file,
            },
          ]),
        }),
      ],
    }).tick();

    expect(report.runs).toEqual([]);
    expect(report.skipped[0]!.reason).toMatch(/says running, trace silent for/);
    expect(journal.appended).toEqual([]);
  });

  it('keeps watching one corpus when the other cannot be read', () => {
    const journal = fakeJournal();
    const dir = runsFixture([liveEntry('run-a')], { 'run-a': stalledTrace('run-a') });
    const broken = {
      corpus: 'project' as const,
      discover: () => {
        throw new Error('store locked');
      },
    };
    const report = new SentinelWatch({
      journal,
      now: () => NOW,
      sources: [broken, operatorRunSource({ runsDir: dir })],
    }).tick();

    expect(report.runs.map((run) => run.runId)).toEqual(['run-a']);
    expect(report.emitted).toHaveLength(1);
    expect(report.skipped).toEqual([
      { runId: null, reason: 'project source failed: Error: store locked' },
    ]);
  });

  it('reports a torn operator index instead of watching nothing quietly', () => {
    const journal = fakeJournal();
    const root = mkdtempSync(join(tmpdir(), 'atoma-sentinel-torn-'));
    roots.push(root);
    writeFileSync(join(root, 'index.json'), '[{"id":"run-a", trunc', 'utf8');
    const report = new SentinelWatch({ journal, runsDir: root, now: () => NOW }).tick();

    expect(report.runs).toEqual([]);
    expect(report.skipped).toEqual([
      { runId: null, reason: 'runs index unreadable or over the size cap' },
    ]);
  });
});

describe('the trajectory reference', () => {
  const ACTOR = { name: 'Methane', tier: 1 };
  const RECIPE = ['write_file', 'write_file', 'start_node_server', 'fetch_url', 'fetch_url', 'fetch_url', 'read_file'];
  const DRIFTED = [
    ...Array<string>(4).fill('write_file'),
    'start_node_server',
    ...Array<string>(12).fill('fetch_url'),
    'read_file',
    'read_file',
  ];

  /** One execution of one Molecule under one skill, closed, and credited when `credited`. */
  function trace(id: string, tools: readonly string[], credited: boolean, endedAt?: string) {
    let ts = NOW - 50_000;
    const executionId = `${id}-exec`;
    return {
      id,
      label: 'a run',
      startedAt: new Date(NOW - 60_000).toISOString(),
      ...(endedAt ? { endedAt } : {}),
      events: [
        { id: `${id}-inject`, ts: (ts += 1), kind: 'skill', op: 'inject', l1Name: 'Methane', l1AtomId: 'a', skillId: 'node-api', actor: { name: 'Tracheid', tier: 2 } },
        ...tools.map((name, index) => ({
          id: `${id}-tool-${index}`,
          ts: (ts += 1),
          kind: 'tool',
          llmEventId: executionId,
          name,
          args: { url: 'http://localhost:1/' },
          durationMs: 10,
          actor: ACTOR,
        })),
        {
          id: executionId,
          ts: (ts += 1),
          kind: 'llm',
          role: 'execute',
          model: 'm',
          actor: ACTOR,
          systemPrompt: '',
          userContent: '',
          response: '',
          stopReason: 'end_turn',
          durationMs: 10,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          costUsd: 0.01,
        },
        ...(credited
          ? [{ id: `${id}-success`, ts: (ts += 1), kind: 'skill', op: 'success', l1Name: 'Methane', l1AtomId: 'a', skillId: 'node-api', actor: { name: 'Tracheid', tier: 2 } }]
          : []),
      ],
    };
  }
  const ENDED = new Date(NOW - 20_000).toISOString();
  const finishedEntry = (id: string) => ({ ...liveEntry(id), inFlight: false, endedAt: ENDED });
  const corpus = () =>
    runsFixture([liveEntry('live'), finishedEntry('f1'), finishedEntry('f2'), finishedEntry('f3')], {
      live: trace('live', DRIFTED, false),
      f1: trace('f1', RECIPE, true, ENDED),
      f2: trace('f2', RECIPE, true, ENDED),
      f3: trace('f3', RECIPE, true, ENDED),
    });
  const driftRows = (report: { emitted: { ruleId: string }[] }) =>
    report.emitted.filter((finding) => finding.ruleId === 'trajectory-drift');

  it('scores a live operator run against the finished runs beside it, reports what it used, and says it once', () => {
    const journal = fakeJournal();
    const dir = corpus();
    const watch = () => new SentinelWatch({ journal, runsDir: dir, now: () => NOW, trajectoryMinScore: 0.5 });
    const report = watch().tick();
    expect(report.references).toEqual([{ corpus: 'operator', runs: 3, signatures: 3, unreadable: 0, failed: null }]);
    expect(report.runs.map((run) => run.runId)).toEqual(['live']);
    expect(driftRows(report)).toHaveLength(1);
    const row = journal.appended.find((event) => event.detail?.['dedupeKey'] === 'trajectory-drift:live-exec')!;
    expect(row.kind).toBe('run.anomaly');
    expect(row.actorType).toBe('system');
    expect(row.detail?.['corpus']).toBe('operator');
    expect(row.detail?.['observed']).toBe('write_file×4 › start_node_server › fetch_url×12 › read_file×2');
    expect(row.detail?.['sampleSize']).toBe(3);
    // A restarted watcher reads the journal and repeats nothing.
    expect(driftRows(watch().tick())).toEqual([]);
  });

  it('loads no reference and scores nothing while the floor is disarmed', () => {
    const journal = fakeJournal();
    const report = new SentinelWatch({ journal, runsDir: corpus(), now: () => NOW }).tick();
    expect(report.references).toBeUndefined();
    expect(driftRows(report)).toEqual([]);
  });

  it('reports a reference source that throws, and keeps screening the run', () => {
    const journal = fakeJournal();
    const report = new SentinelWatch({
      journal,
      runsDir: corpus(),
      now: () => NOW,
      trajectoryMinScore: 0.5,
      trajectoryReferences: [
        {
          corpus: 'operator',
          load() {
            throw new Error('store locked');
          },
        },
      ],
    }).tick();
    expect(report.references).toEqual([
      { corpus: 'operator', runs: 0, signatures: 0, unreadable: 0, failed: 'Error: store locked' },
    ]);
    expect(report.runs.map((run) => run.runId)).toEqual(['live']);
    expect(driftRows(report)).toEqual([]);
    // The window-only rules still ran over the same run.
    expect(report.emitted.length).toBeGreaterThan(0);
  });
});
