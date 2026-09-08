import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLlmClient } from '../src/core/llm.js';
import { parseRunnerArgs, resetHostLifecycleSnapshotForTests, startTask } from '../src/run/runner.js';
import { buildProfile } from '../src/run/profiles/build.js';
import { containerToolBackend, localToolBackend } from '../src/run/toolBackend.js';
import { buildTierClients } from '../src/run/providers.js';
import { previewImageDigestSchema } from '../src/contracts/preview.js';
import { containerImageDigestSchema } from '../src/contracts/containerImage.js';

vi.mock('../src/run/toolBackend.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/run/toolBackend.js')>(),
  containerToolBackend: vi.fn(),
}));
vi.mock('../src/run/providers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/run/providers.js')>(),
  buildTierClients: vi.fn(),
}));

const digest = 'sha256:' + 'c'.repeat(64);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetHostLifecycleSnapshotForTests(); });

describe('registered worker image through the production runner', () => {
  it('reuses the existing preview digest contract without changing its public export', () => {
    expect(previewImageDigestSchema).toBe(containerImageDigestSchema);
  });

  it('parses a pinned image without consuming the goal and refuses mutable or unused pins', () => {
    vi.stubEnv('ATOMA_CONTAINER', '0');
    vi.stubEnv('ATOMA_EGRESS', '0');
    expect(parseRunnerArgs(['--container', '--worker-image', digest, 'the goal'])).toMatchObject({
      container: true, workerImage: digest, goal: 'the goal',
    });
    expect(() => parseRunnerArgs(['--container', '--worker-image', 'atoma-worker:latest', 'g'])).toThrow(/sha256/);
    expect(() => parseRunnerArgs(['--worker-image', digest, 'g'])).toThrow(/container/);
    expect(() => parseRunnerArgs(['--container', '--worker-image'])).toThrow(/sha256/);
  });

  it('passes the exact pin from startTask into the container factory and cleans up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-worker-pin-'));
    const llm = new MockLlmClient();
    llm.enqueueText('The bounded test task is complete.');
    vi.mocked(buildTierClients).mockReturnValue({ ollama: llm });
    const backend = localToolBackend({ workspaceRoot: join(root, 'workspace'), logger: console });
    const cleanup = vi.fn(() => backend.cleanup());
    vi.mocked(containerToolBackend).mockResolvedValue({ ...backend, cleanup });
    for (const [key, value] of Object.entries({
      ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test',
      ATOMA_BASELINE_MODEL: 'api:ollama:test', ATOMA_BUILD_WORKSPACE: join(root, 'workspace'),
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
      ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: join(root, 'traces'),
      ATOMA_BUILD_TIMEOUT_MS: '10000', ATOMA_EGRESS: '0', ATOMA_TENANT_RUN: '',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(buildProfile, ['--baseline', '--container', '--worker-image', digest,
        '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', 'Complete the test task.']);
      await handle.settled;
      expect(containerToolBackend).toHaveBeenCalledWith(expect.objectContaining({ image: digest, egress: false }));
      expect(llm.calls).toHaveLength(1);
    } finally {
      await handle?.shutdown();
      await backend.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
    expect(cleanup).toHaveBeenCalled();
  });
});
