import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';
import { assertRetrievalTime, projectRetrievalHash } from './retrievalCorpus.js';

/** Content pin over local immutable model files; download metadata is not model input. */
export async function haystackModelRevision(root: string, context: ProjectRetrievalCallContext): Promise<string> {
  if (!isAbsolute(root) || !(await lstat(root)).isDirectory()) throw new Error('invalid local model directory');
  const hashes: [string, string][] = [];
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    assertRetrievalTime(context);
    const file = join(root, relative); const before = await lstat(file);
    if (before.isSymbolicLink()) throw new Error('model symlinks are not admitted');
    if (before.isDirectory()) {
      for (const name of (await readdir(file)).filter(n => !n.startsWith('.')).sort()) await visit(join(relative, name));
      return;
    }
    if (!before.isFile() || hashes.length >= 1000 || (bytes += before.size) > 4 * 1024 ** 3) throw new Error('model files exceed experiment limits');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal: context.signal })) { assertRetrievalTime(context); hash.update(chunk); }
    const after = await lstat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('model files changed');
    hashes.push([relative, hash.digest('hex')]);
  };
  await visit('');
  if (!hashes.length) throw new Error('empty model directory');
  return projectRetrievalHash(JSON.stringify(hashes));
}
