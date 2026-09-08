import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  DEFAULT_PROJECT_RETRIEVAL_CHUNKS, PROJECT_RETRIEVAL_CORPUS_LIMITS, PROJECT_RETRIEVAL_TOKENIZER,
  projectRetrievalChunkSettingsSchema, projectRetrievalIndexConfigSchema,
  projectRetrievalManifestSchema, type ProjectRetrievalChunkSettings,
  type ProjectRetrievalIndexConfig, type ProjectRetrievalManifest,
} from '../contracts/projectRetrievalCorpus.js';
import { projectRetrievalPassageSchema, type ProjectRetrievalPassage } from '../contracts/projectRetrieval.js';
import type { ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';

export function projectRetrievalHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertRetrievalTime(context: ProjectRetrievalCallContext): void {
  if (context.signal.aborted) throw new Error('project retrieval cancelled');
  if (!Number.isFinite(context.deadlineAt) || Date.now() >= context.deadlineAt) {
    throw new Error('project retrieval deadline exceeded');
  }
}

export function canonicalRetrievalManifest(input: unknown): ProjectRetrievalManifest {
  const parsed = projectRetrievalManifestSchema.parse(input);
  return projectRetrievalManifestSchema.parse({ ...parsed,
    documents: [...parsed.documents].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}

export function retrievalIndexConfig(chunks: Partial<ProjectRetrievalChunkSettings> = {}): ProjectRetrievalIndexConfig {
  return projectRetrievalIndexConfigSchema.parse({
    storageVersion: 1, extractionVersion: 'utf8-files-v1', chunkerVersion: 'markdown-lines-v1',
    chunks: projectRetrievalChunkSettingsSchema.parse({ ...DEFAULT_PROJECT_RETRIEVAL_CHUNKS, ...chunks }),
    contextVersion: 'path-headings-source-v1', tokenizer: PROJECT_RETRIEVAL_TOKENIZER,
    normalization: 'original-bytes; no overlap', embedding: null, generatedContext: null,
  });
}

export function retrievalGeneration(manifest: ProjectRetrievalManifest, config: ProjectRetrievalIndexConfig): string {
  return projectRetrievalHash(JSON.stringify([projectRetrievalHash(JSON.stringify(manifest)), config]));
}

export function retrievalDocumentId(path: string, sha256: string): string {
  return projectRetrievalHash(JSON.stringify([path, sha256]));
}

/** Searchable decoration is never substituted for an original-source excerpt. */
export function retrievalPassageContext(manifest: ProjectRetrievalManifest, passage: ProjectRetrievalPassage): string {
  return [passage.path, ...passage.headingContext, manifest.corpusId, manifest.snapshotId,
    manifest.snapshotSha256, passage.sha256].join('\n');
}

export interface PreparedProjectRetrievalCorpus {
  readonly manifest: ProjectRetrievalManifest;
  readonly config: ProjectRetrievalIndexConfig;
  readonly generation: string;
  readonly passages: readonly Readonly<ProjectRetrievalPassage>[];
}

/** Source roots must be host-owned immutable snapshots, never a live worker workspace. */
export async function captureProjectDocument(root: string, document: ProjectRetrievalManifest['documents'][number],
  context: ProjectRetrievalCallContext): Promise<Buffer> {
  let file = root;
  for (const segment of document.path.split('/')) {
    file = resolve(file, segment);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('document symlinks are not admitted');
  }
  const canonical = await realpath(file);
  if (!canonical.startsWith(root + sep)) throw new Error('document escapes snapshot');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o111) !== 0 || before.size !== document.bytes) {
      throw new Error('document is not an admitted regular text file');
    }
    // Bounded even if a file grows after stat. Never readFile an unbounded descriptor.
    const bytes = Buffer.alloc(document.bytes + 1);
    let count = 0;
    while (count < bytes.length) {
      assertRetrievalTime(context);
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    const captured = bytes.subarray(0, count);
    if (count !== document.bytes || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        await realpath(file) !== canonical || projectRetrievalHash(captured) !== document.sha256 ||
        captured.includes(0) || !Buffer.from(captured.toString('utf8'), 'utf8').equals(captured)) {
      throw new Error('document changed or is not the admitted UTF-8 source');
    }
    return captured;
  } finally { await handle.close(); }
}

interface SourceLine { start: number; end: number; number: number; text: string }

function sourceLines(bytes: Buffer): SourceLine[] {
  const lines: SourceLine[] = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    lines.push({ start, end, number: lines.length + 1, text: bytes.subarray(start, end).toString('utf8') });
    start = end;
  }
  return lines;
}

