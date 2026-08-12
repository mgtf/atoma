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
  `== ONE SMOKE, ALL THE CLAIMS — validate_html is your MOST EXPENSIVE tool ==`,
  `Every call re-launches the page, waits for network idle and replays`,
  `your interactions: SECONDS per call. So a smoke must not check ONE`,
  `thing. Return a structured OBJECT that answers EVERY question you`,
  `have about the page, in a single call, with an explicit aggregate \`ok\`:`,
  `    (() => ({`,
  `       ok:       window.__test.percentage === 75 &&`,
  `                 document.querySelectorAll('.cell').length === 64,`,
  `       cells:    document.querySelectorAll('.cell').length,`,
  `       pct:      window.__test.percentage,`,
  `       colour:   getComputedStyle(document.querySelector('#bar')).color,`,
  `       firstCell: !!document.getElementById('cell-0'),`,
  `    }))()`,
  `The whole object comes back in \`smokeResult\`, but it passes ONLY when`,
  `\`ok === true\` AND every boolean anywhere in the object is true. A result`,
  `with \`ok:true\` beside \`stateTransitions.building:false\` still FAILS.`,
  `For expected-false state, return the RAW value/class and fold the expected`,
  `comparison into a positively-named true assertion; never emit a false`,
  `boolean as mere diagnostics.`,
  `Two reasons this is strictly better than one assertion per call:`,
  `  1. COST — one page load`,
  `     tells you everything; twenty tell you the same thing twenty`,
  `     times. Measured: a habit-tracker run made 66 validate_html calls`,
  `     with 64 different smokes, 45 of them PASSING — one element`,
  `     verified per browser round-trip, ~9 minutes of pure page loads`,
  `     for what two calls would have answered.`,
  `  2. DIAGNOSIS — when a bare boolean fails you are told only`,
  `     "smoke check failed: false", which cannot tell you whether YOUR`,
  `     ASSERTION was wrong or the PAGE is broken. A failing object`,
  `     comes back with its values, so you can see it yourself.`,
  `Budget: a healthy web run needs a HANDFUL of validations — build,`,
  `validate, fix what the values revealed, re-validate. If you are past`,
  `five, you are enumerating instead of asserting: collapse your`,
  `remaining checks into ONE object smoke and read the result.`,
  `For every interaction selector, READ the current HTML and copy the exact`,
  `id/class byte-for-byte. Never infer kebab-case from a camelCase property`,
  `or invent a plausible selector: "#increment-btn" does not match`,
  `id="incrementBtn", and one guessed selector invalidates the whole replay.`,
  `Derive expected labels, classes and state thresholds from the same source.`,
  `Do not invent plausible states ("On Fire", "Keep Going") when the artefact`,
  `actually defines different values ("Beginner", "Building").`,
  `When exposing state through a getter, keep one writable backing field`,
  `(\`this._streak\`) and mutate that field everywhere. Never assign to a`,
  `getter-only property (\`this.streak = 0\` beside \`get streak()\`) — the`,
  `page throws before the smoke can run. Before serving, enumerate EVERY`,
  `\`get name()\` in the source and verify there is no \`this.name =\`,`,
  `\`this.name++\` or \`this.name--\`; derived labels such as statusText are`,
  `getter results, not writable state. Also scan for duplicate method/getter`,
  `names introduced during a fix; keep one definition.`,
  `Interaction arrays run COMPLETELY before smoke. A sequence that increments`,
  `and then resets exposes only the reset state, so it proves nothing about`,
  `the intermediate styling. To verify both in one call, drive exposed methods`,
  `inside a smoke IIFE with \`interactions: []\`, snapshot the milestone state,`,
  `reset, snapshot again,`,
  `and return both objects. When the task names styling, each snapshot MUST`,
  `include the actual class/style/color value and \`ok\` must compare the`,
  `milestone and reset styling — counters or status labels alone are insufficient.`,
  `Use this canonical shape instead of inventing a new sequence each time:`,
  `  interactions: []`,
  `  smoke: (() => {`,
  `    const w = window.__testOrWidget;`,
  `    w.reset();`,
  `    const initial = { value: w.value, className: exactElement.className };`,
  `    for (let i = 0; i < thresholdFromSource; i++) w.increment();`,
  `    const milestone = { value: w.value, className: exactElement.className };`,
  `    w.reset();`,
  `    const reset = { value: w.value, className: exactElement.className };`,
  `    return { ok: <all exact comparisons>, initial, milestone, reset };`,
  `  })()`,
  `Derive exactElement id, threshold, labels and class names by reading the`,
  `CURRENT source first. Never query an id or expect a label you did not read.`,
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

/**
 * Shared plan-time rule for file-mutating phases.
 *
 * A trusted script can return before any validator runs. Its match-time guard
 * can refuse a read-only verifier only when the subtask names the file it is
 * supposed to change. "Harden the existing CLI" carries no such witness;
 * "Harden index.js" does. The expense-splitter burn-in demonstrated the
 * consequence: a verifier replayed old probes, skipped the requested --help
 * and input-validation work, and the trusted path credited success.
 */
export const MUTATING_SUBTASK_FILE_GUIDANCE = [
  `== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==`,
  `Whenever a subtask asks to create, update, harden, fix, rewrite or document`,
  `a file, name the exact intended output path in that subtask description`,
  `(for example "harden index.js" or "write README.md from package.json").`,
  `A phrase like "harden the existing CLI" is UNDERSPECIFIED: a downstream`,
  `read-only verifier can look applicable and replay old probes while changing`,
  `nothing. File paths are OUTCOMES, not tool invocations, so this does not`,
  `conflict with the rule against hard-naming tools. The plan owns stable`,
  `filenames; choose them in the first build phase and repeat them in every`,
  `later phase that must mutate those files.`,
  `For a CLI that a later phase will package or name, choose a SEMANTIC entry`,
  `filename derived from its behavior (for example "csv2json.js"), never a`,
  `generic launcher such as "index.js", "main.js", "cli.js" or "app.js".`,
  `A generic path leaves deterministic packaging no honest product/bin name`,
  `and forces the full LLM fallback even when every invocation is verified.`,
].join('\n');

/** Durable HTTP docs must not capture the one port assigned to this run. */
export const HTTP_PORTABLE_DOC_GUIDANCE = [
  `HTTP DOCUMENTATION USES A PORT PLACEHOLDER. In README/docs and durable`,
  `example commands, write \`http://localhost:<port>\`, never the numeric port`,
  `assigned to the current server process. That number dies with the process.`,
  `The stdout marker is portable the same way: document`,
  `\`LISTENING_ON_PORT=<port>\`, never a captured value such as`,
  `\`LISTENING_ON_PORT=59420\`.`,
  `The live bound URL belongs in run evidence/results only, not documentation.`,
].join('\n');
