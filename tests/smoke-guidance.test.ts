import { describe, it, expect } from 'vitest';
import {
  SMOKE_ASYNC_TRANSITION_EXAMPLE,
  SMOKE_CANONICAL_STATE_SHAPE,
  SMOKE_DESIGN_GUIDANCE,
} from '../src/atoms/prompts.js';
import {
  detectSmokeStatementError,
  detectBrittleComputedStyleLiteral,
  detectResetErasedIntermediateEvidence,
} from '../src/tools/builtin.js';
import { smokeOkIncludesStyling } from '../src/contracts/probeManifest.js';

/**
 * The smoke guidance and the validate_html pre-flight guards are two halves
 * of one contract: the guidance says what to write, the guards refuse what
 * must not be written. Nothing kept them in agreement.
 *
 * MEASURED 2026-08-21 (batch 1, web-counter): 19 validate_html calls and
 * $0.52 of execute tokens were spent discovering the guards one rejection at
 * a time — 4× "interactions … then reset", 2× rgb()-literal, 2× "ok does not
 * assert styling". The deepest one was never stated at all: the artefact
 * declared `#count { transition: all 0.3s ease }`, so five consecutive smokes
 * read a PRE-transition computed colour and the model "repaired" its correct
 * CSS with `!important`.
 *
 * These tests pin the guidance to the guards. If either side moves, the pair
 * must be re-reconciled here rather than in a live run.
 */
describe('SMOKE_DESIGN_GUIDANCE ↔ validate_html pre-flight guards', () => {
  it('the async transition example survives EVERY pre-flight guard', () => {
    const smoke = SMOKE_ASYNC_TRANSITION_EXAMPLE;
    expect(detectSmokeStatementError(smoke)).toBeNull();
    expect(detectBrittleComputedStyleLiteral(smoke)).toBeNull();
    // No external interactions: the smoke drives its own transitions.
    expect(detectResetErasedIntermediateEvidence([], smoke)).toBeNull();
  });

  it('the async transition example asserts styling inside its aggregate ok', () => {
    // Otherwise validate_html flips ok to false with "class/style/color
    // values were returned but the aggregate ok expression does not assert
    // them" — the exact rejection the example exists to avoid.
    expect(smokeOkIncludesStyling(SMOKE_ASYNC_TRANSITION_EXAMPLE)).toBe(true);
  });

  it('the guidance renders the example verbatim, never a hand-copied twin', () => {
    for (const line of SMOKE_ASYNC_TRANSITION_EXAMPLE.split('\n')) {
      expect(SMOKE_DESIGN_GUIDANCE).toContain(line);
    }
  });

  it('names the mechanism, not just "transitions are brittle"', () => {
    // The old text said only that transitions "make guesses brittle", which
    // does not tell a model that the read it is about to take CANNOT work.
    // The heading itself is asserted by the LAW test below.
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/the tool awaits your promise/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/does nothing to an animation/);
  });

  // The canonical shape is the one the model COPIES, so it carries the most
  // weight of anything in the block. It must satisfy the guards it will be
  // measured against, and it must await — a synchronous copy is what the two
  // 2026-08-21 web runs actually paid for.
  it('the canonical state-driving shape survives every pre-flight guard', () => {
    // The guidance prints `interactions: []` above the smoke; the guards see
    // the smoke expression alone.
    const smoke = SMOKE_CANONICAL_STATE_SHAPE.replace(/^[\s\S]*?smoke: /, '');
    expect(detectSmokeStatementError(smoke)).toBeNull();
    expect(detectBrittleComputedStyleLiteral(smoke)).toBeNull();
    expect(detectResetErasedIntermediateEvidence([], smoke)).toBeNull();
    expect(smokeOkIncludesStyling(smoke)).toBe(true);
  });

  it('the canonical shape awaits, so an async repaint is observable', () => {
    expect(SMOKE_CANONICAL_STATE_SHAPE).toContain('(async () => {');
    expect(SMOKE_CANONICAL_STATE_SHAPE).toMatch(/const settle = \(\) => new Promise/);
    // One await per state change, plus the leading reset: fewer means some
    // milestone is snapshotted before the page has repainted.
    expect(SMOKE_CANONICAL_STATE_SHAPE.match(/await settle\(\)/g)).toHaveLength(3);
    expect(SMOKE_DESIGN_GUIDANCE).toContain('settle()');
  });

  it('states the LAW, not just the two symptoms it was measured on', () => {
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(
      /A SYNCHRONOUS SMOKE SEES ONLY WHAT THE PAGE ALREADY COMMITTED/
    );
    // Both measured halves must stay quoted: one is a transition, the other a
    // timer repaint, and a reader who sees only one will generalise wrongly.
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/rgb\(51, 51, 51\)/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/elapsed: 988/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/setInterval.*requestAnimationFrame/s);
  });

  it('renders the canonical shape verbatim, never a hand-copied twin', () => {
    for (const line of SMOKE_CANONICAL_STATE_SHAPE.split('\n')) {
      expect(SMOKE_DESIGN_GUIDANCE).toContain(line);
    }
  });

  it('still refuses the shapes the guards refuse (guard sanity, not tautology)', () => {
    // A literal rgb() comparison — what the model actually wrote in production.
    expect(
      detectBrittleComputedStyleLiteral(
        `(() => ({ ok: getComputedStyle(el).color === 'rgb(255, 0, 0)' }))()`
      )
    ).toMatch(/literal rgb\(\)\/rgba\(\)/);
    // A body that never invokes itself.
    expect(detectSmokeStatementError(`(() => { return 1 })`)).toMatch(/never invokes it/);
  });
});
