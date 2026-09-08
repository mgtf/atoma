import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { retrievalAnswerSchema, type RetrievalAnswer } from '../contracts/retrievalBenchmark.js';
import {
  questionFor, readRetrievalFile, RETRIEVAL_ANSWER_FILE, RETRIEVAL_INVENTORY_FILE,
  retrievalDocumentKey, retrievalInventory, retrievalSha256, snapshotFor, type RetrievalDataset,
} from './retrievalDataset.js';

export interface RetrievalCheck { readonly id: string; readonly ok: boolean }
export interface RetrievalScore {
  readonly questionId: string;
  readonly full: boolean;
  readonly checks: readonly RetrievalCheck[];
}

function result(questionId: string, checks: RetrievalCheck[]): RetrievalScore {
  return { questionId, full: checks.length > 0 && checks.every(c => c.ok), checks };
}

function citationRange(bytes: Buffer, startLine: number, endLine: number): [number, number] | null {
  if (endLine < startLine || endLine - startLine >= 16) return null;
  const starts = [0];
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 10) starts.push(i + 1);
  const start = starts[startLine - 1];
  if (start === undefined || endLine > starts.length) return null;
  return [start, starts[endLine] ?? bytes.length];
}

export function scoreRetrievalAnswer(
  dataset: RetrievalDataset, questionId: string, input: unknown
): RetrievalScore {
  const q = questionFor(dataset, questionId);
  const snapshot = snapshotFor(dataset, q.snapshotId);
  const parsed = retrievalAnswerSchema.safeParse(input);
  if (!parsed.success) return result(q.id, [{ id: 'answer-schema', ok: false }]);
  const a: RetrievalAnswer = parsed.data;
  const checks: RetrievalCheck[] = [
    { id: 'question-binding', ok: a.questionId === q.id },
    { id: 'snapshot-binding', ok: a.snapshotId === snapshot.id && a.snapshotSha256 === snapshot.sha256 },
    { id: 'answerability', ok: a.status === (q.answerable ? 'answered' : 'not_found') },
    { id: 'fact-set', ok: a.facts.length === q.expected.length &&
      new Set(a.facts.map(f => f.key)).size === a.facts.length &&
      a.facts.every(f => q.expected.some(e => e.key === f.key)) },
  ];
  for (const expected of q.expected) {
    const actual = a.facts.find(f => f.key === expected.key);
    checks.push({ id: `value:${expected.key}`, ok: actual?.value === expected.value });
    let supported = false;
    const valid = actual !== undefined && actual.citations.every(c => {
      const bytes = dataset.documents.get(retrievalDocumentKey(snapshot.id, c.path));
      if (!bytes || retrievalSha256(bytes) !== c.sha256) return false;
      const range = citationRange(bytes, c.startLine, c.endLine);
      if (!range || !Buffer.from(c.quote).equals(bytes.subarray(...range))) return false;
      if (expected.evidence.some(e => e.path === c.path && e.sha256 === c.sha256 &&
          range[0] <= e.startByte && range[1] >= e.endByte)) supported = true;
      return true;
    });
    checks.push({ id: `evidence:${expected.key}`, ok: valid && supported });
  }
  return result(q.id, checks);
}

/** Execute only the locked, evaluator-owned probe against copied JSON data. */
export function scoreRetrievalMaintenance(
  dataset: RetrievalDataset, questionId: string, workspace: string
): RetrievalCheck[] {
  const q = questionFor(dataset, questionId);
  const m = q.maintenance;
  if (!m) return [];
  const s = snapshotFor(dataset, q.snapshotId);
  let config: Buffer;
  let probe: Buffer;
  try {
    config = readRetrievalFile(workspace, m.configPath, 16_000);
    const value: unknown = JSON.parse(config.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid configuration');
    probe = readRetrievalFile(dataset.root, `${s.root}/${m.probePath}`);
    if (retrievalSha256(probe) !== s.assets.find(f => f.path === m.probePath)?.sha256) {
      throw new Error('probe changed');
    }
  } catch {
    return [{ id: 'maintenance-input', ok: false }];
  }
  const scratch = mkdtempSync(join(tmpdir(), 'atoma-retrieval-probe-'));
  try {
    writeFileSync(join(scratch, 'probe.mjs'), probe, { flag: 'wx' });
    writeFileSync(join(scratch, 'config.json'), config, { flag: 'wx' });
    const output = execFileSync(process.execPath, ['probe.mjs', 'config.json'], {
      cwd: scratch, encoding: 'utf8', timeout: 5000, maxBuffer: 64_000,
      // In particular, do not inherit NODE_OPTIONS or provider credentials.
      env: {}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const preview: unknown = JSON.parse(output);
    return [{ id: 'maintenance-behavior', ok: isDeepStrictEqual(preview, m.expectedPreview) }];
  } catch {
    return [{ id: 'maintenance-behavior', ok: false }];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function scoreRetrievalWorkspace(
  dataset: RetrievalDataset, questionId: string, workspace: string
): RetrievalScore {
  const q = questionFor(dataset, questionId);
  const s = snapshotFor(dataset, q.snapshotId);
  let answer: unknown;
  try {
    answer = JSON.parse(readRetrievalFile(workspace, RETRIEVAL_ANSWER_FILE, 128_000).toString('utf8'));
  } catch {
    answer = undefined;
  }
  const checks = [...scoreRetrievalAnswer(dataset, questionId, answer).checks];
  for (const file of [...s.documents, ...s.assets, {
    path: RETRIEVAL_INVENTORY_FILE, sha256: retrievalSha256(retrievalInventory(s)),
  }]) {
    if (file.path === q.maintenance?.configPath) continue;
    let preserved = false;
    try { preserved = retrievalSha256(readRetrievalFile(workspace, file.path)) === file.sha256; }
    catch { /* A missing, oversized or symlinked source is not preserved. */ }
    checks.push({ id: `preserved:${file.path}`, ok: preserved });
  }
  checks.push(...scoreRetrievalMaintenance(dataset, questionId, workspace));
  return result(questionId, checks);
}
