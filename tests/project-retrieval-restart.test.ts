import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localToolBackend, withProjectRetrievalBackend } from '../src/run/toolBackend.js';
import type { ProjectRetrievalBinding } from '../src/tools/projectRetrieval.js';
import { silentLogger } from './helpers.js';

/**
 * A DEEPENING keeps the run's project documents (2026-09-25 review, 1.7).
 *
 * The runner's restart drains the backend, archives the workspace and builds
 * a new backend over the SAME retrieval binding. The service below keeps the
 * latch of `openProjectRunHaystack` (dispose closes it for good), so a drain
 * that disposed the service denied every search of the deep attempt.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project retrieval across a deepening restart', () => {
  it('still answers after the backend is drained and rebuilt over the same binding, and is disposed once at cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-restart-'));
    roots.push(root);
    let closed = false;
    let disposals = 0;
    const hex = (c: string) => c.repeat(64);
    const binding = {
      scope: { kind: 'tenant', orgId: 'org_1', projectId: 'prj_1', runId: 'run_1', principalId: 'usr_1',
        corpusId: 'c1', snapshotId: 's1', snapshotSha256: hex('a'), generation: hex('b') },
      service: {
        authorize: async () => !closed,
        search: async () => ({ ok: true, status: 'ok', corpusId: 'c1', snapshotId: 's1', snapshotSha256: hex('a'),
          generation: hex('b'), passages: [], truncated: false }),
        dispose: async () => { closed = true; disposals += 1; },
      },
    } as unknown as ProjectRetrievalBinding;
    const context = { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 };
    const make = () => withProjectRetrievalBackend(
      localToolBackend({ workspaceRoot: join(root, 'ws'), logger: silentLogger() }), binding, context);
    let backend = await make();
    const name = backend.toolDecls.find((tool) => tool.name === 'search_project_docs')?.name;
    expect(name).toBe('search_project_docs');
    expect(await backend.executor.execute(name!, { query: 'invoice schema' })).toMatchObject({ ok: true });
    // The restart: drain, then a new backend over the same binding.
    await backend.drain!();
    expect(disposals).toBe(0);
    backend = await make();
    expect(await backend.executor.execute(name!, { query: 'invoice schema' })).toMatchObject({ ok: true, status: 'ok' });
    await backend.cleanup();
    expect(disposals).toBe(1);
  });
});
