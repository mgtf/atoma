import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finishedRuns, probeActivity } from '../src/supervisor/activity.js';

/**
 * THE ONE IDLE PREDICATE both supervisor stages gate on. What it holds: a live
 * index entry or a torn index means active; finished entries mean idle; an
 * absent index and an absent lease mean idle — and the finished-runs listing
 * is ordered by end time.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { runsDir: string; leasePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-activity-'));
  roots.push(root);
  return { runsDir: root, leasePath: join(root, 'no-lease.db') };
}

const NOW = 1_700_000_000_000;

describe('probeActivity', () => {
  it('is idle with no index and no lease', () => {
    expect(probeActivity(fixture(), NOW)).toEqual({ active: false, reason: 'idle' });
  });

  it('is active while an in-flight entry is fresh, idle once every entry ended', () => {
    const f = fixture();
    writeFileSync(
      join(f.runsDir, 'index.json'),
      JSON.stringify([{ id: 'a', label: 'a', startedAt: new Date(NOW - 60_000).toISOString(), inFlight: true, lastEventAt: NOW - 5_000 }])
    );
    expect(probeActivity(f, NOW)).toEqual({ active: true, reason: 'live-index-entry' });
    writeFileSync(
      join(f.runsDir, 'index.json'),
      JSON.stringify([{ id: 'a', label: 'a', startedAt: new Date(NOW - 60_000).toISOString(), endedAt: new Date(NOW - 1_000).toISOString() }])
    );
    expect(probeActivity(f, NOW)).toEqual({ active: false, reason: 'idle' });
  });

  it('treats a torn index as active — a run is writing it', () => {
    const f = fixture();
    writeFileSync(join(f.runsDir, 'index.json'), '[{"id": "a", "startedAt": ');
    expect(probeActivity(f, NOW)).toEqual({ active: true, reason: 'index-torn' });
  });
});

describe('finishedRuns', () => {
  it('lists only ended entries, oldest first', () => {
    const f = fixture();
    writeFileSync(
      join(f.runsDir, 'index.json'),
      JSON.stringify([
        { id: 'late', label: '', startedAt: 's', endedAt: '2026-09-05T10:00:02.000Z' },
        { id: 'live', label: '', startedAt: 's', inFlight: true },
        { id: 'early', label: '', startedAt: 's', endedAt: '2026-09-05T10:00:01.000Z' },
      ])
    );
    expect(finishedRuns(f.runsDir).map((entry) => entry.id)).toEqual(['early', 'late']);
  });
});
