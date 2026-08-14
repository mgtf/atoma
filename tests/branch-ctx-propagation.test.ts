import { describe, it, expect } from 'vitest';
import { forkBranch } from '../src/core/branchCtx.js';
import { makeCtx } from './helpers.js';

/**
 * forkBranch rebuilds RunContext by field enumeration, so an optional field
 * it forgets is silently absent on every forked context — and production
 * reads the run-integrity flag and the run-scoped memos exclusively through
 * forks (L3.runSubtask forks the root, L2.runSubtask forks again). The
 * fabricated-work gate shipped inert this way: the runner set
 * `requireObservedToolAction` on the root only, tests constructed their ctx
 * by hand without forking, and the double fork dropped the flag on every
 * real run. These tests exercise the FORK, not a hand-built ctx.
 */
describe('forkBranch — field propagation', () => {
  it('propagates requireObservedToolAction through a double fork', () => {
    const root = { ...makeCtx(), requireObservedToolAction: true };
    const level1 = forkBranch(root, 'branch-1');
    const level2 = forkBranch(level1, 'branch-2');
    expect(level1.requireObservedToolAction).toBe(true);
    expect(level2.requireObservedToolAction).toBe(true);
  });

  it('leaves requireObservedToolAction absent when the root never set it', () => {
    const fork = forkBranch(makeCtx(), 'branch-1');
    expect(fork.requireObservedToolAction).toBeUndefined();
  });

  it('shares ONE dispatchedScriptSignatures map across root and sibling forks', () => {
    // The anti-redispatch memo is documented run-scoped: a content-rejected
    // deterministic output must not be re-dispatched identically by a LATER
    // phase. Two sequential L3 phases get two sibling forks, so the memo
    // only works if every fork holds the same reference as the root.
    const root = makeCtx();
    const phase1 = forkBranch(root, 'phase-1');
    const phase2 = forkBranch(root, 'phase-2');
    (phase1.dispatchedScriptSignatures ??= new Map()).set('skill-a', ['summary bytes']);
    expect(root.dispatchedScriptSignatures?.get('skill-a')).toEqual(['summary bytes']);
    expect(phase2.dispatchedScriptSignatures?.get('skill-a')).toEqual(['summary bytes']);
  });

  it('shares ONE mechanicalPlanRejections set across nested forks', () => {
    const root = makeCtx();
    const outer = forkBranch(root, 'outer');
    const inner = forkBranch(outer, 'inner');
    (inner.mechanicalPlanRejections ??= new Set()).add('subtask|tool');
    expect(outer.mechanicalPlanRejections?.has('subtask|tool')).toBe(true);
    expect(root.mechanicalPlanRejections?.has('subtask|tool')).toBe(true);
  });

  it('forwards run-stat signals through a double fork', () => {
    const seen: string[] = [];
    const root = { ...makeCtx(), recordRunStat: (signal: string) => seen.push(signal) };
    forkBranch(forkBranch(root, 'outer'), 'inner').recordRunStat?.('escalation');
    expect(seen).toEqual(['escalation']);
  });
});
