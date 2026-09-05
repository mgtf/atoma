import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '../src/contracts/platformEvents.js';
import type { AnalyseResult } from '../src/supervisor/analyst.js';
import { startResidentAnalyst, vizAnalystEnabled } from '../src/supervisor/resident.js';

/**
 * THE RESIDENT ANALYST SHELL. What these hold: it queues on `run.finished`
 * rows from the journal bus, waits the quiet period, defers while a run is
 * active, analyses one run at a time, re-queues a run the gate refused at the
 * last moment, and is opt-in.
 */

function bus() {
  const listeners = new Set<(event: PlatformEvent) => void>();
  return {
    subscribe: (listener: (event: PlatformEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finished(runId: string, at: string) {
      const event: PlatformEvent = {
        seq: 1,
        at,
        severity: 'info',
        kind: 'run.finished',
        actorType: 'principal',
        actorId: 'p1',
        orgId: 'o1',
        projectId: 'pr1',
        runId,
        summary: 'Run delivered: x',
      };
      for (const listener of listeners) listener(event);
    },
  };
}

describe('startResidentAnalyst', () => {
  it('queues finished runs, waits the quiet period, and analyses them one at a time in order', async () => {
    const b = bus();
    let clock = 1_000_000;
    const analysed: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const resident = startResidentAnalyst({
      subscribe: b.subscribe,
      analyse: async (runId) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        analysed.push(runId);
        concurrent -= 1;
        return { runId, outcome: 'analysed', verdictPath: null } satisfies AnalyseResult;
      },
      isActive: () => false,
      quietMs: 10_000,
      pollMs: 60_000,
      now: () => clock,
    });
    try {
      b.finished('b', new Date(clock - 5_000).toISOString());
      b.finished('a', new Date(clock - 20_000).toISOString());
      b.finished('a', new Date(clock - 20_000).toISOString()); // a duplicate row queues nothing
      expect(resident.health().queued).toBe(2);
      await resident.drainNow();
      expect(analysed).toEqual(['a']); // b has not been quiet long enough
      clock += 10_000;
      await resident.drainNow();
      expect(analysed).toEqual(['a', 'b']);
      expect(maxConcurrent).toBe(1);
      expect(resident.health()).toMatchObject({ armed: true, queued: 0, analysed: 2, failed: 0, inFlight: null });
    } finally {
      resident.stop();
    }
  });

  it('defers while a run is active and re-queues a run the gate refused at the last moment', async () => {
    const b = bus();
    let active = true;
    let attempts = 0;
    const resident = startResidentAnalyst({
      subscribe: b.subscribe,
      analyse: (runId) => {
        attempts += 1;
        return Promise.resolve({ runId, outcome: attempts === 1 ? 'refused-active' : 'analysed', verdictPath: null } satisfies AnalyseResult);
      },
      isActive: () => active,
      quietMs: 0,
      pollMs: 60_000,
      now: () => 5_000_000,
    });
    try {
      b.finished('r', new Date(4_000_000).toISOString());
      await resident.drainNow();
      expect(attempts).toBe(0);
      expect(resident.health().deferred).toBe(1);
      active = false;
      await resident.drainNow();
      // First attempt was refused by the analyst's own gate: back in the queue, not lost.
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(resident.health().queued + attempts).toBeGreaterThanOrEqual(2);
      await resident.drainNow();
      expect(resident.health().analysed).toBe(1);
      expect(resident.health().queued).toBe(0);
    } finally {
      resident.stop();
    }
  });

  it('counts a throwing analysis as failed and keeps running', async () => {
    const b = bus();
    const resident = startResidentAnalyst({
      subscribe: b.subscribe,
      analyse: () => Promise.reject(new Error('boom')),
      isActive: () => false,
      quietMs: 0,
      pollMs: 60_000,
      now: () => 9_000_000,
    });
    try {
      b.finished('x', new Date(8_000_000).toISOString());
      await resident.drainNow();
      expect(resident.health()).toMatchObject({ failed: 1, queued: 0, lastError: 'boom', armed: true });
    } finally {
      resident.stop();
    }
  });

  it('is opt-in: off unless explicitly 1 or true, and a typo stays off', () => {
    const warnings: string[] = [];
    const warn = (line: string): void => void warnings.push(line);
    expect(vizAnalystEnabled({}, warn)).toBe(false);
    expect(vizAnalystEnabled({ ATOMA_VIZ_ANALYST: '1' }, warn)).toBe(true);
    expect(vizAnalystEnabled({ ATOMA_VIZ_ANALYST: 'true' }, warn)).toBe(true);
    expect(vizAnalystEnabled({ ATOMA_VIZ_ANALYST: '0' }, warn)).toBe(false);
    expect(vizAnalystEnabled({ ATOMA_VIZ_ANALYST: 'yes' }, warn)).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
