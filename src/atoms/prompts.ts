/**
 * Shared prompt blocks that multiple layers consume. Extracted from
 * L2Atom (P7 slice): build-app.ts and the canonical seeders needed
 * SMOKE_DESIGN_GUIDANCE and had to import it FROM the supervisor class —
 * an examples→atoms→L2Atom dependency inversion that also dragged the
 * whole 2,800-line module into anything wanting one prompt constant.
 */
import type { Plan } from '../core/types.js';

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
/**
 * The "one smoke, all the claims" example.
 *
 * Its `ok` asserts the STYLING it returns, which is not decoration: when a
 * smoke returns a class/style/colour value that the aggregate `ok` does not
 * assert, `validate_html` forces ok=false with "class/style/color values were
 * returned but the aggregate ok expression does not assert them"
 * (builtin.ts), and `tests/contracts.test.ts` pins that shape as
 * non-compliant. The previous version of this example returned
 * `colour: getComputedStyle(...).color` beside an `ok` asserting only
 * counters — the exact refused shape — so a model following the block's
 * flagship template was rejected on a page that was correct. Measured
 * 2026-08-21: that refusal fired in all four burn-in batches.
 *
 * Exported and pinned by `tests/smoke-guidance.test.ts` against the real
 * pre-flight guards and against `smokeOkIncludesStyling`.
 */
export const SMOKE_MULTI_CLAIM_EXAMPLE = [
  `(() => {`,
  `  const bar = document.querySelector('#bar');`,
  `  const checks = {`,
  `    pctReached:  window.__test.percentage === 75,`,
  `    cellCount:   document.querySelectorAll('.cell').length === 64,`,
  `    firstCell:   !!document.getElementById('cell-0'),`,
  `    barClassSet: bar.classList.contains('filled'),`,
  `  };`,
  `  return { ok: Object.values(checks).every(Boolean), checks,`,
  `           pct: window.__test.percentage,`,
  `           cells: document.querySelectorAll('.cell').length,`,
  `           barClass: bar.className };`,
  `})()`,
].join('\n');

/**
 * The canonical state-driving smoke: drive the widget's own API, snapshot
 * each milestone, return one aggregate verdict.
 *
 * ASYNC BY DEFAULT since 2026-08-21, and that is the whole point. A
 * synchronous smoke holds the JS task, so NOTHING the page updates
 * asynchronously can be observed by it: CSS transitions have not advanced,
 * and `setInterval` / `requestAnimationFrame` repaints have not run. Two
 * burn-in tasks lost real money to that on 2026-08-21 (see
 * SMOKE_DESIGN_GUIDANCE for both measurements), each asserting a claim that
 * could not become true inside one task. The `settle()` await is what makes
 * the copied template correct instead of subtly unobservable.
 *
 * Exported and pinned by `tests/smoke-guidance.test.ts` against the real
 * validate_html pre-flight guards, like SMOKE_ASYNC_TRANSITION_EXAMPLE.
 */
export const SMOKE_CANONICAL_STATE_SHAPE = [
  `interactions: []`,
  `smoke: (async () => {`,
  `  const settle = () => new Promise((r) => setTimeout(r, 400));`,
  `  const w = window.__testOrWidget;`,
  `  w.reset(); await settle();`,
  `  const initial = { value: w.value, className: exactElement.className,`,
  `                    text: exactElement.textContent };`,
  `  for (let i = 0; i < thresholdFromSource; i++) w.increment();`,
  `  await settle();  // let the timer/rAF repaint AND any transition finish`,
  `  const milestone = { value: w.value, className: exactElement.className,`,
  `                      text: exactElement.textContent };`,
  `  w.reset(); await settle();`,
  `  const reset = { value: w.value, className: exactElement.className };`,
  `  const checks = {`,
  `    milestoneValueMatches: milestone.value === thresholdFromSource,`,
  `    milestoneStyleMatches: milestone.className === classFromSource,`,
  `    milestoneTextRepainted: milestone.text !== initial.text,`,
  `    resetMatches: reset.value === initial.value &&`,
  `                  reset.className === initial.className,`,
  `  };`,
  `  return { ok: Object.values(checks).every(Boolean), checks,`,
  `           initial, milestone, reset };`,
  `})()`,
].join('\n');

