import { afterEach, describe, expect, it, vi } from 'vitest';
import { containerToolBackend } from '../src/run/toolBackend.js';
import { ContainerToolExecutor } from '../src/tools/containerExecutor.js';

const capture = vi.hoisted(() => ({ images: [] as string[] }));
vi.mock('../src/launcher/remoteWorker.js', () => ({
  RemoteWorkerExecutor: class {
    constructor(options: { image: string }) { capture.images.push(options.image); }
    start() { return Promise.resolve(); }
    toolDeclarations() { return []; }
    drain() { return Promise.resolve(); }
  },
}));
afterEach(() => { vi.unstubAllEnvs(); capture.images.length = 0; });

describe('host worker image selection', () => {
  it('carries the host pin through both the backend and direct executor callers', async () => {
    const image = `registry.example/worker@sha256:${'b'.repeat(64)}`;
    vi.stubEnv('ATOMA_LAUNCHER_SOCKET', '/srv/atoma/control/launcher.sock');
    vi.stubEnv('ATOMA_LAUNCHER_WORKSPACE_ID', 'operator');
    vi.stubEnv('ATOMA_WORKER_IMAGE', image);
    const backend = await containerToolBackend({ workspaceRoot: '/srv/atoma/workspaces/operator' });
    await backend.cleanup();
    const direct = new ContainerToolExecutor({ workspaceHostPath: '/srv/atoma/workspaces/operator' });
    await direct.start();
    await direct.drain();
    expect(capture.images).toEqual([image, image]);
  });
  it('keeps an explicit image authoritative so profile mismatches still fail closed', () => {
    vi.stubEnv('ATOMA_LAUNCHER_SOCKET', '/srv/atoma/control/launcher.sock');
    vi.stubEnv('ATOMA_LAUNCHER_WORKSPACE_ID', 'operator');
    vi.stubEnv('ATOMA_WORKER_IMAGE', 'host-pin');
    new ContainerToolExecutor({ workspaceHostPath: '/srv/atoma/workspaces/operator', image: 'explicit-pin' });
    expect(capture.images).toEqual(['explicit-pin']);
  });
});
