import { z } from 'zod';

/**
 * TRAJECTORY SIGNATURES — what one Molecule execution DID, as the ordered names
 * of the elements it invoked, keyed on the Molecule and the skill it was handed.
 * ==============================================================================
 * The design record is `docs/trajectory-predictability-design-2026-09-09.md`.
 * The transposed idea: a system whose internal path is predictable from its
 * input generalises, and the error of a cheap predictor of that path is a
 * usable signal. Atoma trains no weights, so the signal cannot steer a run; it
 * can only weigh on decisions that already exist. Stage A (this module plus the
 * sentinel's `trajectory-drift` row) OBSERVES and journals; it decides nothing.
 *
 * WHY THE DERIVATION LIVES IN `src/contracts` rather than beside the rule: two
 * subsystems read it — the sentinel's rule table and the analyst's mechanical
 * digest — and neither may import the other. The same reasoning put
 * `traceFields.ts` here. Like that reader, this one parses NO model-authored
 * payload: it reads runtime-stamped identities only — element names, actor
 * names, skill ids, event ids, branch ids — and never `args`, `result`, or
 * prose. The event type below is structural so every `VizEvent` member
 * satisfies it without this module importing `src/viz`.
 *
 * ONE EXECUTION IS ONE `llmEventId`. `RecordingLlmClient` pre-allocates the id,
 * stamps it on every tool event the call makes, and records the `llm` event
 * itself only when the call RETURNS — so the trace's array order is causal and
 * an `llm` event with that id is the proof the execution is COMPLETE. A
 * signature without it is a prefix, and a prefix scored against whole paths is
 * exactly the false alarm the rule must not raise on a run in flight.
 *
 * CREDIT IS MECHANICAL. An execution is credited when, after it completes and
 * before the same Molecule starts another execution in the same lane, the
 * trace shows a `skill.success` for that Molecule (naming its skill, when it
 * had one) or a `trust` RESULT move for it. A remediation retry therefore
 * leaves its failed first attempt uncredited, which is what keeps it out of
 * the reference. Lanes are `branchId`s and they NEST: measured on the real
 * traces, a Cell injects, credits and trusts in its OWN lane and the Molecule
 * executes in a child lane the Cell opens (`branch` events carry the parent).
 * So an event agrees with an execution when their lanes are equal or one is an
 * ancestor of the other; a lane-less event agrees with any lane. Two attempts
 * in the SAME lane are a retry: the later start closes the earlier window, and
 * one credit credits the latest attempt and closes the older ones.
 *
 * THE KEY IS THE SKILL when one was injected (`skill.inject` or `skill.direct`
 * before the first tool call), the Molecule alone when none was. A key on the
 * Molecule alone is noisier — the design's open question 1 — and says so in
 * `keyedBy`.
 */

/** Below this many credited samples for a key, nothing is scored. */
export const TRAJECTORY_MIN_SAMPLES = 3;
/** Most recent credited signatures kept per key in a reference. */
export const TRAJECTORY_REFERENCE_MAX_PER_KEY = 24;
/** Most recent finished runs a reference is built from, per corpus. */
export const TRAJECTORY_REFERENCE_MAX_RUNS = 64;
/** Element names kept per signature; beyond it the signature is `truncated`. */
export const TRAJECTORY_MAX_TOOLS = 512;
/**
 * The provisional similarity floor below which the sentinel journals a row.
 * UNCALIBRATED, on purpose: the ten-trace pilot showed the quantity separates
 * runs the gates treat as equal, not where the line is. Stage A exists to
 * collect the rows that calibration needs; an operator moves the floor with
 * `ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE` or disarms it with `off`.
 */
export const TRAJECTORY_DRIFT_DEFAULT_MIN_SCORE = 0.5;
/** Bound on the collapsed sequence a journal row or digest line carries. */
export const TRAJECTORY_SEQUENCE_MAX_CHARS = 400;

export const trajectoryKeySchema = z
  .object({
    l1Name: z.string().min(1),
    skillId: z.string().min(1).nullable(),
    keyedBy: z.enum(['skill', 'atom']),
  })
  .strict();
export type TrajectoryKey = z.infer<typeof trajectoryKeySchema>;

export const trajectorySignatureSchema = z
  .object({
    runId: z.string().min(1),
    /** The `llmEventId` every tool event of this execution cites. */
    executionId: z.string().min(1),
    key: trajectoryKeySchema,
    tier: z.number().int().min(1).max(3).nullable(),
    branchId: z.string().min(1).nullable(),
    /** Index in the run's event array of the first tool event. */
    firstIndex: z.number().int().min(0),
    /** Index of the `llm` event that closed the execution, or null while in flight. */
    completedIndex: z.number().int().min(0).nullable(),
    tools: z.array(z.string().min(1)).max(TRAJECTORY_MAX_TOOLS),
    truncated: z.boolean(),
    completed: z.boolean(),
    credited: z.boolean(),
  })
  .strict();
