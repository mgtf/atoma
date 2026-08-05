/**
 * Shared prompt blocks that multiple layers consume. Extracted from
 * L2Atom (P7 slice): build-app.ts and the canonical seeders needed
 * SMOKE_DESIGN_GUIDANCE and had to import it FROM the supervisor class —
 * an examples→atoms→L2Atom dependency inversion that also dragged the
 * whole 2,800-line module into anything wanting one prompt constant.
 */

/**
 * Shared smoke-test design guidance. Appended to every L1 system
 * prompt that the supervisor controls — both the one `createSubtaskL1`
 * emits on fresh-L1 creation and the one `buildNarrowL1Prompt` emits
 * on escalation branches. Keeping this block identical in both paths
 * means a new L1 starts with the same smoke discipline as a branched
 * one: IIFE-only, `window.__test` hooks for state-heavy apps, no
 * simulated-input cargo-culting.
 *
 * Earlier runs ran into two persistent pain points that this block
 * addresses:
 *   (1) smokes written as top-level statements (`const x = ...; x > 0`)
 *       which don't parse inside the tool's `(${smoke})` wrapper and
 *       cost a full Puppeteer round-trip per mistake;
 *   (2) smokes that try to reproduce domain-specific winning paths via
 *       simulated clicks — observed burning 15+ rounds on a chess
 *       puzzle asserting `statusText.includes('Checkmate')` after
 *       random clicks that could not produce a mate.
 */
export const SMOKE_DESIGN_GUIDANCE = [
  `== SMOKE-TEST DESIGN (read carefully — this is where runs go wrong) ==`,
  `The \`smoke\` arg of validate_html is evaluated inside`,
  `  (() => { const __r = (YOUR_CODE); return __r; })()`,
  `so YOUR_CODE must be a pure EXPRESSION. These ALL break parsing:`,
  `    const x = 1; x > 0         // top-level \`const\``,
  `    return x > 0               // top-level \`return\``,
  `    if (cond) { return true }  // top-level \`if\``,
  `Wrap any logic in an IIFE when you need locals or statements:`,
  `    (() => { const x = compute(); return x > 0 })()`,
  `    (function(){ /* ... */ return result })()`,
  ``,
  `== STATE-HEAVY APPS: expose a __test hook, do NOT simulate inputs ==`,
  `For games with rules (chess, minesweeper, roguelikes), for`,
  `multi-step flows (wizards, forms with validation), or for any app`,
  `whose success criterion needs domain-specific knowledge — DO NOT`,
  `try to reproduce the winning path via simulated clicks/keypresses.`,
  `Random clicks on a chess board will never produce a checkmate, and`,
  `the smoke loop will grind for many rounds with the same false`,
  `assertion (observed in production: 15+ wasted Puppeteer rounds`,
  `asserting \`statusText.includes('Checkmate')\` after arbitrary`,
  `clicks).`,
  `Instead, EXPOSE a deterministic test hook from the app code:`,
  `    window.__test = {`,
  `      forceState(scenario) { /* seed the exact position */ },`,
  `      checkInvariant() { /* return bool for the claim you verify */ },`,
  `    };`,
  `Then the smoke becomes trivial and reliable:`,
  `    (() => { window.__test.forceState('mate-in-1-back-rank');`,
  `             return window.__test.checkInvariant(); })()`,
  `The hook is production-harmless (guarded by a flag, or simply`,
  `always-on — it adds <1KB). Validate_html output will also echo`,
  `coaching hints back to you when it rejects a smoke pre-flight or`,
  `detects the same smoke failing repeatedly; read and act on them.`,
  ``,
  `== SMOKE-LOOP DISCIPLINE ==`,
  `If the SAME smoke assertion fails more than twice, STOP retrying`,
  `it — the assertion is structurally unreachable with the current`,
  `inputs. Switch to either: a \`window.__test\` hook (see above), a`,
  `simpler invariant (element exists + renders), OR accept the`,
  `functionality as verified and return your final JSON output.`,
  `Interleaving a trivially-passing sanity smoke between real-retry`,
  `smokes does NOT reset the stuck detector — it is cumulative over`,
  `a sliding window.`,
].join('\n');
