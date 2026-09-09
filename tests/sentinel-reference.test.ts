import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  operatorTrajectoryReferenceSource,
  projectTrajectoryReferenceSource,
} from '../src/sentinel/reference.js';
import { referenceSamples } from '../src/contracts/trajectory.js';
import type { VizRun, VizRunIndexEntry } from '../src/viz/trace.js';

/**
 * The trajectory reference sources. What these hold: only FINISHED runs enter
 * (a live or unstamped run is not a path), the window is bounded and keeps the
 * newest, an unreadable trace is counted rather than dropped silently, the two
 * corpora are read by two sources that never mix, and an unchanged trace is
 * not parsed twice.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

/** A finished run whose one Molecule execution was credited: a path worth predicting. */
function creditedTrace(id: string, actor: string, skillId: string, tools: readonly string[]): VizRun {
  let ts = NOW - 100_000;
  const events = [
    { id: `${id}-inject`, ts: (ts += 1), kind: 'skill', op: 'inject', l1Name: actor, l1AtomId: 'a1', skillId, actor: { name: 'Tracheid', tier: 2 } },
    ...tools.map((name, index) => ({
      id: `${id}-tool-${index}`,
      ts: (ts += 1),
      kind: 'tool',
      llmEventId: `${id}-exec`,
      name,
      args: {},
      durationMs: 5,
      actor: { name: actor, tier: 1 },
    })),
    {
      id: `${id}-exec`,
      ts: (ts += 1),
      kind: 'llm',
      role: 'execute',
      model: 'm',
      actor: { name: actor, tier: 1 },
      systemPrompt: '',
      userContent: '',
      response: '',
      stopReason: 'end_turn',
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0.01,
    },
    { id: `${id}-success`, ts: (ts += 1), kind: 'skill', op: 'success', l1Name: actor, l1AtomId: 'a1', skillId, actor: { name: 'Tracheid', tier: 2 } },
  ];
  return {
    id,
    label: id,
    task: { description: 'a goal' },
    startedAt: new Date(NOW - 200_000).toISOString(),
    endedAt: new Date(NOW - 100_000 + ts).toISOString(),
    events: events as VizRun['events'],
  };
}

function finishedEntry(id: string, endedAtOffsetMs: number): VizRunIndexEntry {
  return {
    id,
    label: id,
    startedAt: new Date(NOW - 200_000).toISOString(),
    endedAt: new Date(NOW - endedAtOffsetMs).toISOString(),
    hasError: false,
  };
}

function runsDir(entries: unknown[], traces: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-trajectory-ref-'));
  roots.push(root);
  writeFileSync(join(root, 'index.json'), JSON.stringify(entries), 'utf8');
  for (const [id, trace] of Object.entries(traces)) {
    writeFileSync(join(root, `${id}.json`), JSON.stringify(trace), 'utf8');
  }
  return root;
}

const KEY = { l1Name: 'Methane', skillId: 'node-api', keyedBy: 'skill' as const };

