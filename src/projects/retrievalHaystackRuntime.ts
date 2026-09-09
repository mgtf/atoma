import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { projectDocumentDigestSchema } from '../contracts/projectRetrieval.js';

/** Read installed metadata only. No models, downloads or provider calls. */
export function inspectHaystackRuntime(python: string): { sha256: string; identity: unknown } {
  if (!isAbsolute(python)) throw new Error('Haystack requires an absolute host Python executable');
  const report = JSON.parse(execFileSync(python, ['-I', fileURLToPath(new URL('../../scripts/retrieval-haystack.py', import.meta.url)), '--identity'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 32_768,
    env: { PATH: process.env['PATH'], HAYSTACK_TELEMETRY_ENABLED: 'False', HF_HUB_OFFLINE: '1' },
  })) as { sha256: unknown; identity: unknown };
  const sha256 = projectDocumentDigestSchema.parse(report.sha256);
  // Python's ASCII encoding is identical for package metadata (names and versions).
  if (createHash('sha256').update(JSON.stringify(report.identity)).digest('hex') !== sha256) throw new Error('invalid Haystack runtime identity');
  return { sha256, identity: report.identity };
}
