/**
 * TYPED WITNESSES — machine-checkable evidence attached to a Result.
 * ==================================================================
 * The verification-first principle: a RESULT carrying witnesses is
 * structurally stronger than one carrying narrative. The witness source today
 * is the child's in-envelope probe record (`output.probes`). The on-disk
 * manifest is independent SUPERVISOR evidence and stays in GroundTruthFacts
 * rather than being speculatively modelled as a Result field nobody populates.
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

/**
 * A TRANSPORT-OBSERVED witness: a reference to one attestation record, not a
 * copy of it. The observation itself stays in the run-scoped attestation log
 * (`src/core/attestation.ts`), which is what keeps it out of the aggregation
 * losses — N>1 aggregation drops `toolCallResults` and flattens `evidence`,
 * and a reference survives both.
 *
 * The variant exists so a witness declares WHO OBSERVED IT. Before it, one
 * `source` covered a model-authored `output.probes` entry, and calling that
 * "evidence" made a declaration and an observation indistinguishable.
 */
export interface TransportWitness {
  readonly source: 'transport-observed';
  /** Attestation id in the run-scoped log. */
  readonly eventId: string;
  readonly tool: string;
  /** One-line rendering of what the transport saw. */
  readonly observed: string;
}

/**
 * A witness is evidence with a declared OBSERVER.
 *   - `recorded-probe`     — the child's own `output.probes` entry. A
 *                            declaration; honestly labelled, never promoted.
 *   - `transport-observed` — seen by the runtime at the tool seam.
 * Existing machine writers (`record_probe`, `fetch_url`) are NOT relabelled
 * here: their manifest entries are a different trust boundary with their own
 * readers, and one label spanning three ownerships would be false.
 */
export type Witness = ({ readonly source: 'recorded-probe' } & RecordedProbe) | TransportWitness;

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

/**
 * Typed witnesses back to the normalised probe view consumed by validators.
 * Transport-observed witnesses are deliberately NOT folded in here: they are
 * references, they carry no `cmd`, and the recorded-probe rendering exists to
 * cross-check a child's own claims against read-back files.
 */
export function recordedProbesFromWitnesses(
  witnesses: readonly Witness[] | undefined
): RecordedProbe[] {
  return (witnesses ?? [])
    .filter(
      (w): w is { readonly source: 'recorded-probe' } & RecordedProbe =>
        w.source === 'recorded-probe'
    )
    .map(({ source: _source, ...probe }) => probe)
    .slice(0, 12);
}

/** The transport-observed subset, in append order. */
export function transportWitnesses(
  witnesses: readonly Witness[] | undefined
): TransportWitness[] {
  return (witnesses ?? []).filter(
    (w): w is TransportWitness => w.source === 'transport-observed'
  );
}
