import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../src/viz/trace.js';
import { createAttestationLog, attestingExecutor } from '../src/core/attestation.js';
import { acceptanceSchema } from '../src/contracts/depthRouting.js';
import { gpuEventCardCopy } from '../src/viz/client-gl/renderer/copy.js';
import { buildTimelineLayout } from '../src/viz/client/timeline-layout.js';
import { visibleEventKindFilters } from '../src/viz/client/run-utils.js';
import type { VizRun } from '../src/viz/client/types.js';

describe('depth evidence in persisted traces and GPU timeline', () => {
  it('retains both attempts, resolves observation references, and displays topology and acceptance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-depth-trace-'));
    const recorder = new TraceRecorder(root);
    try {
      const run = recorder.beginRun({ description: 'Fixture' });
      const log = createAttestationLog((record) => recorder.recordAttestation(record));
      const tool = { has: () => true, execute: async () => ({ ok: true, errors: [], failedRequests: [],
        interactionLog: ['click #save'], document: { path: 'index.html', sha256: 'a'.repeat(64) } }) };
      recorder.recordTopology({ at: 'entry', mode: 'short', reason: 'arm', attempt: 1 });
      await attestingExecutor(tool, log, 'old', undefined, 1)!.execute('validate_html', {});
      recorder.recordTopology({ at: 'deepening', mode: 'deep', reason: 'fallback-moment', attempt: 2 });
      await attestingExecutor(tool, log, 'new', undefined, 2)!.execute('validate_html', {});
      const reference = log.forAttempt(2)[0]!.eventId;
      recorder.recordAcceptance(acceptanceSchema.parse({ attempt: 2, approved: true, reasoning: 'Evidence reviewed',
        acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' },
        executor: { name: 'Meristem', tier: 3, viaFallback: false }, gates: [],
        probe: { requiresReview: false, contradiction: false }, phaseCoverage: [], basis: 'mechanical',
        floorCoverage: [{ kind: 'dom-interaction', deliverable: 'index.html', status: 'covered', observationRefs: [reference] }],
      }));
      recorder.endRun({});
      const saved = JSON.parse(readFileSync(join(root, `${run.id}.json`), 'utf8')) as VizRun & {
        attestations: Array<{ eventId: string; attempt: number }>;
      };
      expect(saved.attestations.map((item) => item.attempt)).toEqual([1, 2]);
      expect(saved.attestations.find((item) => item.eventId === reference)?.attempt).toBe(2);
      const layout = buildTimelineLayout(saved.events, { kind: 'all', role: 'all', branchId: 'all' });
      expect(layout.items.map((item) => item.event.kind)).toEqual(['topology', 'topology', 'acceptance']);
      expect(visibleEventKindFilters(saved.events)).toContain('acceptance');
      const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
      expect(gpuEventCardCopy(saved.events[1]!, t)).toMatchObject({ title: 'depth.topology', body: 'depth.deepening' });
      expect(gpuEventCardCopy(saved.events[2]!, t)).toMatchObject({ title: 'depth.acceptance', decision: 'outcome.approved' });
      expect(gpuEventCardCopy(saved.events[2]!, t).meta).toContain('"attempt":2');
      recorder.beginRun({ description: 'Ordinary run' });
      recorder.record({ id: 'ordinary', ts: Date.now(), kind: 'topology', at: 'entry', mode: 'deep', reason: 'arm', attempt: 1 });
      expect(recorder.currentRun!.events[0]!.attempt).toBe(1);
      recorder.endRun({});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
