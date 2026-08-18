/**
 * Generation ids for the promotion machinery, and the ONE predicate that
 * decides whether a refusal stamp is still CURRENT (i.e. still parks
 * recompilation) versus stale (the environment changed; retry once).
 *
 * Stamps are written in TWO currencies, matching what would actually
 * falsify each stamp's premise:
 *
 *  - Compile refusals and scan refusals stamp `REFUSAL_GENERATION`
 *    (compile-prompt hash + scan hash, dash-joined): the refusal came
 *    from the compiler's judgment or from the deny-list, so a change to
 *    EITHER input deserves exactly one retry.
 *
 *  - Demotions stamp the compile-only generation that PRODUCED the
 *    failing script (`skill.compiledGeneration`): a runtime failure is
 *    falsified only by a DIFFERENT compiler — the scan does not shape
 *    the emitted body, so a scan change cannot alter the recompile's
 *    runtime behaviour.
 *
 * `refusalStampIsCurrent` accepts both currencies. Without it (observed
 * 2026-08-06, cli-envcheck run): every comparison site tested strict
 * equality against ONE currency, so a demotion stamp written under the
 * CURRENT compiler could never equal the combined string — the
 * anti-thrash guard evaporated and a structurally brittle script would
 * be recompiled by the very compiler that produced it, forever (1 Sonnet
 * call + 2 failed dispatches + LLM fallback per lap). The curriculum CLI
 * had the inverse bug: it compared against the compile-only generation,
 * so combined-format stamps never matched and currently-refused skills
 * were mislabeled as retry candidates.
 */
import { COMPILE_PROMPT_GENERATION } from './compilePrompt.js';
import { SCAN_GENERATION } from './scriptScan.js';

/**
 * The refusal stamp must expire when EITHER input to the refusal decision
 * changes — the compile prompt or the static scan. Stamping the compile
 * generation alone parked a skill against a scan rule that had since been
 * corrected (observed: `probe-crud-json-api-lifecycle`, refused for
 * `network:fetch` on a script whose every request went to the loopback
 * server it had just booted).
 */
export const REFUSAL_GENERATION = `${COMPILE_PROMPT_GENERATION}-${SCAN_GENERATION}`;

/**
 * Is this stamp still in force? True for the combined compile+scan
 * generation (compile/scan refusals) AND for the bare current compile
 * generation (demotion stamps — see module docstring for why the scan
 * hash is deliberately absent from that currency). Anything else —
 * unstamped refusals, older generations of either currency — is stale and
 * grants the evolved compiler exactly one retry.
 */
export function refusalStampIsCurrent(gen: string | undefined): boolean {
  return gen === REFUSAL_GENERATION || gen === COMPILE_PROMPT_GENERATION;
}
