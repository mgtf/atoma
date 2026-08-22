import { randomUUID } from 'node:crypto';
import type { ToolExecutor } from './types.js';
import {
  parseBrowserObservation,
  type AttestationLog,
  type AttestationRecord,
} from '../contracts/attestation.js';

/**
 * THE ATTESTATION SEAM.
 * ====================
 * One append-only log per run, and one executor wrapper per branch. The
 * wrapper is where a tool result is OBSERVED — the only place in the process
 * that sees the raw value before anyone can paraphrase it.
 *
 * WHY here and not in the recorder: `src/viz/recordingLlm.ts` observes tool
 * calls through the `onToolInvocation` callback on an LLM request, so probes
 * the supervisor runs directly through `ctx.tools.execute` never reach it.
 * The executor is the wider seam, and it is the only one that covers both
 * callers.
 *
 * ONE SEAM, TWO CONSUMERS, TWO FAILURE POLICIES. The trace stays fail-open
 * observability: a recording failure is swallowed. The attestation is
 * correctness, so a failure here degrades the observation to UNATTESTED and
 * is logged — it never fails the tool call (a serialisation fault must not
 * kill a run) and it never silently looks like proof.
 */

class MemoryAttestationLog implements AttestationLog {
  private readonly records: AttestationRecord[] = [];

  append(record: AttestationRecord): void {
    this.records.push(record);
  }

  forBranch(branchId: string | undefined): readonly AttestationRecord[] {
    return this.records.filter((record) => record.branchId === branchId);
  }

  get size(): number {
    return this.records.length;
  }
}

export function createAttestationLog(): AttestationLog {
  return new MemoryAttestationLog();
}

/**
 * Tools whose result carries an observation worth attesting. Everything else
 * flows through untouched: a `write_file` is an action, not evidence, and
 * attesting it would inflate the log without making any claim checkable.
 */
const ATTESTABLE_TOOLS = new Set(['validate_html']);

/** Marker so nested forks re-wrap the BASE executor instead of stacking. */
const BASE = Symbol('atoma.attesting.base');

interface AttestingExecutor extends ToolExecutor {
  [BASE]: ToolExecutor;
}

/**
 * The executor a branch hands to its children. Returns `inner` unchanged
 * when there is nothing to attest into, so an un-instrumented context keeps
 * exactly today's behaviour.
 *
 * Nested forks matter: `forkBranch` runs on an already-forked context, so
 * wrapping a wrapper would append the same call twice under two branch ids.
 * `baseExecutorOf` unwraps first, which is why the marker exists.
 */
export function attestingExecutor(
  inner: ToolExecutor | undefined,
  log: AttestationLog | undefined,
  branchId: string | undefined,
  onError?: (message: string) => void
): ToolExecutor | undefined {
  if (!inner || !log) return inner;
  const base = baseExecutorOf(inner);
  const wrapper: AttestingExecutor = {
    [BASE]: base,
    has: (name: string) => base.has(name),
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      const result = await base.execute(name, args);
      if (!ATTESTABLE_TOOLS.has(name)) return result;
      try {
        const observation = parseBrowserObservation(args, result);
        if (observation) {
          log.append({
            eventId: randomUUID(),
            ...(branchId !== undefined ? { branchId } : {}),
            tool: name,
            observation,
          });
        }
      } catch (err) {
        // Correctness path: degrade to unattested, say so, never throw.
        onError?.(
          `attestation for ${name} failed; the observation is UNATTESTED: ${(err as Error).message}`
        );
      }
      return result;
    },
  };
  return wrapper;
}

/** The un-wrapped executor beneath any number of attesting wrappers. */
export function baseExecutorOf(executor: ToolExecutor): ToolExecutor {
  const candidate = (executor as Partial<AttestingExecutor>)[BASE];
  return candidate ? baseExecutorOf(candidate) : executor;
}
