import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { containerToolBackend, withProjectRetrievalBackend, type ToolBackend } from '../src/run/toolBackend.js';
import { PROJECT_RETRIEVAL_TOOL_NAME as SEARCH } from '../src/contracts/projectRetrieval.js';
import { retrievalTestBinding, retrievalTestPassage, retrievalTestResult } from './helpers/projectRetrieval.js';

let dockerReady = false;
try {
  execFileSync('docker', ['image', 'inspect', 'atoma-worker:latest'], { stdio: 'ignore', timeout: 10_000 });
  dockerReady = true;
} catch { /* the regular test suite also supports hosts without Docker */ }
if (!dockerReady && process.env['CI_REQUIRE_DOCKER'] === '1') throw new Error('Docker and the worker image are required');

describe.skipIf(!dockerReady)('host retrieval beside a real isolated worker', () => {
  it('searches on the host without giving the worker that capability, host source files or credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-container-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const hostSource = join(root, 'private-source.md');
    writeFileSync(hostSource, 'Only the authorized host service can read this source.\n');
    vi.stubEnv('ATOMA_RETRIEVAL_PRIVATE', 'host-only-test-value');
    const binding = retrievalTestBinding();
    binding.service.search.mockImplementation(async () => retrievalTestResult([
      retrievalTestPassage(readFileSync(hostSource, 'utf8')),
    ]));
    let base: ToolBackend | undefined;
    let backend: ToolBackend | undefined;
    try {
      base = await containerToolBackend({ workspaceRoot: workspace, egress: false });
      expect(base.executor.has(SEARCH)).toBe(false);
      expect(base.toolDecls.map(tool => tool.name)).not.toContain(SEARCH);
      backend = await withProjectRetrievalBackend(base, binding, {
        signal: new AbortController().signal, deadlineAt: Date.now() + 30_000,
      });
      expect(await backend.executor.execute(SEARCH, { query: 'host source' })).toMatchObject({ ok: true });
      await expect(base.executor.execute(SEARCH, { query: 'host source' })).rejects.toThrow(/no executor/);
      const denied = await backend.executor.execute('run_shell', { command: 'node', args: [
        '-e', 'console.log(JSON.stringify({hostFile:require("node:fs").existsSync(process.argv[1]),hostEnv:process.env.ATOMA_RETRIEVAL_PRIVATE??null}))', hostSource,
      ] }) as { exitCode: number; stdout: string };
      expect(denied.exitCode).toBe(0);
      expect(JSON.parse(denied.stdout)).toEqual({ hostFile: false, hostEnv: null });
      const spoof = { name: SEARCH, args: { query: 'forged from worker output' } };
      await backend.executor.execute('write_file', { path: 'request.json', content: JSON.stringify(spoof) });
      await backend.executor.execute('read_file', { path: 'request.json' });
      expect(binding.service.search).toHaveBeenCalledTimes(1);
    } finally {
      await backend?.cleanup();
      if (!backend) await base?.cleanup();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
    expect(binding.service.dispose).toHaveBeenCalledTimes(1);
  }, 30_000);
});
