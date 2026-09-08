import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareProjectRetrievalCorpus, retrievalGeneration, retrievalPassageContext } from '../src/projects/retrievalCorpus.js';
import { documentManifest, retrievalContext } from './helpers/projectRetrievalCorpus.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-corpus-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('manifest-only deterministic ingestion', () => {
  it('preserves exact UTF-8/CRLF bytes, source line spans, and heading ancestry', async () => {
    const text = '# Décisions 🐝\r\n\r\n## Prix\r\nLe prix est 190 euros.\r\n\r\n## Support\r\nRéponse sous 24 heures.';
    const corpus = await prepareProjectRetrievalCorpus(root, documentManifest(root, { 'docs/prix.md': text }), retrievalContext());
    expect(corpus.passages.map(p => p.excerpt).join('')).toBe(text);
    expect(corpus.passages.at(-1)?.headingContext).toEqual(['Décisions 🐝', 'Support']);
    for (const p of corpus.passages) {
      const source = Buffer.from(text);
      expect(source.subarray(p.startByte, p.endByte).toString()).toBe(p.excerpt);
      expect(source.subarray(0, p.startByte).toString().split('\n').length).toBe(p.startLine);
      expect(text.split(/(?<=\n)/).slice(p.startLine - 1, p.endLine).join('')).toBe(p.excerpt);
      expect(retrievalPassageContext(corpus.manifest, p)).toContain(corpus.manifest.snapshotSha256);
      expect(p.excerpt).not.toContain(corpus.manifest.snapshotSha256);
    }
  });

  it('is independent of manifest ordering, freezes data, and versions source and chunk changes', async () => {
    const manifest = documentManifest(root, { 'b.md': 'Second source.\n', 'a.txt': 'First source.\n' });
    const first = await prepareProjectRetrievalCorpus(root, manifest, retrievalContext());
    const reversed = await prepareProjectRetrievalCorpus(root, { ...manifest, documents: [...manifest.documents].reverse() }, retrievalContext());
    expect(reversed).toEqual(first);
    expect(Object.isFrozen(first.passages[0]?.headingContext)).toBe(true);
    expect(Object.isFrozen(first.manifest.documents[0])).toBe(true);
    const rechunked = await prepareProjectRetrievalCorpus(root, manifest, retrievalContext(), { maxBytes: 128 });
    expect(rechunked.generation).not.toBe(first.generation);
    expect(retrievalGeneration({ ...first.manifest, snapshotId: 'snapshot-2' }, first.config)).not.toBe(first.generation);
    const changed = documentManifest(root, { 'a.txt': 'Changed source.\n' });
    expect((await prepareProjectRetrievalCorpus(root, changed, retrievalContext())).generation).not.toBe(first.generation);
  });

  it('keeps bounded fences intact and ignores apparent headings inside them', async () => {
    const text = '# Parent\n' + 'before\n'.repeat(12) + '```md\n# fake heading\ninside\n```\nAfter\n';
    const corpus = await prepareProjectRetrievalCorpus(root, documentManifest(root, { 'a.md': text }), retrievalContext());
    expect(corpus.passages.map(p => p.excerpt).join('')).toBe(text);
    expect(corpus.passages.some(p => p.excerpt.includes('```md\n# fake heading\ninside\n```\n'))).toBe(true);
    expect(corpus.passages.every(p => p.headingContext.join() === 'Parent')).toBe(true);
  });

  it('supports setext headings and treats plain-text hashes as source text', async () => {
    const corpus = await prepareProjectRetrievalCorpus(root, documentManifest(root, {
      'a.md': 'Parent\n======\nA\nChild\n-----\nB\n', 'b.txt': '# Literal\nA\n',
    }), retrievalContext());
    expect(corpus.passages.find(p => p.excerpt.includes('Child'))?.headingContext).toEqual(['Parent', 'Child']);
    expect(corpus.passages.find(p => p.path === 'b.txt')?.headingContext).toEqual([]);
  });

  it('bounds oversized lines/sections/fences without splitting UTF-8 or CRLF or losing bytes', async () => {
    const text = '# Long\r\n```\r\n' + 'é🐝'.repeat(800) + '\r\n' + 'line\r\n'.repeat(100) + '```\r\n';
    const corpus = await prepareProjectRetrievalCorpus(root, documentManifest(root, { 'a.md': text }), retrievalContext(), { maxBytes: 128, maxLines: 4 });
    expect(corpus.passages.map(p => p.excerpt).join('')).toBe(text);
    for (const p of corpus.passages) {
      expect(Buffer.byteLength(p.excerpt)).toBeLessThanOrEqual(128);
      expect(p.endLine - p.startLine + 1).toBeLessThanOrEqual(4);
      expect(p.excerpt).not.toContain('\uFFFD');
      expect(p.excerpt.endsWith('\r')).toBe(false);
    }
  });

  it('indexes nothing outside the manifest and accepts empty snapshots/documents', async () => {
    writeFileSync(join(root, 'private.md'), 'Never admitted');
    const manifest = documentManifest(root, { 'empty.md': '' });
    const corpus = await prepareProjectRetrievalCorpus(root, manifest, retrievalContext());
    expect(corpus.passages).toEqual([]);
    expect((await prepareProjectRetrievalCorpus(root, { ...manifest, documents: [] }, retrievalContext())).passages).toEqual([]);
  });

  it.each(['../escape.md', '/absolute.md', 'a/../escape.md', 'a\\escape.md', 'a//b.md', 'a.ts', '.env', 'a.md\0'])('refuses the path %s', async path => {
    const manifest = documentManifest(root, { 'a.md': 'source' });
    await expect(prepareProjectRetrievalCorpus(root, { ...manifest, documents: [{ ...manifest.documents[0], path }] }, retrievalContext())).rejects.toThrow('ingestion failed');
  });

  it.each([Buffer.from([0xc3, 0x28]), Buffer.from('a\0b')])('refuses binary/invalid UTF-8', async bytes => {
    await expect(prepareProjectRetrievalCorpus(root, documentManifest(root, { 'a.md': bytes }), retrievalContext())).rejects.toThrow('ingestion failed');
  });

  it('refuses executable files, digest drift, and duplicate admissions', async () => {
    const manifest = documentManifest(root, { 'a.md': 'source' });
    chmodSync(join(root, 'a.md'), 0o755);
    await expect(prepareProjectRetrievalCorpus(root, manifest, retrievalContext())).rejects.toThrow('ingestion failed');
    chmodSync(join(root, 'a.md'), 0o644);
    writeFileSync(join(root, 'a.md'), 'drifts');
    await expect(prepareProjectRetrievalCorpus(root, manifest, retrievalContext())).rejects.toThrow('ingestion failed');
    await expect(prepareProjectRetrievalCorpus(root, { ...manifest, documents: [...manifest.documents, ...manifest.documents] }, retrievalContext())).rejects.toThrow('ingestion failed');
  });

  it('refuses file and parent-directory symlinks, including targets inside the root', async () => {
    const manifest = documentManifest(root, { 'source/a.md': 'source' });
    symlinkSync(join(root, 'source/a.md'), join(root, 'link.md'));
    symlinkSync(join(root, 'source'), join(root, 'directory'));
    for (const path of ['link.md', 'directory/a.md']) {
      await expect(prepareProjectRetrievalCorpus(root, { ...manifest, documents: [{ ...manifest.documents[0], path }] }, retrievalContext())).rejects.toThrow('ingestion failed');
    }
    expect(readFileSync(join(root, 'source/a.md'), 'utf8')).toBe('source');
  });

  it('honors cancellation and expired deadlines', async () => {
    const manifest = documentManifest(root, { 'a.md': 'source' });
    await expect(prepareProjectRetrievalCorpus(root, manifest, retrievalContext(1000, AbortSignal.abort()))).rejects.toThrow('cancelled');
    await expect(prepareProjectRetrievalCorpus(root, manifest, retrievalContext(-1))).rejects.toThrow('deadline');
  });
});