export type TrajectorySignature = z.infer<typeof trajectorySignatureSchema>;

export const trajectoryScoreSchema = z
  .object({
    /** Nearest-neighbour similarity in [0, 1]: 1 is a path seen before, 0 shares nothing. */
    score: z.number().min(0).max(1),
    observedLen: z.number().int().min(0),
    /** Median length of the reference paths. */
    predictedLen: z.number().min(0),
    nearestLen: z.number().int().min(0),
    lengthRatio: z.number().min(0),
    sampleSize: z.number().int().min(0),
  })
  .strict();
export type TrajectoryScore = z.infer<typeof trajectoryScoreSchema>;

/** One string per key: the Molecule and the skill, `*` when keyed on the Molecule alone. */
export function trajectoryKeyId(key: TrajectoryKey): string {
  return `${key.l1Name}::${key.skillId ?? '*'}`;
}

/**
 * The fields this module reads from a trace event. Structural on purpose:
 * every `VizEvent` member is assignable to it, and nothing here ever touches
 * `args`, `result`, prompts or responses.
 */
export interface TrajectoryTraceEvent {
  readonly kind: string;
  readonly id: string;
  readonly llmEventId?: string;
  readonly name?: string;
  readonly actor?: { readonly name?: string; readonly tier?: number };
  readonly child?: { readonly name?: string; readonly tier?: number };
  readonly branchId?: string;
  /** On a `branch` event: the lane this one was opened from. */
  readonly parentBranchId?: string;
  readonly op?: string;
  readonly l1Name?: string;
  readonly skillId?: string;
  readonly subject?: string;
}

interface PendingSkill {
  readonly skillId: string;
  readonly branchId: string | null;
}

interface Execution {
  readonly executionId: string;
  readonly l1Name: string;
  readonly tier: number | null;
  readonly branchId: string | null;
  readonly firstIndex: number;
  skillId: string | null;
  completedIndex: number | null;
  tools: string[];
  truncated: boolean;
  credited: boolean;
}

function tierOf(actor: TrajectoryTraceEvent['actor']): number | null {
  const tier = actor?.tier;
  return typeof tier === 'number' && Number.isInteger(tier) && tier >= 1 && tier <= 3 ? tier : null;
}

/** Deeper than any real fan-out; bounds the ancestor walk against a cyclic map. */
const MAX_LANE_DEPTH = 64;
/** A lane-less event agrees with every lane, and is preferred to none. */
const LANELESS_DISTANCE = 1_000;

/**
 * Lane ancestry from `branch` events, and the one question asked of it: how
 * far apart are an event's lane and an execution's lane — 0 when equal, k when
 * one is the k-th ancestor of the other, `LANELESS_DISTANCE` when either has
 * no lane, and null when they are unrelated.
 */
class Lanes {
  private readonly parentOf = new Map<string, string | null>();

  opened(branchId: string, parentBranchId: string | null): void {
    if (!this.parentOf.has(branchId)) this.parentOf.set(branchId, parentBranchId);
  }

  private ancestorDistance(ancestor: string, node: string): number | null {
    let current: string | null | undefined = node;
    for (let depth = 0; depth < MAX_LANE_DEPTH && current != null; depth += 1) {
      if (current === ancestor) return depth;
      current = this.parentOf.get(current);
    }
    return null;
  }

  distance(left: string | null, right: string | null): number | null {
    if (left === null || right === null) return LANELESS_DISTANCE;
    if (left === right) return 0;
    return this.ancestorDistance(left, right) ?? this.ancestorDistance(right, left);
  }

  related(left: string | null, right: string | null): boolean {
    return this.distance(left, right) !== null;
  }
}

/**
 * Every execution in one run's event window, in the order they started.
 * Pure and total over the window: an event missing the fields it needs is
 * skipped, never guessed at. Works on a live window too — an execution the
 * `llm` event has not closed yet is returned with `completed: false`.
 */
