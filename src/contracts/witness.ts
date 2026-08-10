import type { ManifestEntry } from './probeManifest.js';

/**
 * TYPED WITNESSES — machine-checkable evidence attached to a Result.
 * ==================================================================
 * The verification-first principle: a RESULT carrying witnesses is
 * structurally stronger than one carrying narrative. Two witness sources
 * exist today — the child\'s in-envelope probe record (`output.probes`)
 * and the on-disk probe manifest — and both flow through the shapes
 * defined by the contracts layer, so validators and future projections
 * consume ONE type instead of re-parsing payloads.
 */

/**
 * One machine-verifiable probe record extracted from an L1 result payload
 * (the evidence contract\'s `output.probes` field or its historical
 * spellings). Shape-tolerant by design: children in the wild have emitted
 * `cmd`/`command`, `stdout`/`actual_stdout`, snake and camel case, so we
 * normalise rather than demand one spelling.
 */
export interface RecordedProbe {
  cmd: string;
  exitCode?: number;
  stdout?: string;
  expected?: string;
  actual?: string;
  match?: boolean;
  note?: string;
}

/** A witness is evidence with a declared source. */
export type Witness =
  | ({ readonly source: 'recorded-probe' } & RecordedProbe)
  | { readonly source: 'manifest'; readonly entry: ManifestEntry };

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Normalise the child\'s recorded probe list. Accepts `probes`,
 * `examples_verified` and `verifications` because children already emit those
 * spontaneously — formalising the field in the prompt should not invalidate
 * the shapes they were producing before it existed.
 */
export function extractRecordedProbes(payload: unknown): RecordedProbe[] {
  if (!payload || typeof payload !== 'object') return [];
  const output = (payload as Record<string, unknown>)['output'];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const o = output as Record<string, unknown>;
  const out: RecordedProbe[] = [];
  for (const key of ['probes', 'examples_verified', 'examplesVerified', 'verifications']) {
    const arr = o[key];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const e = raw as Record<string, unknown>;
      const cmd = pickString(e, ['cmd', 'command', 'invocation']);
      if (!cmd) continue;
      const exit = e['exitCode'] ?? e['exit_code'] ?? e['exit'];
      const probe: RecordedProbe = { cmd };
      if (typeof exit === 'number') probe.exitCode = exit;
      const stdout = pickString(e, ['stdout', 'actualStdout', 'actual_stdout', 'output']);
      if (stdout !== undefined) probe.stdout = stdout;
      const expected = pickString(e, ['expectedStdout', 'expected_stdout', 'expected']);
      if (expected !== undefined) probe.expected = expected;
      const actual = pickString(e, ['actualStdout', 'actual_stdout', 'actual']);
      if (actual !== undefined) probe.actual = actual;
      if (typeof e['match'] === 'boolean') probe.match = e['match'];
      const note = pickString(e, ['note', 'case', 'description']);
      if (note !== undefined) probe.note = note;
      out.push(probe);
    }
  }
  return out.slice(0, 12);
}

/** Witness view of a result payload — the typed form of the evidence. */
export function witnessesFromPayload(payload: unknown): Witness[] {
  return extractRecordedProbes(payload).map((p) => ({ source: 'recorded-probe' as const, ...p }));
}
