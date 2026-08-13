import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/registry/db.js';
import { RecordingRegistry } from '../src/viz/recordingRegistry.js';
import { TraceRecorder, type VizRegistryEvent } from '../src/viz/trace.js';

const seed = {
  description: 'fixture',
  systemPrompt: 'fixture',
  tools: [],
  params: {},
  createdBy: 'user',
};

describe('registry trace actor/child attribution', () => {
  it('records exact mutation initiators and targets when the caller provides them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-registry-viz-'));
    const db = openDb(':memory:');
    const recorder = new TraceRecorder(dir);
    recorder.beginRun({ description: 'registry attribution' });
    try {
      const registry = new RecordingRegistry(db, recorder);
      const tissue = registry.create(3, seed);
      const cell = registry.create(2, { ...seed, createdBy: tissue.name });
      registry.patch(
        cell.name,
        { systemPromptAppend: 'patched' },
        tissue.name,
        'test patch'
      );
      const branch = registry.branch(
        cell.name,
        { systemPromptAppend: 'branched' },
        tissue.name
      );
      registry.recordSuccess(cell.name, tissue.name);
      registry.recordFailure(branch.name, tissue.name);
      registry.recordSuccess(tissue.name);

      const events = recorder.currentRun!.events.filter(
        (event): event is VizRegistryEvent => event.kind === 'registry'
      );
      const cellCreate = events.find(
        (event) => event.op === 'create' && event.name === cell.name
      );
      expect(cellCreate).toMatchObject({
        actor: { name: tissue.name, tier: 3 },
        child: { name: cell.name, tier: 2 },
      });
      expect(events.find((event) => event.op === 'patch')).toMatchObject({
        actor: { name: tissue.name, tier: 3 },
        child: { name: cell.name, tier: 2 },
      });
      expect(events.find((event) => event.op === 'branch')).toMatchObject({
        actor: { name: tissue.name, tier: 3 },
        child: { name: branch.name, tier: 2 },
        from: cell.name,
      });
      expect(events.find(
        (event) => event.op === 'recordSuccess' && event.name === cell.name
      )).toMatchObject({
        actor: { name: tissue.name, tier: 3 },
        child: { name: cell.name, tier: 2 },
      });
      expect(events.find((event) => event.op === 'recordFailure')).toMatchObject({
        actor: { name: tissue.name, tier: 3 },
        child: { name: branch.name, tier: 2 },
      });
      // A direct/operator bump has a known target but no invented initiator.
      const unattributed = events.find(
        (event) => event.op === 'recordSuccess' && event.name === tissue.name
      );
      expect(unattributed?.actor).toBeUndefined();
      expect(unattributed).toMatchObject({
        child: { name: tissue.name, tier: 3 },
      });
    } finally {
      recorder.endRun({});
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