function chunkDocument(document: ProjectRetrievalManifest['documents'][number], bytes: Buffer,
  settings: ProjectRetrievalChunkSettings): Readonly<ProjectRetrievalPassage>[] {
  const lines = sourceLines(bytes);
  const passages: Readonly<ProjectRetrievalPassage>[] = [];
  const headings: { level: number; title: string }[] = [];
  let start = -1, end = -1, startLine = 1, endLine = 1;
  const flush = () => {
    if (start < 0) return;
    const passage = projectRetrievalPassageSchema.parse({
      documentId: retrievalDocumentId(document.path, document.sha256), path: document.path, sha256: document.sha256,
      startByte: start, endByte: end, startLine, endLine,
      headingContext: headings.map(h => h.title), excerpt: bytes.subarray(start, end).toString('utf8'),
    });
    Object.freeze(passage.headingContext);
    passages.push(Object.freeze(passage));
    start = -1;
  };
  const append = (line: SourceLine) => {
    let offset = line.start;
    while (offset < line.end) {
      if (start >= 0 && (line.end - start > settings.maxBytes || line.number - startLine >= settings.maxLines)) flush();
      let until = Math.min(line.end, offset + settings.maxBytes);
      // UTF-8 continuation bytes and CRLF pairs may not straddle a fallback split.
      while (until < line.end && (bytes[until]! & 0xc0) === 0x80) until--;
      if (until < line.end && bytes[until - 1] === 13 && bytes[until] === 10) until--;
      if (start < 0) { start = offset; startLine = line.number; }
      end = until; endLine = line.number;
      offset = until;
      if (until < line.end) flush();
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const markdown = document.path.endsWith('.md');
    const heading = markdown ? /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line.text) : null;
    const setext = markdown && !heading && line.text.trim() && i + 1 < lines.length ?
      /^ {0,3}(=+|-+)[ \t]*\r?\n?$/.exec(lines[i + 1]!.text) : null;
    if (heading || setext) {
      flush();
      const level = heading ? heading[1]!.length : setext![1]![0] === '=' ? 1 : 2;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, title: Array.from(heading ? heading[2]! : line.text.trim()).slice(0, 128).join('') });
      append(line);
      if (setext) append(lines[++i]!);
      continue;
    }
    const fence = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(line.text) : null;
    if (fence) {
      let last = i;
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?\\n?$`);
      while (last + 1 < lines.length) { last++; if (closing.test(lines[last]!.text)) break; }
      // Keep a complete bounded fence together; oversized fences use the same exact-byte fallback.
      if (start >= 0 && (lines[last]!.end - start > settings.maxBytes ||
          lines[last]!.number - startLine >= settings.maxLines)) flush();
      for (; i <= last; i++) append(lines[i]!);
      i--;
    } else append(line);
  }
  flush();
  return passages;
}

export async function prepareProjectRetrievalCorpus(root: string, input: unknown,
  context: ProjectRetrievalCallContext, chunks: Partial<ProjectRetrievalChunkSettings> = {}): Promise<PreparedProjectRetrievalCorpus> {
  try {
    assertRetrievalTime(context);
    const manifest = canonicalRetrievalManifest(input);
    const config = retrievalIndexConfig(chunks);
    const canonicalRoot = await realpath(root);
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error('invalid snapshot root');
    const passages: Readonly<ProjectRetrievalPassage>[] = [];
    for (const document of manifest.documents) {
      assertRetrievalTime(context);
      const bytes = await captureProjectDocument(canonicalRoot, document, context);
      passages.push(...chunkDocument(document, bytes, config.chunks));
      if (passages.length > PROJECT_RETRIEVAL_CORPUS_LIMITS.passages) throw new Error('too many passages');
    }
    assertRetrievalTime(context);
    return Object.freeze({ manifest, config, generation: retrievalGeneration(manifest, config),
      passages: Object.freeze(passages) });
  } catch {
    assertRetrievalTime(context);
    throw new Error('project document ingestion failed');
  }
}