export function deriveTrajectorySignatures(
  runId: string,
  events: readonly TrajectoryTraceEvent[]
): TrajectorySignature[] {
  const executions = new Map<string, Execution>();
  const order: Execution[] = [];
  const lanes = new Lanes();
  /** Skills injected for a Molecule and not yet consumed by an execution. */
  const pending = new Map<string, PendingSkill[]>();
  /** Closed executions per Molecule, oldest first, whose credit window is open. */
  const awaiting = new Map<string, Execution[]>();

  /** The nearest agreeing inject: its own lane first, then the closest ancestor, then a lane-less one. */
  const takePending = (l1Name: string, branchId: string | null): string | null => {
    const queue = pending.get(l1Name);
    if (!queue || queue.length === 0) return null;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    queue.forEach((entry, index) => {
      const distance = lanes.distance(entry.branchId, branchId);
      if (distance !== null && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) return null;
    const [entry] = queue.splice(bestIndex, 1);
    return entry?.skillId ?? null;
  };

  /** A new attempt in the same lane closes the window of the earlier ones, uncredited. */
  const closeWindows = (l1Name: string, branchId: string | null): void => {
    const queue = awaiting.get(l1Name);
    if (!queue || queue.length === 0) return;
    awaiting.set(
      l1Name,
      queue.filter((execution) => execution.branchId !== branchId)
    );
  };

  const credit = (l1Name: string, branchId: string | null, skillId: string | null): void => {
    const queue = awaiting.get(l1Name);
    if (!queue || queue.length === 0) return;
    // The most recent closed execution in a related lane. A skill success names
    // its skill and credits only an execution handed that skill — or one handed
    // none, which is the Molecule's own credit.
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const execution = queue[index]!;
      if (!lanes.related(branchId, execution.branchId)) continue;
      if (skillId !== null && execution.skillId !== null && execution.skillId !== skillId) continue;
      execution.credited = true;
      // The credit closes this window and every OLDER attempt in the same
      // lane: the supervisor moved on, and a second fact about the same
      // approval (trust RESULT beside skill success) must not credit a retry's
      // failed first attempt. Siblings in other lanes keep waiting for theirs.
      awaiting.set(
        l1Name,
        queue.filter(
          (other, otherIndex) => otherIndex > index || other.branchId !== execution.branchId
        )
      );
      return;
    }
  };

  events.forEach((event, index) => {
    switch (event.kind) {
      case 'branch': {
        if (event.op === 'start' && event.branchId) {
          lanes.opened(event.branchId, event.parentBranchId ?? null);
        }
        return;
      }
      case 'tool': {
        const l1Name = event.actor?.name;
        const executionId = event.llmEventId;
        const name = event.name;
        if (!l1Name || !executionId || !name) return;
        let execution = executions.get(executionId);
        if (!execution) {
          const branchId = event.branchId ?? null;
          closeWindows(l1Name, branchId);
          execution = {
            executionId,
            l1Name,
            tier: tierOf(event.actor),
            branchId,
            firstIndex: index,
            skillId: takePending(l1Name, branchId),
            completedIndex: null,
            tools: [],
            truncated: false,
            credited: false,
          };
          executions.set(executionId, execution);
          order.push(execution);
        }
        if (execution.tools.length < TRAJECTORY_MAX_TOOLS) execution.tools.push(name);
        else execution.truncated = true;
        return;
      }
      case 'llm': {
        // Recorded when the call returned, after every tool event it made. A
        // call that made no tool calls is not a trajectory and is ignored.
        const execution = executions.get(event.id);
        if (!execution || execution.completedIndex !== null) return;
        execution.completedIndex = index;
        const queue = awaiting.get(execution.l1Name) ?? [];
        queue.push(execution);
        awaiting.set(execution.l1Name, queue);
        return;
      }
      case 'skill': {
        const l1Name = event.l1Name;
        const skillId = event.skillId;
        if (!l1Name || !skillId) return;
        if (event.op === 'inject' || event.op === 'direct') {
          const queue = pending.get(l1Name) ?? [];
          queue.push({ skillId, branchId: event.branchId ?? null });
          pending.set(l1Name, queue);
        } else if (event.op === 'success') {
          credit(l1Name, event.branchId ?? null, skillId);
        }
        return;
      }
      case 'trust': {
        if (event.subject !== 'RESULT') return;
        const childName = event.child?.name;
        if (!childName) return;
        credit(childName, event.branchId ?? null, null);
        return;
      }
      default:
        return;
    }
  });

  return order.map((execution) => ({
    runId,
    executionId: execution.executionId,
    key: {
      l1Name: execution.l1Name,
      skillId: execution.skillId,
      keyedBy: execution.skillId === null ? 'atom' : 'skill',
    },
    tier: execution.tier,
    branchId: execution.branchId,
    firstIndex: execution.firstIndex,
    completedIndex: execution.completedIndex,
    tools: execution.tools,
    truncated: execution.truncated,
    completed: execution.completedIndex !== null,
    credited: execution.credited,
  }));
}

/** Edit distance over element NAMES, two rows, O(|a|·|b|) bounded by `TRAJECTORY_MAX_TOOLS`. */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_unused, column) => column);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + cost
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** 1 for the same path, 0 for paths sharing nothing; symmetric; length-normalised. */
export function trajectorySimilarity(a: readonly string[], b: readonly string[]): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * How predictable one observed path is against the credited paths of its key:
 * the similarity to its NEAREST neighbour, plus how its length sits against
 * the reference median. Deterministic and token-free.
 */
