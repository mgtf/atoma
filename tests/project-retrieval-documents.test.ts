import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchesProjectRetrievalFilters, projectRetrievalCitation, projectRetrievalPassageSchema } from '../src/contracts/projectRetrieval.js';
import { prepareProjectRetrievalCorpus, projectRetrievalHash } from '../src/projects/retrievalCorpus.js';
import { documentManifest, retrievalContext } from './helpers/projectRetrievalCorpus.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-documents-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function fixture(format: string): Buffer {
  return readFileSync(new URL(`./fixtures/retrieval-documents/pricing.${format}`, import.meta.url));
}
let libreOffice = false;
try { execFileSync('soffice', ['--headless', '--version'], { timeout: 5000, stdio: 'ignore' }); libreOffice = true; } catch { /* Optional legacy converter. */ }
if (process.env['CI'] === 'true' && !libreOffice) throw new Error('CI requires LibreOffice for legacy document tests');

async function checkFormat(format: string) {
  const bytes = fixture(format);
  const corpus = await prepareProjectRetrievalCorpus(root,
    documentManifest(root, { [`pricing.${format.toUpperCase()}`]: bytes }), retrievalContext());
  const text = corpus.passages.map(p => p.excerpt).join('');
  expect(text).toContain('190');
  expect(text).toContain('euros');
  expect(corpus.config.extractionVersion).toBe('officeparser-7.8.0-v1');
  for (const p of corpus.passages) {
    expect(p.sha256).toBe(projectRetrievalHash(bytes));
    expect(p.extraction).toEqual({ kind: 'extracted-text', version: 'officeparser-7.8.0-v1',
      sha256: projectRetrievalHash(text), bytes: Buffer.byteLength(text) });
    expect(Buffer.from(text).subarray(p.startByte, p.endByte).toString()).toBe(p.excerpt);
    expect(projectRetrievalCitation(p).extraction).toEqual(p.extraction);
    expect(projectRetrievalPassageSchema.safeParse({ ...p, extraction: undefined }).success).toBe(false);
  }
  if (format === 'xlsx' || format === 'ods' || format === 'xls') expect(text).toContain('Support');
}

describe('real document ingestion through the bounded subprocess', () => {
  it.each(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'])('extracts %s with honest citations', checkFormat, 30_000);
  it.skipIf(!libreOffice).each(['doc', 'xls', 'ppt'])('converts legacy %s in a private profile', checkFormat, 60_000);
  it('keeps CSV bytes intact and filters document formats case-insensitively', async () => {
    const text = 'Item,Price\r\nAnnual,190\r\n';
    const corpus = await prepareProjectRetrievalCorpus(root, documentManifest(root, { 'pricing.CSV': text }), retrievalContext());
    expect(corpus.passages.map(p => p.excerpt).join('')).toBe(text);
    expect(corpus.passages[0]?.extraction).toBeUndefined();
    expect(matchesProjectRetrievalFilters('pricing.PDF', { formats: ['pdf'] })).toBe(true);
    expect(matchesProjectRetrievalFilters('pricing.xlsx', { formats: ['xls'] })).toBe(false);
  });
  it.each(['pdf', 'docx', 'xlsx', 'pptx'])('refuses corrupt %s rather than silently indexing no text', async format => {
    await expect(prepareProjectRetrievalCorpus(root, documentManifest(root, { [`bad.${format}`]: Buffer.from('not a document') }),
      retrievalContext())).rejects.toThrow('ingestion failed');
  });
  it('interrupts an active extraction at its deadline', async () => {
    await expect(prepareProjectRetrievalCorpus(root, documentManifest(root, { 'pricing.docx': fixture('docx') }),
      retrievalContext(10))).rejects.toThrow('deadline');
  });
});