describe('the operator reference', () => {
  it('reads finished runs only, and counts a finished run whose trace it cannot read', () => {
    const dir = runsDir(
      [
        finishedEntry('done-1', 60_000),
        finishedEntry('done-2', 30_000),
        finishedEntry('done-but-torn', 20_000),
        { id: 'live', label: 'live', startedAt: new Date(NOW - 5_000).toISOString(), hasError: false, inFlight: true, lastEventAt: NOW - 1_000 },
      ],
      {
        'done-1': creditedTrace('done-1', 'Methane', 'node-api', ['write_file', 'fetch_url']),
        'done-2': creditedTrace('done-2', 'Methane', 'node-api', ['write_file', 'fetch_url', 'read_file']),
        live: creditedTrace('live', 'Methane', 'node-api', ['write_file']),
      }
    );
    writeFileSync(join(dir, 'done-but-torn.json'), '{"id": "done-but-torn", "events": [', 'utf8');
    const load = operatorTrajectoryReferenceSource({ runsDir: dir }).load();
    expect(load.corpus).toBe('operator');
    expect(load.unreadable).toBe(1);
    expect(load.reference.runs).toBe(2);
    expect(referenceSamples(load.reference, KEY).map((s) => s.runId)).toEqual(['done-1', 'done-2']);
  });

  it('keeps the newest runs when the window is bounded', () => {
    const dir = runsDir(
      [finishedEntry('oldest', 90_000), finishedEntry('middle', 60_000), finishedEntry('newest', 30_000)],
      {
        oldest: creditedTrace('oldest', 'Methane', 'node-api', ['write_file']),
        middle: creditedTrace('middle', 'Methane', 'node-api', ['write_file']),
        newest: creditedTrace('newest', 'Methane', 'node-api', ['write_file']),
      }
    );
    const load = operatorTrajectoryReferenceSource({ runsDir: dir, maxRuns: 2 }).load();
    expect(referenceSamples(load.reference, KEY).map((s) => s.runId)).toEqual(['middle', 'newest']);
  });

  it('answers a missing or torn index with an empty reference, never a throw', () => {
    const absent = operatorTrajectoryReferenceSource({ runsDir: join(tmpdir(), 'atoma-trajectory-nowhere') }).load();
    expect(absent.reference.runs).toBe(0);
    const dir = runsDir([], {});
    writeFileSync(join(dir, 'index.json'), '[{"id": ', 'utf8');
    expect(operatorTrajectoryReferenceSource({ runsDir: dir }).load().reference.runs).toBe(0);
  });

  it('re-reads a trace only when the file changed', () => {
    const dir = runsDir([finishedEntry('done-1', 60_000)], {
      'done-1': creditedTrace('done-1', 'Methane', 'node-api', ['write_file']),
    });
    const source = operatorTrajectoryReferenceSource({ runsDir: dir });
    expect(referenceSamples(source.load().reference, KEY)).toHaveLength(1);
    // Same bytes, same mtime: the cache answers and the file is not parsed again.
    // Prove the cache is keyed on size+mtime rather than "always": rewrite the
    // trace with a second credited execution and the reference follows.
    const path = join(dir, 'done-1.json');
    const trace = JSON.parse(readFileSync(path, 'utf8')) as VizRun;
    const twice = creditedTrace('done-1', 'Methane', 'node-api', ['write_file', 'read_file']);
    const renamed = twice.events.map((event) => ({ ...event, id: `${event.id}-b`, ...('llmEventId' in event ? { llmEventId: 'done-1-exec-b' } : {}) }));
    const closing = renamed.find((event) => event.kind === 'llm')!;
    (closing as { id: string }).id = 'done-1-exec-b';
    writeFileSync(path, JSON.stringify({ ...trace, events: [...trace.events, ...renamed] }), 'utf8');
    expect(referenceSamples(source.load().reference, KEY)).toHaveLength(2);
  });
});

describe('the project reference', () => {
  it('reads the traces the control plane says have ended, newest window, counting the ones without a file', () => {
    const dir = runsDir([], {
      'p-1': creditedTrace('p-1', 'Methane', 'node-api', ['write_file']),
      'p-2': creditedTrace('p-2', 'Methane', 'node-api', ['write_file', 'fetch_url']),
      'p-3': creditedTrace('p-3', 'Methane', 'node-api', ['write_file', 'fetch_url', 'read_file']),
    });
    const reader = {
      listFinishedRunTraces: () => [
        { projectRunId: 'p-1', endedAt: new Date(NOW - 90_000).toISOString(), file: join(dir, 'p-1.json') },
        { projectRunId: 'p-2', endedAt: new Date(NOW - 60_000).toISOString(), file: join(dir, 'p-2.json') },
        { projectRunId: 'p-gone', endedAt: new Date(NOW - 50_000).toISOString(), file: null },
        { projectRunId: 'p-3', endedAt: new Date(NOW - 30_000).toISOString(), file: join(dir, 'p-3.json') },
      ],
    };
    const load = projectTrajectoryReferenceSource({ reader, maxRuns: 3 }).load();
    expect(load.corpus).toBe('project');
    expect(load.unreadable).toBe(1);
    expect(referenceSamples(load.reference, KEY).map((s) => s.runId)).toEqual(['p-2', 'p-3']);
  });
});
