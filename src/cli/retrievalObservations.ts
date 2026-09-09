import { projectRetrievalResponseSchema, PROJECT_RETRIEVAL_TOOL_NAME } from '../contracts/projectRetrieval.js';
import type { RetrievalQuestion } from '../contracts/retrievalBenchmark.js';
import { readRetrievalFile, retrievalDocumentKey, type RetrievalDataset } from './retrievalDataset.js';
import { dirname, basename } from 'node:path';
import { MAX_TRACE_BYTES } from '../contracts/traceFields.js';

/** Read host trace evidence after teardown, never accept candidate-authored retrieval telemetry. */
export function retrievalObservations(path: string, dataset: RetrievalDataset, question: RetrievalQuestion) {
  try {
    const trace = JSON.parse(readRetrievalFile(dirname(path), basename(path), MAX_TRACE_BYTES).toString('utf8')) as { events?: unknown[] };
    if (!Array.isArray(trace.events)) return null;
    let calls = 0, failures = 0, invalidSourcePassages = 0, durationMs = 0, emptyResults = 0;
    const spans: { path: string; sha256: string; startByte: number; endByte: number }[] = [];
    for (const raw of trace.events) {
      if (!raw || typeof raw !== 'object' || !('kind' in raw) || raw.kind !== 'tool' || !('name' in raw) || raw.name !== PROJECT_RETRIEVAL_TOOL_NAME) continue;
      calls++;
      if ('durationMs' in raw && typeof raw.durationMs === 'number') durationMs += raw.durationMs;
      const result = projectRetrievalResponseSchema.safeParse('result' in raw ? raw.result : undefined);
      if (!result.success || !result.data.ok) { failures++; continue; }
      if (!result.data.passages.length) emptyResults++;
      for (const passage of result.data.passages) {
        const bytes = dataset.documents.get(retrievalDocumentKey(question.snapshotId, passage.path));
        const source = dataset.corpus.snapshots.find(s => s.id === question.snapshotId)?.documents.find(d => d.path === passage.path);
        if (!bytes || source?.sha256 !== passage.sha256 ||
          !bytes.subarray(passage.startByte, passage.endByte).equals(Buffer.from(passage.excerpt))) { invalidSourcePassages++; continue; }
        spans.push(passage);
      }
    }
    const facts = question.expected.map(fact => ({ key: fact.key, covered: fact.evidence.some(evidence => {
      let end = evidence.startByte;
      for (const span of spans.filter(s => s.path === evidence.path && s.sha256 === evidence.sha256).sort((a, b) => a.startByte - b.startByte)) {
        if (span.startByte <= end) end = Math.max(end, span.endByte);
      }
      return end >= evidence.endByte;
    }) }));
    return { calls, failures, emptyResults, invalidSourcePassages, returnedPassages: spans.length, durationMs,
      facts, expectedFacts: facts.length, coveredFacts: facts.filter(f => f.covered).length,
      // Absence in returned hits cannot distinguish lexical mismatch from ranking without another experiment.
      coverageDisposition: calls === 0 ? 'not-invoked' : invalidSourcePassages ? 'invalid-source' :
        failures === calls ? 'no-successful-query' : !facts.length ? 'abstention-task' :
          facts.every(f => f.covered) ? 'evidence-covered' : 'evidence-not-covered' };
  } catch { return null; }
}