/**
 * The canonical async smoke for reading a TRANSITIONED computed value.
 *
 * Exported as a CONSTANT rather than left as prose inside the guidance
 * because guidance that teaches a smoke the tool would refuse is worse than
 * no guidance: `tests/smoke-guidance.test.ts` feeds this exact string to the
 * real validate_html pre-flight guards, so a future edit to either side
 * cannot silently start advertising a rejected shape.
 */
export const SMOKE_ASYNC_TRANSITION_EXAMPLE = [
  `(async () => {`,
  `  const before = getComputedStyle(el).color;`,
  `  el.click();`,
  `  await new Promise((r) => setTimeout(r, transitionMsFromSource + 100));`,
  `  const after = getComputedStyle(el).color;`,
  `  const checks = { colourChanged: after !== before };`,
  `  return { ok: Object.values(checks).every(Boolean), checks, before, after };`,
  `})()`,
].join('\n');

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
  ...SMOKE_MULTI_CLAIM_EXAMPLE.split('\n').map((line) => `    ${line}`),
  `The whole object comes back in \`smokeResult\`, and explicit \`ok === true\``,
  `is authoritative. Fold EVERY required task claim into that expression.`,
  `ANY class, style or colour value you RETURN must also be asserted by \`ok\`:`,
  `returning one as a bare diagnostic forces ok=false with "class/style/color`,
  `values were returned but the aggregate ok expression does not assert them",`,
  `on a page that may be perfectly correct. Put it in \`checks\`, not beside it.`,
  `Raw state fields may legitimately be false (for example`,
  `initial.thresholdReached=false); they are diagnostics, not assertions.`,
  `Keep smokeResult replay-stable: never return raw timestamps, generated ids,`,
  `ephemeral ports or locale-formatted dates. Return deterministic booleans,`,
  `counts and source-defined labels; expected records the whole result exactly.`,
  `If you omit \`ok\`, the structured object fails validation.`,
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
  `If previousStepSummary supplies a live loopback URL from a Node server,`,
  `validate that URL directly. Do NOT start_static_server on server.js or the`,
  `workspace root: it serves a directory listing, not the embedded dynamic UI.`,
  `For every interaction selector, READ the current HTML and copy the exact`,
  `id/class byte-for-byte. Never infer kebab-case from a camelCase property`,
  `or invent a plausible selector: "#increment-btn" does not match`,
  `id="incrementBtn", and one guessed selector invalidates the whole replay.`,
  `For form text, use interaction {type:"type", selector:"#field", text:"..."}.`,
  `keypress accepts ONE key name (Enter, ArrowRight, "a"), never a full string`,
  `such as "Test User"; submit only after typing every required field.`,
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
  `Interaction arrays run COMPLETELY before smoke, and supplying them beside a`,
  `smoke that drives state ITSELF discards every one of them — the two are`,
  `MUTUALLY EXCLUSIVE, so choose per call. A sequence that increments, toggles`,
  `twice, or resets exposes only the final state, so it proves nothing about`,
  `the intermediate styling. To verify both in one call, drive inside a smoke`,
  `IIFE with \`interactions: []\`, snapshot the milestone state, reset,`,
  `snapshot again,`,
  `and return both objects. When the task names styling, each snapshot MUST`,
  `include the actual class/style/color value and \`ok\` must compare the`,
  `milestone and reset styling — counters or status labels alone are insufficient.`,
  `If the control has NO exposed method, click the element itself inside the`,
  `same IIFE (\`document.getElementById(idFromSource).click()\`) — that still`,
  `counts as driving your own state, so the interaction array must be empty.`,
  `Use this canonical shape instead of inventing a new sequence each time:`,
  ...SMOKE_CANONICAL_STATE_SHAPE.split('\n').map((line) => `  ${line}`),
  `Derive exactElement id, threshold, labels and class names by reading the`,
  `CURRENT source first. Never query an id or expect a label you did not read.`,
  `THE settle() AWAIT IS BOUNDED: it exists to let ONE repaint or transition`,
  `land — hundreds of milliseconds. It is NOT a way to wait for real time to`,
  `pass. The browser runs in REAL TIME and cannot fast-forward, and a smoke`,
  `still running after 30s is KILLED and returns NOTHING at all.`,
  `MEASURED 2026-08-21: a 30-second countdown task awaited 33s and 35s inside`,
  `two smokes; both were killed, each having burned ~45s of wall clock, and the`,
  `run then failed on its whole budget. If your claim needs the clock to move,`,
  `do NOT wait for it — expose window.__test.advance(ms) from the app (move its`,
  `internal time AND repaint), drive that from the smoke, and assert the state`,
  `it produces. Same rule as keypress holdMs: real time is never the tool.`,
  ``,
  `== A SYNCHRONOUS SMOKE SEES ONLY WHAT THE PAGE ALREADY COMMITTED ==`,
  `THE LAW: your smoke holds the JS task while it runs. Anything the page`,
  `updates ASYNCHRONOUSLY therefore cannot be observed by it — CSS transitions`,
  `have not advanced, and \`setInterval\` / \`requestAnimationFrame\` repaints`,
  `have not run. Internal state read from a hook advances (it is computed on`,
  `demand); the DOM the user would see does not. Assert one against the other`,
  `and you have written a claim that CANNOT become true, however many times`,
  `you retry it.`,
  `Both halves were measured on 2026-08-21, in two different batches:`,
  `  CSS TRANSITION. \`#count{transition:all .3s ease}\` +`,
  `  \`#count.negative{color:red}\`, VERIFIED in Chrome:`,
  `      synchronous read -> { cls:true, computed:"rgb(51, 51, 51)" }   STALE`,
  `      after await 400ms -> { cls:true, computed:"rgb(255, 0, 0)" }   settled`,
  `  The click-counter run spent 19 validate_html calls and $0.52 of execute`,
  `  tokens here: five consecutive smokes asserted the computed colour, each`,
  `  received the stale value, and the model "repaired" its already correct CSS`,
  `  by adding \`!important\` — which does nothing to an animation.`,
  `  TIMER REPAINT. A stopwatch smoke returned`,
  `      { elapsed: 988, running: true, display: "00:00.00",`,
  `        innerHTML: "00:00.00", textContent: "00:00.00" }`,
  `  — the clock advanced because getElapsedMs() reads Date.now(), while the`,
  `  display stayed at zero because the setInterval tick that writes it never`,
  `  got to run. That run cost 18 validate_html calls and 404s.`,
  `So: if the claim involves a repaint, an animation or a timer, the smoke MUST`,
  `await. The canonical shape above already does; keep its \`settle()\`.`,
  `For a STYLING claim specifically, in order of preference:`,
  `  1. ASSERT THE MARKER THE SOURCE TOGGLES — \`classList.contains('negative')\``,
  `     or the inline \`el.style.color\` the script assigns. Deterministic, no`,
  `     timing, and it is what the pre-flight guard means by "the exact`,
  `     source-defined class/style marker".`,
  `  2. Only if the COMPUTED value is itself the claim, make the smoke async and`,
  `     wait past the declared duration — the tool awaits your promise:`,
  ...SMOKE_ASYNC_TRANSITION_EXAMPLE.split('\n').map((line) => `         ${line}`),
  `Never compare a computed value to an rgb()/rgba() LITERAL: that smoke is`,
  `refused pre-flight, before the page is even loaded. Compare milestone`,
  `against the captured initial value instead.`,
  ``,
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
  `MUST declare the same intent STRUCTURALLY: every file-mutating subtask`,
  `carries "outputs": [<exact workspace-relative paths it creates or`,
  `modifies>]. List OUTPUTS only — never inputs it merely reads ("update`,
  `README.md from package.json" declares outputs ["README.md"]). Omit the`,
  `field entirely on read-only subtasks (verification, re-running recorded`,
  `probes). Omitting "outputs" on a mutating phase is a plan defect. The`,
  `runtime treats a declared list as authoritative for its dispatch gates.`,
].join('\n');