export function scoreTrajectory(
  observed: readonly string[],
  samples: readonly (readonly string[])[]
): TrajectoryScore {
  const observedLen = observed.length;
  if (samples.length === 0) {
    return { score: 0, observedLen, predictedLen: 0, nearestLen: 0, lengthRatio: observedLen, sampleSize: 0 };
  }
  let best = -1;
  let nearestLen = 0;
  for (const sample of samples) {
    const similarity = trajectorySimilarity(observed, sample);
    if (similarity > best) {
      best = similarity;
      nearestLen = sample.length;
    }
  }
  const lengths = samples.map((sample) => sample.length).sort((left, right) => left - right);
  const middle = lengths.length >> 1;
  const predictedLen =
    lengths.length % 2 === 1 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2;
  return {
    score: best,
    observedLen,
    predictedLen,
    nearestLen,
    lengthRatio: observedLen / Math.max(predictedLen, 1),
    sampleSize: samples.length,
  };
}

/**
 * A path as an operator reads it: consecutive repeats collapsed with a count,
 * `write_file×3 › start_node_server › fetch_url×4`, bounded for a journal row.
 * Element names are wire identities the runtime stamped, never model text.
 */
export function collapseTrajectory(
  tools: readonly string[],
  maxChars = TRAJECTORY_SEQUENCE_MAX_CHARS
): string {
  const runs: { name: string; count: number }[] = [];
  for (const name of tools) {
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.count += 1;
    else runs.push({ name, count: 1 });
  }
  const text = runs.map((run) => (run.count > 1 ? `${run.name}×${run.count}` : run.name)).join(' › ');
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Credited, completed signatures grouped by key — what a live execution is scored against. */
export interface TrajectoryReference {
  readonly byKey: ReadonlyMap<string, readonly TrajectorySignature[]>;
  /** Runs the reference was assembled from, readable or not they were counted by the caller. */
  readonly runs: number;
  /** Signatures kept after the per-key cap. */
  readonly signatures: number;
}

/**
 * Assemble a reference from per-run signature sets given OLDEST FIRST, so the
 * per-key cap keeps the most recent. Only completed AND credited signatures
 * enter: a prefix or an uncredited attempt is not a path worth predicting.
 */
export function assembleTrajectoryReference(
  sets: Iterable<readonly TrajectorySignature[]>,
  maxPerKey = TRAJECTORY_REFERENCE_MAX_PER_KEY
): TrajectoryReference {
  const byKey = new Map<string, TrajectorySignature[]>();
  let runs = 0;
  for (const set of sets) {
    runs += 1;
    for (const signature of set) {
      if (!signature.completed || !signature.credited) continue;
      const id = trajectoryKeyId(signature.key);
      const list = byKey.get(id) ?? [];
      list.push(signature);
      byKey.set(id, list);
    }
  }
  let signatures = 0;
  for (const [id, list] of byKey) {
    const kept = list.length > maxPerKey ? list.slice(-maxPerKey) : list;
    byKey.set(id, kept);
    signatures += kept.length;
  }
  return { byKey, runs, signatures };
}

export function buildTrajectoryReference(
  runs: Iterable<{ readonly runId: string; readonly events: readonly TrajectoryTraceEvent[] }>,
  maxPerKey = TRAJECTORY_REFERENCE_MAX_PER_KEY
): TrajectoryReference {
  return assembleTrajectoryReference(
    Array.from(runs, (run) => deriveTrajectorySignatures(run.runId, run.events)),
    maxPerKey
  );
}

export function referenceSamples(
  reference: TrajectoryReference,
  key: TrajectoryKey
): readonly TrajectorySignature[] {
  return reference.byKey.get(trajectoryKeyId(key)) ?? [];
}

/** Parsed at module load, so a schema/example mismatch fails the suite immediately. */
export const TRAJECTORY_SIGNATURE_EXAMPLE: TrajectorySignature = trajectorySignatureSchema.parse({
  runId: '2026-09-07T11-04-13-556-218b8e14',
  executionId: '4f1c1b8e-0d0a-4c2b-9a5e-1c0c6f4e2a11',
  key: { l1Name: 'Methane', skillId: 'node-http-static-json-api', keyedBy: 'skill' },
  tier: 1,
  branchId: null,
  firstIndex: 12,
  completedIndex: 26,
  tools: ['write_file', 'write_file', 'write_file', 'start_node_server', 'fetch_url', 'read_file'],
  truncated: false,
  completed: true,
  credited: true,
});
