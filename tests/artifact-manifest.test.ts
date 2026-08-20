import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declaredArtifactManifestSchema } from '../src/contracts/artifactManifest.js';
import { persistDeclaredArtifactManifest } from '../src/run/runner.js';

describe('declared artifact manifest contract', () => {
  it('accepts one runner-owned manifest and rejects path-shaped run ids', () => {
    expect(declaredArtifactManifestSchema.parse({
      version: 1,
      runId: 'project-run:abc123',
      generatedAt: '2026-08-20T12:00:00.000Z',
      outputs: ['index.html', 'src/app.ts'],
    }).outputs).toEqual(['index.html', 'src/app.ts']);
    expect(() => declaredArtifactManifestSchema.parse({
      version: 1,
      runId: '../escape',
      generatedAt: '2026-08-20T12:00:00.000Z',
      outputs: [],
    })).toThrow();
  });

  it('persists the accepted plan outputs atomically and deduplicated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-artifact-manifest-'));
    const path = join(dir, 'control', 'manifest.json');
    try {
      persistDeclaredArtifactManifest(path, 'project-run:abc123', {
        reasoning: 'build then verify',
        subtasks: [
          { description: 'build', outputs: ['index.html', 'src/app.ts'] },
          { description: 'verify', outputs: ['index.html'] },
        ],
        aggregation: { mode: 'sequential' },
        expectedOutput: 'runnable app',
      });
      const parsed = declaredArtifactManifestSchema.parse(
        JSON.parse(readFileSync(path, 'utf8'))
      );
      expect(parsed.runId).toBe('project-run:abc123');
      expect(parsed.outputs).toEqual(['index.html', 'src/app.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
