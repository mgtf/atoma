import { describe, it, expect } from 'vitest';
import {
  detectSmokeStatementError,
  detectResetErasedIntermediateEvidence,
  isSmokeOk,
  makeSmokeStuckTracker,
  SMOKE_STUCK_WINDOW,
  SMOKE_STUCK_THRESHOLD,
  uniqueNormalizedIdSelector,
} from '../src/tools/builtin.js';

/**
 * Regression tests for the validate_html smoke pre-flight checks. These
 * exist to catch the two failure modes observed in production:
 *
 *  1. "Unexpected token 'const'" — the model writes `const x = …; x > 0`
 *     as the smoke, which fails to parse inside `(${smoke})` because
 *     it's a statement, not an expression. Three Puppeteer rounds were
 *     wasted per run on this class of error before the pre-flight was
 *     added.
 *
 *  2. "same-smoke-stuck" — the model retries the identical assertion
 *     (e.g. `window.__gameState.statusText.includes('Checkmate')`)
 *     15+ times, each round paying a full Puppeteer round-trip while
 *     producing no new information. The stuck detector short-circuits
 *     with a coaching error once the failure window is full.
 */

describe('detectSmokeStatementError', () => {
  it('accepts a plain expression (null return)', () => {
    expect(detectSmokeStatementError('x > 0')).toBeNull();
    expect(detectSmokeStatementError('document.querySelector(".foo")')).toBeNull();
    expect(detectSmokeStatementError('window.__x && window.__x.value > 0')).toBeNull();
  });

  it('accepts an IIFE (arrow and function forms)', () => {
    expect(detectSmokeStatementError('(() => { const x = 1; return x > 0 })()')).toBeNull();
    expect(
      detectSmokeStatementError('(function(){ const x = compute(); return x > 0 })()')
    ).toBeNull();
    // Trailing semicolon on an IIFE is fine — the `;` is AFTER the expression.
    expect(detectSmokeStatementError('(() => true)();')).toBeNull();
  });

  it('rejects top-level const / let / var — the most common model mistake', () => {
    expect(detectSmokeStatementError('const x = 1; x > 0')).toMatch(/top-level `const`/);
    expect(detectSmokeStatementError('let y = 2; y > 1')).toMatch(/top-level `let`/);
    expect(detectSmokeStatementError('var z = 3; z > 2')).toMatch(/top-level `var`/);
  });

  it('rejects top-level return / if / for / while / function / throw', () => {
    expect(detectSmokeStatementError('return true')).toMatch(/top-level `return`/);
    expect(detectSmokeStatementError('if (x) { return true }')).toMatch(/top-level `if`/);
    expect(detectSmokeStatementError('for (let i=0;i<10;i++){}')).toMatch(/top-level `for`/);
    expect(detectSmokeStatementError('while (true) {}')).toMatch(/top-level `while`/);
    expect(detectSmokeStatementError('function f() {}')).toMatch(/top-level `function/);
    expect(detectSmokeStatementError('throw new Error("x")')).toMatch(/top-level `throw`/);
  });

  it('rejects multi-statement expressions separated by top-level `;`', () => {
    // This is the case where the body uses a series of statements
    // without wrapping in an IIFE — the `;` at depth 0 gives it away.
    expect(detectSmokeStatementError('let x = 1; x + 1')).toMatch(/top-level|top-level `let`/);
    // A semicolon inside a nested IIFE body is fine (depth > 0).
    expect(
      detectSmokeStatementError('(() => { const a = 1; const b = 2; return a + b })()')
    ).toBeNull();
  });

  it('ignores `;` inside strings and template literals', () => {
    expect(detectSmokeStatementError('"a;b" === "a;b"')).toBeNull();
    expect(detectSmokeStatementError("'x;y'.split(';').length === 2")).toBeNull();
    expect(detectSmokeStatementError('`one;two`.includes(";")')).toBeNull();
  });

  it('empty or whitespace-only smoke returns null (execute path treats it as absent)', () => {
    expect(detectSmokeStatementError('')).toBeNull();
    expect(detectSmokeStatementError('    ')).toBeNull();
  });
});

describe('isSmokeOk — structured assertions are not truthy by accident', () => {
  it('requires explicit ok when diagnostic booleans include a failure', () => {
    expect(isSmokeOk({ hasStreak3Class: false, hasStreak0Class: true })).toBe(false);
    expect(isSmokeOk({ milestone: { classMatches: false }, reset: { classMatches: true } })).toBe(
      false
    );
  });

  it('does not let ok:true override a nested false assertion', () => {
    expect(isSmokeOk({ ok: true, reset: { hasStreak3Class: false } })).toBe(false);
    expect(
      isSmokeOk({
        ok: true,
        reset: { className: 'streak-0', excludesMilestoneClass: true },
      })
    ).toBe(true);
    expect(isSmokeOk({ ok: false, values: { rendered: true } })).toBe(false);
    expect(isSmokeOk({ streak: 3, className: 'streak-3' })).toBe(false);
  });
});

describe('uniqueNormalizedIdSelector', () => {
  it('repairs only one unambiguous id spelling variant', () => {
    expect(uniqueNormalizedIdSelector('#increment-btn', ['incrementBtn', 'resetBtn'])).toBe(
      '#incrementBtn'
    );
    expect(uniqueNormalizedIdSelector('#reset_btn', ['incrementBtn', 'resetBtn'])).toBe(
      '#resetBtn'
    );
    expect(uniqueNormalizedIdSelector('.increment-btn', ['incrementBtn'])).toBeNull();
    expect(uniqueNormalizedIdSelector('#a-b', ['ab', 'a_b'])).toBeNull();
  });
});

describe('detectResetErasedIntermediateEvidence', () => {
  const sequence = [
    { type: 'click' as const, selector: '#incrementBtn' },
    { type: 'click' as const, selector: '#incrementBtn' },
    { type: 'click' as const, selector: '#incrementBtn' },
    { type: 'click' as const, selector: '#resetBtn' },
  ];

  it('rejects final-state-only smoke after repeated changes and reset', () => {
    expect(
      detectResetErasedIntermediateEvidence(
        sequence,
        '({ ok: widget.streak === 0, streak: widget.streak })'
      )
    ).toMatch(/intermediate state has been erased/);
  });

  it('accepts an IIFE that drives and snapshots milestone before reset', () => {
    expect(
      detectResetErasedIntermediateEvidence(
        sequence,
        '(() => { widget.increment(); const milestone = widget.streak; widget.reset(); return { ok: milestone === 1 && widget.streak === 0, milestone }; })()'
      )
    ).toBeNull();
  });
});

describe('makeSmokeStuckTracker', () => {
  it('exposes a cumulative-failures-in-window semantics, not "N in a row"', () => {
    // Regression from post-mortem: with "N consecutive identical
    // failures" the model learned to interleave a sanity smoke between
    // retries of the real (failing) assertion, defeating the detector.
    // The cumulative counter is immune to that: N failures of the same
    // smoke within the last WINDOW entries trips the guard regardless
    // of what else is recorded between them.
    const t = makeSmokeStuckTracker();
    const real = 'window.__gameState.statusText.includes("Checkmate")';
    const sanity = 'document.getElementById("chessboard") !== null';
    t.record(real, false);
    t.record(sanity, true);
    expect(t.isStuck(real)).toBe(false);
    t.record(real, false);
    t.record(sanity, true);
    expect(t.isStuck(real)).toBe(false);
    t.record(real, false); // 3rd cumulative failure of `real`
    expect(t.isStuck(real)).toBe(true);
    // The sanity smoke, even though it passed, is NOT stuck (never
    // accumulated failures).
    expect(t.isStuck(sanity)).toBe(false);
  });

  it('does NOT fire until the failureThreshold is reached', () => {
    const t = makeSmokeStuckTracker();
    const smoke = 'x > 0';
    for (let i = 0; i < SMOKE_STUCK_THRESHOLD - 1; i++) {
      t.record(smoke, false);
      expect(t.isStuck(smoke)).toBe(false);
    }
    // The threshold-th failure is the one that trips the guard.
    t.record(smoke, false);
    expect(t.isStuck(smoke)).toBe(true);
  });

  it('applies the threshold per-smoke (unrelated smokes do not share counters)', () => {
    const t = makeSmokeStuckTracker();
    const smokeA = 'x > 0';
    const smokeB = 'y > 0';
    // Accumulate threshold failures on smokeA.
    for (let i = 0; i < SMOKE_STUCK_THRESHOLD; i++) t.record(smokeA, false);
    expect(t.isStuck(smokeA)).toBe(true);
    // smokeB has no recorded failures — even with shared history it is
    // not stuck.
    expect(t.isStuck(smokeB)).toBe(false);
  });

  it('a later success on the SAME smoke does NOT retroactively clear prior failures inside the window', () => {
    // A single success buried among failures should not rescue the
    // count — the concern is "this assertion keeps failing", and a
    // single passing execution (maybe a lucky state) does not make the
    // underlying flakiness go away.
    const t = makeSmokeStuckTracker();
    const smoke = 'x > 0';
    for (let i = 0; i < SMOKE_STUCK_THRESHOLD; i++) t.record(smoke, false);
    expect(t.isStuck(smoke)).toBe(true);
    t.record(smoke, true); // one success — does not clear the count
    expect(t.isStuck(smoke)).toBe(true);
  });

  it('clears the stuck flag only once the failing entries roll OFF the window', () => {
    const t = makeSmokeStuckTracker({ windowSize: 5, failureThreshold: 3 });
    const smoke = 'x > 0';
    for (let i = 0; i < 3; i++) t.record(smoke, false);
    expect(t.isStuck(smoke)).toBe(true);
    // Push 5 passes of OTHER smokes — the 3 failing entries roll out
    // of the 5-slot window one by one.
    t.record('other', true);
    t.record('other', true);
    t.record('other', true);
    // Only 2 of the original failures remain in-window now (capacity=5,
    // history=[fail,fail,fail,true,true,true] → keep last 5 → [fail,
    // fail,true,true,true] → 2 failures, still < 3 threshold).
    expect(t.isStuck(smoke)).toBe(false);
  });

  it('treats whitespace-only differences as the same assertion (key normalisation)', () => {
    const t = makeSmokeStuckTracker();
    // All three normalise to `x > 0` under the `\s+ → " "` + trim rule.
    t.record('x > 0', false);
    t.record('   x > 0   ', false);
    t.record('x     >     0', false);
    expect(t.isStuck('   x > 0')).toBe(true);
  });

  it('accepts the legacy single-number signature (windowSize only, threshold defaults)', () => {
    // Legacy callers that passed a raw number for window size keep
    // working — the threshold defaults to SMOKE_STUCK_THRESHOLD.
    const t = makeSmokeStuckTracker(SMOKE_STUCK_WINDOW);
    const smoke = 'x > 0';
    for (let i = 0; i < SMOKE_STUCK_THRESHOLD - 1; i++) t.record(smoke, false);
    expect(t.isStuck(smoke)).toBe(false);
    t.record(smoke, false);
    expect(t.isStuck(smoke)).toBe(true);
  });
});

describe('makeSmokeStuckTracker — isOscillating (#2)', () => {
  it('does not confuse normal fix-and-retry across page revisions with oscillation', () => {
    const t = makeSmokeStuckTracker();
    const smoke = 'window.__widget.value === 3';
    t.record(smoke, false, '<html>broken v1</html>');
    t.record(smoke, false, '<html>broken v1</html>');
    t.record(smoke, true, '<html>fixed v2</html>');
    expect(t.isOscillating(smoke, '<html>fixed v2</html>')).toBe(false);
    expect(t.isStuck(smoke, '<html>fixed v2</html>')).toBe(false);
  });

  it('fires when the same smoke has BOTH passes and fails in the window (min 3 occurrences)', () => {
    const t = makeSmokeStuckTracker();
    const smoke = 'document.title === "ready"';
    t.record(smoke, true);
    t.record(smoke, false);
    // Two occurrences — still below the 3-occurrence floor.
    expect(t.isOscillating(smoke)).toBe(false);
    t.record(smoke, true);
    // Three occurrences, both polarities present → oscillating.
    expect(t.isOscillating(smoke)).toBe(true);
  });

  it('fires on fail/fail/pass when no changed page revision explains the pass', () => {
    // Without a revision discriminator these are evaluations against the
    // same source, so mixed polarity is suspect. Normal fix-and-retry is the
    // distinct-revision case pinned above.
    const t = makeSmokeStuckTracker();
    const smoke = 'x > 0';
    t.record(smoke, false);
    t.record(smoke, false);
    t.record(smoke, true);
    expect(t.isOscillating(smoke)).toBe(true);
  });

  it('does NOT fire on a single pass or a single fail', () => {
    const t = makeSmokeStuckTracker();
    const smoke = 'x > 0';
    t.record(smoke, true);
    expect(t.isOscillating(smoke)).toBe(false);
    t.record(smoke, false);
    expect(t.isOscillating(smoke)).toBe(false);
  });

  it('does NOT fire on a smoke that only ever passes or only ever fails', () => {
    const t = makeSmokeStuckTracker();
    const always = 'x > 0';
    for (let i = 0; i < 5; i++) t.record(always, true);
    expect(t.isOscillating(always)).toBe(false);
    const never = 'y > 0';
    for (let i = 0; i < 5; i++) t.record(never, false);
    expect(t.isOscillating(never)).toBe(false);
  });

  it('scopes oscillation per-smoke — unrelated smokes do not share state', () => {
    const t = makeSmokeStuckTracker();
    const smokeA = 'x > 0';
    const smokeB = 'y > 0';
    t.record(smokeA, true);
    t.record(smokeA, false);
    t.record(smokeA, true);
    // smokeA oscillates, smokeB never recorded.
    expect(t.isOscillating(smokeA)).toBe(true);
    expect(t.isOscillating(smokeB)).toBe(false);
  });

  it('respects whitespace-normalisation (same assertion modulo formatting)', () => {
    const t = makeSmokeStuckTracker();
    t.record('x > 0', true);
    t.record('   x > 0', false);
    t.record('x     >     0', true);
    expect(t.isOscillating('x > 0')).toBe(true);
  });

  it('clears once old entries roll off the window', () => {
    const t = makeSmokeStuckTracker({ windowSize: 5, failureThreshold: 3 });
    const smoke = 'x > 0';
    t.record(smoke, true);
    t.record(smoke, false);
    t.record(smoke, true);
    expect(t.isOscillating(smoke)).toBe(true);
    // Push 5 unrelated entries so the oscillating trio rolls out.
    t.record('other', true);
    t.record('other', true);
    t.record('other', true);
    t.record('other', true);
    t.record('other', true);
    expect(t.isOscillating(smoke)).toBe(false);
  });
});
