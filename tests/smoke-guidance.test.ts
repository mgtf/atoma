import { describe, it, expect } from 'vitest';
import {
  SMOKE_ASYNC_TRANSITION_EXAMPLE,
  SMOKE_CANONICAL_STATE_SHAPE,
  SMOKE_DESIGN_GUIDANCE,
  SMOKE_MULTI_CLAIM_EXAMPLE,
} from '../src/atoms/prompts.js';
import {
  CDP_PROTOCOL_TIMEOUT_MS,
  detectSmokeStatementError,
  detectBrittleComputedStyleLiteral,
  detectResetErasedIntermediateEvidence,
  diagnoseSmokeEvaluationError,
  probeManifestWriteRefusal,
  renderSmokeFailure,
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

  // BATCH 3 REGRESSION, self-inflicted: teaching the smoke to await made the
  // model await REAL TIME for a 30-second countdown. Two smokes were killed at
  // the CDP timeout having burned ~45s each, and the run failed on its budget.
  // The await is legitimate; unbounded it is not.
  it('bounds the await, and the guidance quotes the real CDP ceiling', () => {
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/THE settle\(\) AWAIT IS BOUNDED/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/window\.__test\.advance\(ms\)/);
    // The prose states the ceiling in seconds. `src/atoms/` must not import
    // from `src/tools/`, so the two are pinned here instead of shared: if the
    // constant moves, this fails rather than the guidance quietly lying.
    const seconds = Math.round(CDP_PROTOCOL_TIMEOUT_MS / 1000);
    expect(SMOKE_DESIGN_GUIDANCE).toContain(`still running after ${seconds}s is KILLED`);
  });

  it('replaces the leaked Puppeteer protocolTimeout advice with a diagnosis', () => {
    const puppeteer =
      "Runtime.evaluate timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.";
    const out = diagnoseSmokeEvaluationError(puppeteer);
    expect(out).not.toBeNull();
    expect(out).toMatch(/KILLED after 30s/);
    expect(out).toMatch(/window\.__test\.advance\(ms\)/);
    // The original is kept: it is still the ground truth of what threw.
    expect(out).toContain(puppeteer);
  });

  it('leaves an unrelated smoke error verbatim', () => {
    expect(diagnoseSmokeEvaluationError("Unexpected token 'const'")).toBeNull();
    expect(diagnoseSmokeEvaluationError('el is not defined')).toBeNull();
    // "timed out" alone is not enough — it must be the CDP evaluate timeout.
    expect(diagnoseSmokeEvaluationError('fetch timed out after 5s')).toBeNull();
  });

  // FIX-5: two VALID model documents merged fine; a third, INVALID one was
  // passed through verbatim and landed unreadable on disk (raw newline inside
  // a string, position 6408). The ground-truth probe then reported MALFORMED
  // and the run paid an extra execute cycle to repair our own write.
  it('refuses an unparseable probe manifest, and only the incoming side', () => {
    const raw = '{"version":1,"entries":[{"probe":"web","file":"index.html","smoke":"a\nb"}]}';
    const refusal = probeManifestWriteRefusal(raw);
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/not valid JSON/);
    expect(refusal).toMatch(/Nothing was written/);
    // Repair is preserved: a VALID replacement is always allowed through, even
    // when the manifest already on disk is the broken one.
    expect(
      probeManifestWriteRefusal('{"version":1,"entries":[]}')
    ).toBeNull();
  });

  // ADVERSARIAL REVIEW 2026-08-21 (highest-severity finding): the block's
  // FLAGSHIP example returned `colour: getComputedStyle(...).color` beside an
  // `ok` asserting only counters — the exact shape validate_html forces to
  // ok=false, and the exact shape tests/contracts.test.ts pins as
  // non-compliant. The "ok does not assert styling" refusal fired in all four
  // burn-in batches while the model was following our own template.
  it('EVERY example in the block passes the guards it will be measured by', () => {
    const examples = {
      multiClaim: SMOKE_MULTI_CLAIM_EXAMPLE,
      canonical: SMOKE_CANONICAL_STATE_SHAPE.replace(/^[\s\S]*?smoke: /, ''),
      transition: SMOKE_ASYNC_TRANSITION_EXAMPLE,
    };
    for (const [name, smoke] of Object.entries(examples)) {
      expect(detectSmokeStatementError(smoke), name).toBeNull();
      expect(detectBrittleComputedStyleLiteral(smoke), name).toBeNull();
      expect(detectResetErasedIntermediateEvidence([], smoke), name).toBeNull();
      // Each returns styling, so each must ASSERT styling inside its ok.
      expect(smokeOkIncludesStyling(smoke), name).toBe(true);
    }
  });

  it('renders the multi-claim example verbatim and warns about bare styling', () => {
    for (const line of SMOKE_MULTI_CLAIM_EXAMPLE.split('\n')) {
      expect(SMOKE_DESIGN_GUIDANCE).toContain(line);
    }
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(
      /ANY class, style or colour value you RETURN must also be asserted/
    );
    // The refused shape must not survive anywhere in the block.
    expect(SMOKE_DESIGN_GUIDANCE).not.toContain('colour:   getComputedStyle');
  });

  // ADVERSARIAL REVIEW 2026-08-21: promoting the async shape to canonical made
  // the guard's leader regex load-bearing for a shape it did not recognise, so
  // the likeliest copy error on a 20-line template stopped being caught.
  it('catches the missing trailing () on an async IIFE, not just a sync one', () => {
    expect(detectSmokeStatementError('(async () => { return 1 })')).toMatch(
      /never invokes it/
    );
    expect(detectSmokeStatementError('(async function(){ return 1 })')).toMatch(
      /never invokes it/
    );
    // Still correct on the shapes it always handled, and still silent on the
    // properly-invoked async forms the guidance teaches.
    expect(detectSmokeStatementError('(() => { return 1 })')).toMatch(/never invokes it/);
    expect(detectSmokeStatementError('(async () => { return 1 })()')).toBeNull();
  });

  // ADVERSARIAL REVIEW 2026-08-21: JSON.stringify(undefined) is the VALUE
  // undefined, so `.slice` threw a TypeError inside the evaluation try and the
  // catch reported the tool's own bug as the page's fault.
  it('reports a smoke that returned nothing, instead of throwing on it', () => {
    expect(() => renderSmokeFailure(undefined)).not.toThrow();
    expect(renderSmokeFailure(undefined)).toMatch(/returned NO VALUE \(undefined\)/);
    expect(renderSmokeFailure(undefined)).toMatch(/forgotten return/);
    // Ordinary failures are unchanged, including the 500-char cap.
    // The paste is unchanged and still capped; what precedes it is the naming
    // clause added 2026-08-23. A result with no false boolean says so rather
    // than saying nothing.
    const ordinary = renderSmokeFailure({ ok: false, count: 3 });
    expect(ordinary).toMatch(/^smoke check failed: No false boolean field is present/);
    expect(ordinary).toMatch(/\{"ok":false,"count":3\}$/);
    expect(renderSmokeFailure(false)).toBe('smoke check failed: false');
    // Still bounded: the 500-char paste plus a naming clause whose field list
    // is itself capped at FALSE_FIELD_LIMIT names.
    expect(renderSmokeFailure({ pad: 'x'.repeat(900) }).length).toBeLessThan(700);
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
