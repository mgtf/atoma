import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { haystackLaunchSchema } from '../contracts/retrievalHaystack.js';
import { haystackModelRevision } from '../projects/retrievalModelFiles.js';
import { inspectHaystackRuntime } from '../projects/retrievalRuntime.js';

export async function generateHaystackConfig(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, options: {
    python: { type: 'string' }, embedding: { type: 'string' }, reranker: { type: 'string' },
    'query-prefix': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return 'Usage: haystack:config --python /absolute/venv/bin/python [--embedding /models/embedding --reranker /models/reranker --query-prefix "model-specific prefix"]\nPrints JSON for ATOMA_HAYSTACK_CONFIG; does not install packages, download models or edit environment files.';
  if (!values.python) throw new Error('--python is required');
  const hybrid = values.embedding !== undefined || values.reranker !== undefined || values['query-prefix'] !== undefined;
  if (hybrid && (!values.embedding || !values.reranker || values['query-prefix'] === undefined)) {
    throw new Error('Hybrid mode requires --embedding, --reranker and --query-prefix (may be empty)');
  }
  const context = { signal: AbortSignal.timeout(120_000), deadlineAt: Date.now() + 120_000 };
  const settings = hybrid ? {
    mode: 'hybrid-rerank' as const, embeddingPath: resolve(values.embedding!), rerankerPath: resolve(values.reranker!),
    queryPrefix: values['query-prefix']!,
    embeddingRevision: await haystackModelRevision(resolve(values.embedding!), context),
    rerankerRevision: await haystackModelRevision(resolve(values.reranker!), context),
  } : { mode: 'bm25' as const };
  return JSON.stringify(haystackLaunchSchema.parse({ python: resolve(values.python), settings,
    runtimeSha256: await inspectHaystackRuntime(resolve(values.python), hybrid) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateHaystackConfig(process.argv.slice(2)).then(value => console.log(value)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Haystack configuration failed');
    process.exitCode = 1;
  });
}
