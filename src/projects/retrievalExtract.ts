import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_RETRIEVAL_CORPUS_LIMITS } from '../contracts/projectRetrievalCorpus.js';
import { projectDocumentFormat } from '../contracts/projectRetrieval.js';
import type { ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';

/** Parse captured bytes in a disposable process; never pass a source path or credentials. */
export async function extractProjectDocument(path: string, bytes: Buffer,
  context: ProjectRetrievalCallContext): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), 'atoma-document-'));
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=256',
        fileURLToPath(new URL('../../scripts/retrieval-extract.mjs', import.meta.url)),
        projectDocumentFormat(path)!, scratch], {
        cwd: scratch, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env['PATH'], LANG: 'C.UTF-8', HOME: scratch, TMPDIR: scratch },
      });
      const output: Buffer[] = [];
      let size = 0;
      let failed = false;
      const killGroup = () => {
        if (child.pid && Number.isSafeInteger(child.pid) && child.pid > 1) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }
      };
      const stop = () => { failed = true; killGroup(); };
      const timer = setTimeout(stop, Math.max(1, Math.min(60_000, context.deadlineAt - Date.now())));
      context.signal.addEventListener('abort', stop, { once: true });
      child.on('error', stop);
      child.stdin.on('error', stop);
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > PROJECT_RETRIEVAL_CORPUS_LIMITS.extractedDocumentBytes) stop();
        else output.push(chunk);
      });
      child.on('close', code => {
        killGroup(); // Reap any converter descendants even after a failed conversion.
        clearTimeout(timer);
        context.signal.removeEventListener('abort', stop);
        const text = Buffer.concat(output);
        if (failed || code !== 0 || context.signal.aborted || Date.now() >= context.deadlineAt ||
            !text.toString('utf8').trim() || text.includes(0) || !Buffer.from(text.toString('utf8')).equals(text)) {
          reject(new Error('document text extraction failed'));
        } else resolve(text);
      });
      if (context.signal.aborted || Date.now() >= context.deadlineAt) stop();
      child.stdin.end(bytes);
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