/**
 * DECLARED PROOF OBLIGATIONS. Deliberately terse, and deliberately part of
 * the planning prompt rather than a detector over the phase description: a
 * mechanical "the word click implies a DOM obligation" rule is the
 * vocabulary-frozen detector class the 2026-08-14 review measured as a
 * primary source of drift. The vocabulary is closed with one member, so this
 * costs a handful of output tokens on the phases that need it and nothing
 * anywhere else.
 */
export const PROOF_OBLIGATION_GUIDANCE = [
  `PROVING USER INPUT WORKS. When a phase's verification depends on REAL user`,
  `input reaching the page — a button that must actually respond to a click,`,
  `a field that must accept typing — declare it structurally on that subtask:`,
  `"proofObligations": ["dom-interaction"]. It is the ONLY accepted value;`,
  `omit the field everywhere else.`,
  `What it changes: the supervisor checks that the browser tool actually`,
  `EXECUTED an interaction, from the tool's own transport record. A smoke`,
  `expression that drives the page through its own \`window.*\` hooks proves`,
  `the internal path and NOT the input path, and the runtime discards every`,
  `external interaction when the smoke drives its own state — so a phase that`,
  `declares this obligation must reach the affordance through selector-based`,
  `interactions, not through a test hook.`,
  `Declaring it does not make the phase stricter to pass; leaving it out when`,
  `the task names user input means the work is delivered with its method`,
  `unproven, and nothing is learned from the run.`,
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

export const LITERAL_CONTRACT_PRESERVATION_GUIDANCE = [
  `== PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION ==`,
  `A subtask may narrow SCOPE but must never rename, replace or summarise away`,
  `the user's exact routes, JSON field names, types, formats, status codes or`,
  `fixed literals. "Implement proper validation" is not a substitute for`,
  `\`POST /labels {"name":string,"color":"#RRGGBB"}; reject blank/wrong/malformed`,
  `with 400\`. Repeat the exact contract in BOTH the build and verification`,
  `subtasks that consume it. Never fill an omitted schema from a familiar recipe.`,
].join('\n');

const LITERAL_CONTRACT_MARKER = '== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==';

export function stripLiteralContractBlock(description: string): string {
  const marker = description.indexOf(LITERAL_CONTRACT_MARKER);
  return marker >= 0 ? description.slice(0, marker).trim() : description;
}

export function extractLiteralContractClauses(description: string): string {
  const inherited = description.indexOf(LITERAL_CONTRACT_MARKER);
  if (inherited >= 0) return description.slice(inherited + LITERAL_CONTRACT_MARKER.length).trim();
  if (!/(?:\{[^{}\n]{1,300}\}|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+)/i.test(description)) {
    return '';
  }
  const clauses = description
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        /(?:\{[^{}]{1,300}\}|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+|\b(?:reject|required?|must|only|status\s+\d{3}|malformed|wrong\s+type)\b)/i.test(
          clause
        )
    );
  return [...new Set(clauses)].join('\n').slice(0, 1600);
}

export function preservePlanLiteralContracts(plan: Plan, taskDescription: string): Plan {
  const clauses = extractLiteralContractClauses(taskDescription);
  if (!clauses) return plan;
  const block = `${LITERAL_CONTRACT_MARKER}\n${clauses}`;
  return {
    ...plan,
    subtasks: plan.subtasks.map((subtask) =>
      subtask.description.includes(LITERAL_CONTRACT_MARKER)
        ? subtask
        : { ...subtask, description: `${subtask.description}\n\n${block}` }
    ),
  };
}
