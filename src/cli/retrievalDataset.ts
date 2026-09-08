import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  retrievalCorpusSchema, retrievalInstrumentLockSchema, retrievalQuestionsSchema,
  type RetrievalCorpus, type RetrievalQuestion, type RetrievalSnapshot,
} from '../contracts/retrievalBenchmark.js';

export function retrievalSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** No model-controlled path is allowed to escape its fixture or output root. */
export function readRetrievalFile(root: string, path: string, maxBytes = 256_000): Buffer {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid relative file path');
  }
  const base = realpathSync(root);
  let full = base;
  for (const part of path.split('/')) {
    full = resolve(full, part);
    if (lstatSync(full).isSymbolicLink()) throw new Error('symlink input refused');
  }
  const resolved = realpathSync(full);
  const rel = relative(base, resolved);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('file escapes root');
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid or oversized file');
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) throw new Error('oversized file');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export interface RetrievalDataset {
  readonly root: string;
  readonly corpus: RetrievalCorpus;
  readonly questions: readonly RetrievalQuestion[];
  /** Validated original bytes. Scoring never trusts a candidate's copied docs. */
  readonly documents: ReadonlyMap<string, Buffer>;
}

export function retrievalDocumentKey(snapshotId: string, path: string): string {
  return `${snapshotId}/${path}`;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}

export function snapshotFor(dataset: RetrievalDataset, id: string): RetrievalSnapshot {
  const snapshot = dataset.corpus.snapshots.find(s => s.id === id);
  if (!snapshot) throw new Error('unknown corpus snapshot');
  return snapshot;
}

export function questionFor(dataset: RetrievalDataset, id: string): RetrievalQuestion {
  const question = dataset.questions.find(q => q.id === id);
  if (!question) throw new Error('unknown retrieval question');
  return question;
}

/** Validate locked inputs before any candidate is scored or workspace prepared. */
export function loadRetrievalDataset(root: string): RetrievalDataset {
  const lock = retrievalInstrumentLockSchema.parse(JSON.parse(
    readRetrievalFile(root, 'instruments.lock.json').toString('utf8')
  ));
  const corpusBytes = readRetrievalFile(root, 'corpus.json', 2_000_000);
  const questionBytes = readRetrievalFile(root, 'questions.json', 2_000_000);
  if (retrievalSha256(corpusBytes) !== lock.corpusSha256 ||
      retrievalSha256(questionBytes) !== lock.questionsSha256) {
    throw new Error('retrieval instrument lock mismatch; register changed instruments explicitly');
  }
  const corpus = retrievalCorpusSchema.parse(JSON.parse(corpusBytes.toString('utf8')));
  const { questions } = retrievalQuestionsSchema.parse(JSON.parse(questionBytes.toString('utf8')));
  assertUnique(corpus.snapshots.map(s => s.id), 'snapshot ID');
  assertUnique(corpus.snapshots.map(s => `${s.orgId}/${s.projectId}/${s.id}`), 'snapshot binding');
  assertUnique(corpus.snapshots.map(s => s.root), 'snapshot root');
  assertUnique(questions.map(q => q.id), 'question ID');
  const documents = new Map<string, Buffer>();
  const dataset: RetrievalDataset = { root: resolve(root), corpus, questions, documents };
  for (const snapshot of corpus.snapshots) {
    const files = [...snapshot.documents, ...snapshot.assets];
    assertUnique(files.map(f => f.path), 'snapshot file');
    if (files.some(f => f.path === RETRIEVAL_ANSWER_FILE || f.path === RETRIEVAL_INVENTORY_FILE)) {
      throw new Error('snapshot file collides with benchmark output or inventory');
    }
    if (files.reduce((sum, f) => sum + f.bytes, 0) > 8_000_000) {
      throw new Error('snapshot exceeds corpus byte limit');
    }
    const digest = retrievalSha256(JSON.stringify([
      snapshot.id, snapshot.orgId, snapshot.projectId, snapshot.documents, snapshot.assets,
    ]));
    if (snapshot.sha256 !== digest) throw new Error('snapshot digest mismatch');
    for (const file of files) {
      const bytes = readRetrievalFile(root, `${snapshot.root}/${file.path}`);
      if (file.sha256 !== retrievalSha256(bytes) || file.bytes !== bytes.length) {
        throw new Error(`fixture digest mismatch: ${snapshot.id}/${file.path}`);
      }
      if (snapshot.documents.includes(file)) {
        if (!/\.(md|txt)$/.test(file.path) ||
            !Buffer.from(bytes.toString('utf8')).equals(bytes) || bytes.includes(0)) {
          throw new Error('document must be UTF-8 Markdown or plain text');
        }
        documents.set(retrievalDocumentKey(snapshot.id, file.path), bytes);
      }
    }
  }
  for (const q of questions) {
    const snapshot = snapshotFor(dataset, q.snapshotId);
    if (snapshot.split === 'isolation') throw new Error('isolation fixtures cannot supply evaluation answers');
    for (const fact of q.expected) {
      for (const span of fact.evidence) {
        const bytes = documents.get(retrievalDocumentKey(snapshot.id, span.path));
        if (!bytes || retrievalSha256(bytes) !== span.sha256 || span.endByte > bytes.length ||
            !Buffer.from(bytes.subarray(span.startByte, span.endByte).toString('utf8'))
              .equals(bytes.subarray(span.startByte, span.endByte))) {
          throw new Error(`invalid golden evidence: ${q.id}/${fact.key}`);
        }
      }
    }
    if (q.maintenance) {
      const m = q.maintenance;
      if (!snapshot.assets.some(f => f.path === m.configPath && f.path.endsWith('.json')) ||
          !snapshot.assets.some(f => f.path === m.probePath && f.path.endsWith('.mjs'))) {
        throw new Error('maintenance files must be registered snapshot assets');
      }
      if (retrievalSha256(readRetrievalFile(root, m.referencePath)) !== m.referenceSha256) {
        throw new Error('maintenance reference digest mismatch');
      }
    }
  }
  return dataset;
}

