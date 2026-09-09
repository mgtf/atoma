import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { haystackLaunchSchema, type HaystackLaunch } from '../contracts/retrievalHaystack.js';
import { haystackModelRevision } from './retrievalModelFiles.js';

/** Read-only host inspection: imports and content pins, never inference or downloads. */
export async function inspectHaystackRuntime(python: string, hybrid: boolean): Promise<string> {
  const { stdout } = await promisify(execFile)(python, ['-I',
    fileURLToPath(new URL('../../scripts/retrieval-haystack.py', import.meta.url)),
    hybrid ? '--check-hybrid' : '--check'], {
    timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env['PATH'], LANG: 'C.UTF-8',
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HAYSTACK_TELEMETRY_ENABLED: 'False',
      HF_HUB_DISABLE_TELEMETRY: '1' },
  });
  const identity = JSON.parse(stdout) as { sha256?: unknown };
  return haystackLaunchSchema.shape.runtimeSha256.parse(identity.sha256);
}

export async function verifyHaystackLaunch(launch: HaystackLaunch): Promise<void> {
  if (await inspectHaystackRuntime(launch.python, launch.settings.mode === 'hybrid-rerank') !== launch.runtimeSha256) {
    throw new Error('Python package identity changed; regenerate ATOMA_HAYSTACK_CONFIG');
  }
  if (launch.settings.mode === 'hybrid-rerank') {
    const context = { signal: AbortSignal.timeout(120_000), deadlineAt: Date.now() + 120_000 };
    const models = [[launch.settings.embeddingPath, launch.settings.embeddingRevision],
      [launch.settings.rerankerPath, launch.settings.rerankerRevision]] as const;
    for (const [path, digest] of models) {
      if (await haystackModelRevision(path, context) !== digest) throw new Error('Haystack model content changed');
    }
  }
}