export const RETRIEVAL_ANSWER_FILE = 'retrieval-answer.json';
export const RETRIEVAL_INVENTORY_FILE = 'CORPUS.json';

export function retrievalInventory(snapshot: RetrievalSnapshot): string {
  return JSON.stringify({
    snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, documents: snapshot.documents,
  }, null, 2) + '\n';
}

export function retrievalGoal(dataset: RetrievalDataset, q: RetrievalQuestion): string {
  const snapshot = snapshotFor(dataset, q.snapshotId);
  return [
    q.prompt,
    'Use only the supplied project documents. CORPUS.json lists their identities and SHA-256 digests.',
    `Write ${RETRIEVAL_ANSWER_FILE} as one JSON object with exactly these fields:`,
    `questionId: ${JSON.stringify(q.id)}, snapshotId: ${JSON.stringify(snapshot.id)},`,
    `snapshotSha256: ${JSON.stringify(snapshot.sha256)}, status: "answered" or "not_found", facts: [].`,
    `Requested facts and JSON value types: ${JSON.stringify(q.requestedFacts)}.`,
    'Each fact has key, value (a concise JSON scalar), and citations (a nonempty array).',
    'Each citation has path (relative document path), sha256, startLine, endLine, and quote.',
    'Line numbers are 1-based and inclusive. Quote every byte of those lines, including their final newline when present.',
    'Cite at most 16 lines per citation. Cite original evidence for every fact; never cite CORPUS.json or executable assets.',
    'Use each declared JSON value type. For categorical text use the English term as documented; preserve identifiers and capitalization.',
    'If the requested information is absent, use status "not_found" and facts []. Do not invent evidence.',
    q.maintenance ? 'Make the requested configuration edit as well as writing the answer file.' :
      'Leave supplied files unchanged; only create the answer file.',
  ].join('\n');
}

/** Copy only the selected snapshot, never question gold, scorers, or other tenants. */
export function prepareRetrievalWorkspace(
  dataset: RetrievalDataset, questionId: string, out: string
): { workspace: string; goal: string } {
  const q = questionFor(dataset, questionId);
  const s = snapshotFor(dataset, q.snapshotId);
  const workspace = resolve(out);
  // mkdir without recursive/exist_ok reserves a NEW directory and refuses overwrite.
  mkdirSync(workspace);
  for (const file of [...s.documents, ...s.assets]) {
    const bytes = readRetrievalFile(dataset.root, `${s.root}/${file.path}`);
    if (retrievalSha256(bytes) !== file.sha256) throw new Error('fixture changed during prepare');
    const destination = resolve(workspace, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
  }
  writeFileSync(resolve(workspace, RETRIEVAL_INVENTORY_FILE), retrievalInventory(s), { flag: 'wx' });
  return { workspace, goal: retrievalGoal(dataset, q) };
}
