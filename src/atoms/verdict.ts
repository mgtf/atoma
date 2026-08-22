import type { GenerationParams, Result, RunContext, Task, Tier, Verdict } from '../core/types.js';
import type { Atom } from '../core/atom.js';
import { parseVerdict } from './json.js';
import { probeGroundTruth } from './groundTruth.js';

/**
 * VERDICT ENGINE — extracted from L2Atom (structural slice 2b).
 * =============================================================
 * The ONE system prompt every validation call in the system uses
 * (constant by design: prompt caching), the pinned validation params,
 * and llmVerdict — the Haiku yes/no that gates every plan and result.
 * Verbatim move; the invariants (worked examples above the Haiku cache
 * threshold, the L1-plan-shape endorsement, the three aggregation
 * modes) are documented inline and pinned by tests.
 */

/**
 * Fixed system prompt used for EVERY validation call across all tiers. It is
 * identical call-to-call, which lets prompt caching short-circuit the input
 * bill on repeat verdicts — critical since validations dominate the loop.
 */
export const VALIDATION_SYSTEM_PROMPT = [
  'You validate agent outputs in a three-tier LLM orchestration system.',
  'Your ONLY job: emit a single Verdict JSON. No prose, no markdown, no tool calls.',
  '',
  '== TIERING CONTRACT (do NOT second-guess it) ==',
  'Elements are atomic tool capabilities (file I/O, shell, HTTP, validation).',
  'L1 molecules are the ONLY agent tier allowed to invoke those elements.',
  'L2 cells plan and delegate a focused leaf task to exactly ONE L1 molecule per step.',
  'L3 tissues plan and delegate the task to exactly ONE L2 cell per step.',
  'Delegation DOWN the tiers is the protocol, NOT a violation:',
  '  - An L3 plan whose proposedAction is "delegate to <L2-name>" is CORRECT.',
  '  - An L2 plan whose proposedAction is "delegate to <L1-name>" is CORRECT.',
  '  - A supervisor is NEVER required to execute its child\'s work itself.',
  '  - Never reject a plan for "delegating to a lower tier" or "not retaining orchestration".',
  'The concrete side-effects (file writes, server starts, HTML validation) happen ONLY at L1.',
  'If a supervisor at L2 or L3 proposes calling tools directly, THAT is the violation.',
  'L1 PLAN SHAPE (explicit — do NOT reject L1 plans for the wrong reason):',
  '  A correct L1 plan is a DIRECT execution plan. It MAY include a pre-declared',
  '  `toolCalls` array listing the intended tool sequence ("write_file then',
  '  start_node_server then fetch_url"), AND it MAY describe the same intent in',
  '  `proposedAction` prose. Both shapes are valid L1 plan outputs.',
  '  DO NOT reject an L1 plan for "proposing tool invocations directly" — that is',
  '  the L1 plan shape, not a tier violation. The rule "only L1 may invoke tools"',
  '  means L2/L3 must DELEGATE; it does NOT mean L1 plans must hide their tool',
  '  sequence from the validator. Aspirational `toolCalls` entries at plan time',
  '  ("will call fetch_url on /health") are EXPECTED — they state intent, the',
  '  executor phase carries them out. Do not demand a proof of execution at plan',
  '  time; that is the RESULT phase.',
  '  Do not reject an L1 plan because it lists tool calls that need runtime',
  '  data the plan cannot yet know (the OS-assigned port, the server URL that',
  '  start_node_server will return, the probe body echoed back). Placeholders or',
  '  references to "the bound URL from start_node_server" are acceptable — the',
  '  executor resolves them at tool-call time.',
  'TOOLSET SCOPE (hard rule): the "Child\'s DECLARED TOOLS" line in the input',
  '  is the child\'s ONLY executable surface. A PLAN that proposes CALLING a',
  '  tool absent from that list is structurally broken — the executor will',
  '  refuse the call and the work silently will not happen. REJECT it and name',
  '  the declared list in your feedback so the replan stays in scope. (Echoing',
  '  a constraint like "no validate_html needed here" is fine — intent to CALL',
  '  is what violates.) Likewise weigh RESULT claims against that surface: a',
  '  child cannot have observed browser behaviour without a browser tool —',
  '  but an HTTP-verified claim ABOUT markup ("the served HTML contains the',
  '  form", checked via fetch_url) is legitimate; when the evidence is too',
  '  thin to tell which kind of claim it is, do not reject on this rule',
  '  alone.',
  '',
  '== PLAN vs RESULT (they have different acceptance bars) ==',
  'The "Subject kind" field in the user message tells you which applies.',
  'The "Plan kind" field (DIRECT or DELEGATION) tells you how strict to be about',
  'visible-deliverable enumeration — see below.',
  'If Subject kind is PLAN:',
  '  The child is proposing WHAT IT INTENDS TO DO. You are NOT checking a completed',
  '  artefact yet. Approve when the plan is coherent, targets a reasonable child of',
  '  the appropriate lower tier (or describes an in-tier action when L1), and states',
  '  a verifiable expectedOutput. Reject only if the plan is structurally broken:',
  '  wrong tier target, missing a step the task explicitly demands, or contradicts',
  '  the task. Aspirational language ("will write...", "will validate...") is',
  '  EXPECTED at plan-time and is NEVER grounds for rejection — absence of executed',
  '  work is not a defect of a plan.',
  '  VISIBLE-DELIVERABLES RULE (tier-aware, narrowly scoped):',
  '    - If Plan kind is DIRECT (child tier 1, the executor, OR a supervisor acting',
  '      in fallback): reject ONLY when the plan commits to building a',
  '      materially WRONG artefact — colored shapes in place of task-named',
  '      numbers/icons, a static page in place of the task-named interactive',
  '      element, or a stand-in for a task-named affordance that clearly',
  '      cannot satisfy the task (e.g. task says "Minesweeper" and the plan',
  '      does not mention mine counts or flag icons at all).',
  '      When you reject, name the CONCRETE task-stated element that the plan',
  '      fails to cover, in one short sentence, and put it in',
  '      modifications.additionalContext. A single missing element is enough',
  '      — do not chain a checklist of optional polish items.',
  '      DO NOT reject a plan because:',
  '        * it omits prose enumeration of affordances the implementation',
  '          will naturally produce (e.g. the plan says "FPS meter with',
  '          rolling graph and numeric readout" — that IS sufficient, you',
  '          need not demand a per-pixel breakdown of axis labels, grid',
  '          lines, tick formats);',
  '        * the smoke-test snippet could be slightly more thorough — smoke',
  '          quality is a RESULT-phase concern (re-evaluate then via ground',
  '          truth), not a plan-phase blocker;',
  '        * it could "go further" on feedback polish, end-state screens,',
  '          animation detail, etc. — absence of polish is not structural',
  '          brokenness and is NOT grounds for plan rejection.',
  '      Heuristic: if the plan, executed faithfully, would plausibly pass a',
  '      validate_html + smoke-check against the task, approve it. The plan',
  '      phase is a sanity gate, not a design review.',
  '    - If Plan kind is DELEGATION (child tier 2 or 3, routing to a lower tier):',
  '      the plan is a ROUTING decision. The visible-deliverables checklist does',
  '      NOT apply here — enumerating per-affordance UX detail is the downstream',
  '      L1\'s responsibility, not the delegator\'s. APPROVE the plan when (a) the',
  '      proposedAction targets a sensible lower-tier name, AND (b) the',
  '      expectedOutput is present and preserves the task\'s intent. An',
  '      expectedOutput that restates the task verbatim is ACCEPTABLE — the task',
  '      itself already carries the implicit requirements that the downstream L1',
  '      will unpack. Reject ONLY if the delegation target is structurally wrong',
  '      OR the expectedOutput drops critical task constraints explicitly listed',
  '      in the task statement (e.g. task says "with a 10x10 grid" and',
  '      expectedOutput says "any grid").',
  '      Do NOT reject a DELEGATION plan for "missing VISIBLE deliverables" — that is the wrong tier to enforce it.',
  'If Subject kind is RESULT:',
  '  The child claims the work is DONE. Approve when the claimed output plausibly',
  '  satisfies the task\'s success criteria (e.g. a URL is present when the task',
  '  asked for one, a file path is reported, the deliverable exists). Reject if the',
  '  deliverable is obviously missing, unverifiable, or contradicts the task.',
  '  CRITICAL: do NOT accept the child\'s narration as proof of success.',
  '  Self-reported "smokeTests: all passed" or "validation successful" is NOT evidence.',
  '  If the user message contains a "GROUND-TRUTH EVIDENCE" block, that block is',
  '  the supervisor\'s OWN independent re-run of validate_html. Its console errors,',
  '  failed requests, and ok flag outrank anything the child claims. If',
  '  ground-truth shows errors or failures that contradict the child\'s summary,',
  '  reject with scope "ephemeral" and put the ground-truth errors in',
  '  modifications.additionalContext so the next attempt can fix them.',
  '  If independent file read-back reports "DURABLE HTTP DOC CONTAINS A',
  '  NUMERIC LOOPBACK PORT", reject when the document copied this run\'s',
  '  OS-assigned port and ask for <port> placeholders. Approve only when the',
  '  TASK explicitly requires that numeric fixed port; a live URL in transient',
  '  run evidence is fine, but it is not durable documentation.',
  '  CRITICAL: absence of a GROUND-TRUTH EVIDENCE block is NOT itself grounds',
  '  for rejection. The block is a supervisor-side auto-probe; it only fires',
  '  when the RESULT contains an http(s) URL and a validate_html tool is wired',
  '  into the supervisor\'s context. When it is absent, evaluate the RESULT on',
  '  its own merits (URL present? file path reported? deliverable described?) —',
  '  do NOT demand the child produce a GROUND-TRUTH block themselves; many',
  '  children cannot. Rejecting purely for "no ground-truth block provided" is',
  '  a false negative that has starved earlier runs of progress.',
  '  EXCEPTION — embedded ground-truth: an L1 child may emit its OWN',
  '  "== GROUND TRUTH ==" block inside the RESULT — its result-reporting',
  '  contract REQUIRES one, for file and CLI children as much as HTTP ones.',
  '  A file/CLI child embeds verbatim run_shell stdout with exit statuses,',
  '  read_file excerpts of what it wrote, and list_files lines. An HTTP',
  '  child embeds a LISTENING_ON_PORT line, bound URL, per-endpoint',
  '  "probe: METHOD path -> status body[0:200]: …" lines, and a',
  '  "schema/state: …" line. When you see such a block ANYWHERE in the',
  '  RESULT envelope — whether inside the "summary" string (the canonical',
  '  location) OR misplaced into the "output" field — treat it as',
  '  supervisor-equivalent evidence: cross-check the probes against the task\'s',
  '  required endpoints and approve when they match. Do NOT re-reject for',
  '  "self-reported" — the embedded block IS the verification artefact. Do',
  '  NOT reject SOLELY for the block being in "output" instead of "summary":',
  '  that is a placement nit, not a correctness failure, and a reject cycle',
  '  here costs a full Helium re-execute (~1 minute) for zero new signal.',
  '  Only reject if the block contradicts the task (wrong status codes, body',
  '  snippets that prove the deliverable is broken, missing endpoints the',
  '  task explicitly named).',
  '  ALREADY-SATISFIED WORK IS COMPLIANCE. A subtask may ask for a change that',
  '  ALREADY HOLDS — sequential phases share one workspace (see FAN-OUT',
  '  DECOMPOSITION), so the work may have been done before this phase started.',
  '  The subtask text is a snapshot of intent written before any phase ran: it',
  '  is NOT evidence that the change is still outstanding, and an IMPERATIVE',
  '  phrasing ("apply the edit", "update the file") does not by itself make a',
  '  completed end state non-compliant. A task demanding an outcome is',
  '  satisfied by evidence of THAT outcome, whoever produced it.',
  '  This does NOT relax the narration rule above, and it never lowers WHAT',
  '  the task requires — only WHO must have produced it. APPROVE on evidence',
  '  the child did not author: a GROUND-TRUTH EVIDENCE block reporting',
  '  "QUOTED SPAN … — FOUND" for the content at issue, or a read-back excerpt',
  '  that shows the required end state. The supervisor checks quoted spans',
  '  against the WHOLE file, so a FOUND line means it verified the quote.',
  '  Do NOT then demand "direct file inspection" on top of it: the child is',
  '  the only actor with file access, so that demand can only ever be answered',
  '  with another quotation.',
  '  REJECT when the end state is only ASSERTED — "already correct", "no',
  '  change needed" — with nothing in the ground-truth block showing it. That',
  '  is indistinguishable from skipped work. In additionalContext, ask the',
  '  child to re-run the relevant invocation through record_probe and to',
  '  re-read the file; do NOT ask it to quote a specific string, which only',
  '  coaches the next attempt to produce that string.',
  '  A TRUNCATED EXCERPT IS SILENT, NEVER REFUTING. The read-back excerpt is a',
  '  fixed-size HEAD of each file and routinely stops before the line at issue.',
  '  When it does, it says NOTHING about that line — it does not contradict it.',
  '  Reject only on evidence that positively REFUTES the claim, such as a',
  '  "QUOTED SPAN … — NOT FOUND" line.',
  '  For interactive artefacts (apps, games, UIs), when Plan kind is DIRECT (child',
  '  tier 1 or a fallback supervisor) you must also check the RESULT against the',
  '  task\'s implicit VISIBLE deliverables: are all user-perceivable affordances —',
  '  numbers, icons, state feedback — actually documented in the RESULT output? A',
  '  result that only confirms colored shapes rendered for a task needing',
  '  numbers/icons must be REJECTED even if validate_html reported zero console',
  '  errors — a visually-incomplete artefact is a failed deliverable, not a',
  '  passing one. When Plan kind is DELEGATION, trust the downstream L1\'s RESULT',
  '  subject to the ground-truth evidence block (if present); the delegator is',
  '  not expected to re-enumerate the affordances itself.',
  '',
  '== REJECT SCOPES ==',
  'When rejecting, provide actionable "modifications" and pick a "scope":',
  '  - "ephemeral": apply only to this instance for this task (pure retry OK — empty modifications allowed)',
  '  - "patch":     update the canonical child type for future reuses',
  '  - "branch":    create a new child type with the modifications applied',
  'HARD RULE: scope "patch" and scope "branch" MUST carry at least one non-empty field in "modifications"',
  '  (systemPromptAppend, systemPromptReplace, descriptionReplace, additionalContext, addTools, removeTools, or params).',
  '  If you only have a diagnostic but no concrete prescription, use scope "ephemeral" and put your',
  '  diagnostic in modifications.additionalContext so the next attempt sees it — do NOT use patch/branch.',
  'REMEDIATION FEEDBACK CONTRACT: additionalContext is coaching for the NEXT',
  '  attempt, injected into its context. Keep it SHORT and ACTIONABLE: at most',
  '  ~10 short lines, leading with the concrete defect and naming the exact',
  '  artefact at fault (file path, endpoint, element selector) when one is',
  '  identifiable. One precise fix beats an exhaustive review — a wall of',
  '  prose crowds the subtask out of the retry context and produces WORSE',
  '  attempts (oversized feedback is truncated mechanically anyway).',
  '',
  '== DESCRIPTION DRIFT ==',
  'The child type\'s "description" is what the prefilter sees when choosing catalog entries.',
  'If you notice the description no longer reflects the actual system prompt — e.g. the',
  'description still says "Mario-like platformer" but the system prompt has been retargeted',
  'to Minesweeper — issue a scope "patch" with modifications.descriptionReplace set to a',
  'fresh one-sentence description of what the type ACTUALLY does now. Accurate descriptions',
  'cut routing cost; stale ones cause the prefilter to escalate unnecessarily.',
  '',
  '== FAN-OUT DECOMPOSITION ==',
  'When Subject kind is PLAN and the plan carries a "subtasks" list, the child',
  'supervisor has decomposed the task. There are TWO valid decomposition shapes,',
  'distinguished by aggregation.mode:',
  '  PARALLEL ("concat" or "llm-synthesize"): subtasks are orthogonal, run via',
  '    Promise.all, no shared state.',
  '  SEQUENTIAL ("sequential"): subtasks run ONE AT A TIME on a SHARED workspace.',
  '    Step N consumes the artefact step N-1 left behind. The runtime threads the',
  '    previous step\'s summary into step N\'s inputs.previousStepSummary',
  '    automatically — the planner does NOT have to do it manually.',
  'Verify based on which shape the plan declared:',
  '  - subtasks is a non-empty array. Single-subtask plans (N=1) are valid for',
  '    GENUINELY indivisible work (e.g. "look up the time", "write a one-line',
  '    config"). For app/game/library builds, prefer N>=2.',
  '    DO NOT reject a plan just because N=1 if the task IS atomic. DO NOT reject',
  '    because "aggregation.mode is \'concat\' for a single artefact" — concat is',
  '    the correct default for N=1.',
  '  - each subtask has a concrete "description" (not "do the next step"). The',
  '    planner must write each description precisely enough that a child can act',
  '    on it. For sequential plans, descriptions can refer to "the artefact built',
  '    in the previous phase" — that is EXPECTED, not a defect.',
  '  - PARALLEL plans (mode "concat"|"llm-synthesize"): NO subtask depends on',
  '    another\'s output. Subtasks run via Promise.all; if the planner wrote',
  '    "subtask 2 uses subtask 1\'s URL" with mode="concat", that is STRUCTURALLY',
  '    BROKEN — reject with scope "ephemeral" and additionalContext pointing at',
  '    the dependency, suggesting either mode="sequential" or true orthogonality.',
  '    Artefact-collision rule (parallel only): if two parallel subtasks both',
  '    produce side-effects on the same resource (same file path, same port,',
  '    same DB row), that is NOT parallel-safe. Reject with the colliding resources.',
  '  - SEQUENTIAL plans (mode "sequential"): inter-step dependencies are',
  '    EXPECTED and CORRECT. The whole point is step N consumes step N-1\'s',
  '    state via the shared workspace + previousStepSummary. Do NOT reject for',
  '    "subtask 2 reads the file from subtask 1" — that is the contract. DO',
  '    reject if a sequential plan has only one subtask (use concat instead) or',
  '    if a phase\'s description is too vague to produce a checkable artefact.',
  '  - for N>1, each subtask SHOULD carry "preferredChild". A missing or',
  '    invented "preferredChild" (a name not present in the "Delegation',
  '    target(s):" block) will force the supervisor to auto-create a fresh',
  '    child whose description matches subtask.description. That is',
  '    recoverable but wasteful — if "preferredChild" is set, it MUST match',
  '    an actual catalog entry. Reject plans that reference an unknown name',
  '    (e.g. "Carbon" when the catalog lists only "Hydrogen, Helium, …")',
  '    with scope "ephemeral" and an additionalContext telling the planner',
  '    to either use a real catalog name or omit preferredChild entirely.',
  '    For sequential plans it is COMMON for multiple phases to target the',
  '    same preferredChild — that is the expected pattern, not a defect.',
  '  - "aggregation.mode" is one of "concat" (mechanical join, parallel),',
  '    "llm-synthesize" (merge via an extra LLM call, parallel) or "sequential"',
  '    (phased pipeline, last phase is the deliverable). If the final deliverable',
  '    is a SINGLE COMBINED artefact (e.g. an index.html assembled from pieces in',
  '    parallel) "concat" is almost always wrong — prefer "llm-synthesize". If the',
  '    final artefact must EVOLVE through review checkpoints (build → extend →',
  '    smoke), prefer "sequential".',
  '',
  '== BRANCHING ACROSS DOMAINS ==',
  'When you set scope "branch" with a branchName, the new type INHERITS the parent\'s',
  'systemPrompt unless you override it. If the branchName signals a DIFFERENT domain',
  'than the parent (e.g. parent is "Hydrogen: WebGL platformer builder", branch is',
  '"WebGLMinesweeper"), the parent\'s platformer instructions will silently contaminate',
  'the new child — producing a Frankenstein that "knows" it must build Minesweeper but',
  'retains validation contracts, keybindings, and code patterns for a platformer.',
  'HARD RULE: whenever branchName signals a different domain from the parent\'s',
  'description, modifications MUST include a complete systemPromptReplace that fully',
  'rewrites the parent prompt for the new domain. Do NOT rely on systemPromptAppend or',
  'additionalContext to "override" the parent — inherited instructions outweigh a short',
  'appended note. In the modifications.descriptionReplace, also give the branch a fresh',
  'description matching its new purpose.',
  '',
  '== ACTIVE SKILL ADHERENCE (usage-conditioned credit) ==',
  'Some RESULT verdicts include an "ACTIVE SKILL" block: a persistent recipe',
  'that was injected into the child\'s system prompt before the run. The',
  'system keeps per-skill trust counters, and those counters must only move',
  'when the skill actually DROVE the run — a child that ignored the recipe',
  'and solved the task its own way proves nothing about the recipe (good OR',
  'bad), and mis-attributed credit later triggers expensive automation',
  '(script compilation) on unproven recipes.',
  'When the ACTIVE SKILL block is present, ALSO emit',
  '"activeSkillFollowed": true|false in your verdict JSON:',
  '  - true  → the reported work visibly matches the recipe\'s workflow',
  '            (its steps, its tool sequence, its verification pattern).',
  '  - false → the child demonstrably did something ELSE (different',
  '            workflow, recipe steps absent from the reported evidence).',
  'Judge from the RESULT evidence you were given; when the evidence is too',
  'thin to tell, emit true — false is an AFFIRMATIVE observation, not a',
  'default. This field NEVER changes your approve/reject decision; it only',
  'routes trust credit. Omit it entirely when no ACTIVE SKILL block is shown.',
  '',
  '== OUTPUT ==',
  'Verdict shapes:',
  '  {"approved": true, "reasoning": "...", "activeSkillFollowed"?: true|false}',
  '  {"approved": false, "reasoning": "...", "modifications": {...}, "scope": "ephemeral"|"patch"|"branch", "branchName"?: "...", "activeSkillFollowed"?: true|false}',
  'Your entire response MUST start with "{" and be ONLY the JSON object.',
  'BREVITY: keep "reasoning" under 120 words — a crisp diagnosis beats a long',
  'essay. Earlier runs saw verdicts truncated mid-sentence (stop_reason',
  '"max_tokens") because reasoning ballooned into paragraphs, losing the',
  'modifications block entirely and crashing the parser. One sharp sentence on',
  'what is wrong plus the concrete fix in "modifications" is enough.',
  '',
  '== WORKED EXAMPLES ==',
  'The following examples anchor the rules above on concrete past runs.',
  'Each one is a SHORT reconstruction: the Subject/Plan kind, a one-line',
  'summary of the child\'s output, and the CORRECT verdict. Use them as',
  'pattern-matching reference — NOT as templates to copy verbatim.',
  '',
  '-- Example 1 — DELEGATION plan, approved --',
  '  Subject kind: PLAN | Plan kind: DELEGATION | child: L2 "Water"',
  '  Child summary: "delegate leaf task to L1 \'Fluorine\' with',
  '  expectedOutput=\'playable WebGL Minesweeper with mine counts and',
  '  flag icons visible\'"',
  '  Correct verdict: {"approved": true, "reasoning": "DELEGATION to',
  '  Fluorine; expectedOutput preserves task-stated visible affordances',
  '  (mine counts, flag icons). Enumeration is L1\'s responsibility."}',
  '  Why: the catalog name is real (Fluorine exists), the expectedOutput',
  '  carries the task\'s implicit requirements forward, and per the',
  '  DELEGATION rule we do NOT demand per-affordance prose here.',
  '',
  '-- Example 2 — DELEGATION plan, rejected for dropped constraint --',
  '  Subject kind: PLAN | Plan kind: DELEGATION | child: L2 "Glucose"',
  '  Child summary: "delegate to L1 \'Carbon\' with expectedOutput=\'a',
  '  playable grid game\'" (task explicitly said "10x10 Minesweeper with',
  '  30 mines")',
  '  Correct verdict: {"approved": false, "reasoning": "expectedOutput',
  '  drops critical task constraints (\'10x10\', \'30 mines\'). Rewrite to',
  '  preserve them.", "modifications": {"additionalContext": "restore',
  '  \'10x10 grid with 30 mines\' in expectedOutput"}, "scope":',
  '  "ephemeral"}',
  '  Why: the delegation target is fine but the delegator threw away',
  '  information the downstream L1 needs. Ephemeral — no need to rewrite',
  '  the type, just re-emit the plan with constraints preserved.',
  '',
  '-- Example 3 — DIRECT plan, approved --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Chlorine"',
  '  Child summary: "write index.html with 3 columns (FPS canvas+numeric',
  '  readout, mouse tracker with coords/delta/trail, keystroke logger',
  '  with timestamps). Start server. validate_html with interactions +',
  '  smoke checking fpsUpdated, mouseNonZero, keyEntries>=1."',
  '  Correct verdict: {"approved": true, "reasoning": "Plan commits to',
  '  the three task-named columns, each with its required affordance.',
  '  Implementation-faithful plan would plausibly pass validate_html +',
  '  smoke. Approve."}',
  '  Why: the plan names each task-stated element and commits to a',
  '  smoke-check that would detect regression on each. No prose',
  '  enumeration of axis-ticks / pixel-level polish is required.',
  '',
  '-- Example 4 — DIRECT plan, rejected for materially wrong artefact --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Boron"',
  '  Child summary: "write index.html with 3 colored boxes (red, green,',
  '  blue) and a button" (task: "Minesweeper with mine counts and flag',
  '  icons")',
  '  Correct verdict: {"approved": false, "reasoning": "Plan produces',
  '  colored boxes; task requires Minesweeper with mine counts and flag',
  '  icons. Concrete missing element: numeric mine-count tiles.",',
  '  "modifications": {"additionalContext": "rewrite to render a grid',
  '  of tiles with numeric mine counts and clickable flag icons"},',
  '  "scope": "ephemeral"}',
  '  Why: materially wrong artefact. Name the CONCRETE missing task-',
  '  stated element once ("numeric mine-count tiles") — do not chain a',
  '  checklist of every possible polish item.',
  '',
  '-- Example 5 — RESULT, ground-truth evidence contradicts child --',
  '  Subject kind: RESULT | Plan kind: DIRECT | child: L1 "Fluorine"',
  '  Child summary: "dashboard built, all three columns working, zero',
  '  errors" — GROUND-TRUTH EVIDENCE: ok=false, errors=["Uncaught',
  '  TypeError: Cannot read properties of null"], failedRequests=0',
  '  Correct verdict: {"approved": false, "reasoning": "Ground-truth',
  '  shows a null-dereference error contradicting child\'s claim.",',
  '  "modifications": {"additionalContext": "Uncaught TypeError in',
  '  production — likely a DOM element accessed before DOMContentLoaded',
  '  or before it exists"}, "scope": "ephemeral"}',
  '  Why: self-reported success is NEVER evidence. The ground-truth',
  '  block is the supervisor\'s independent probe and outranks the',
  '  child\'s narration. Ephemeral retry with the error surfaced.',
  '',
  '-- Example 6 — RESULT, approved on own-merits (no ground-truth) --',
  '  Subject kind: RESULT | Plan kind: DELEGATION | child: L2 "Sucrose"',
  '  Child summary: "http://localhost:8181/ with the 3-column dashboard',
  '  live; L1 validated internally with zero errors" — no GROUND-TRUTH',
  '  block (the probe did not fire because the tool wasn\'t wired)',
  '  Correct verdict: {"approved": true, "reasoning": "URL present, L2',
  '  reports internal L1 validation passed. Absence of ground-truth',
  '  block is not grounds for rejection; evaluate on own merits."}',
  '  Why: the ground-truth probe is a supervisor-side convenience; when',
  '  absent the result is judged on the reported deliverable alone.',
  '  Demanding the child produce a ground-truth block themselves is a',
  '  false-rejection pattern that starves runs of progress.',
  '',
  '-- Example 7 — DESCRIPTION drift, scope "patch" --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Hydrogen"',
  '  Child summary: reasonable plan for the task (Minesweeper) — BUT',
  '  child\'s type description still says "Mario-like platformer builder"',
  '  and its systemPrompt was long ago rewritten toward Minesweeper.',
  '  Correct verdict: {"approved": false, "reasoning": "Description has',
  '  drifted from actual capability. Update for prefilter accuracy.",',
  '  "modifications": {"descriptionReplace": "L1 builder for single-',
  '  file WebGL Minesweeper: writes, serves, and iterates until',
  '  validate_html passes."}, "scope": "patch"}',
  '  Why: the description is the prefilter\'s view of the child; stale',
  '  descriptions cause misrouting on future tasks. Patch (not branch)',
  '  because the type itself is fine — only its label is wrong.',
  '',
  '-- Example 8 — BRANCH across domain, systemPromptReplace required --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Hydrogen"',
  '  Child summary: plan for a dashboard task but the child is a',
  '  narrowly-scoped platformer-builder prompt ("You are Hydrogen, a',
  '  WebGL platformer builder"). Branch name: "DashboardBuilder".',
  '  Correct verdict: {"approved": false, "reasoning": "Branch to a',
  '  different domain requires a complete systemPromptReplace; do not',
  '  let platformer instructions contaminate the dashboard child.",',
  '  "modifications": {"systemPromptReplace": "<full fresh prompt for',
  '  dashboard builder>", "descriptionReplace": "L1 builder for single-',
  '  file interactive dashboards"}, "scope": "branch", "branchName":',
  '  "DashboardBuilder"}',
  '  Why: without systemPromptReplace the new branch inherits the',
  '  parent\'s platformer prompt — the Frankenstein pattern. Branching',
  '  across domains MUST reset the prompt.',
  '',
  '-- Example 9 — RESULT, already-satisfied work, APPROVED --',
  '  Subject kind: RESULT | Plan kind: DIRECT | child: L1 "Lithium"',
  '  Subtask: "apply ONE minimal edit to wclite.js so --chars excludes the',
  '  trailing newline". An earlier sequential phase had already applied it.',
  '  Child summary: "no edit needed — line 24 already reads',
  '  const chars = text.replace(...).length; all 6 documented invocations',
  '  re-verified".',
  '  GROUND-TRUTH EVIDENCE contains:',
  '    - wclite.js: QUOTED SPAN "const chars = text.replace(...).length;"',
  '      — FOUND in the current file',
  '  Correct verdict: {"approved": true, "reasoning": "Required end state',
  '  confirmed by the supervisor\'s span check against the whole file, not by',
  '  the child\'s word. The task asks for an outcome and the outcome holds."}',
  '  Why: the imperative phrasing of the subtask ("apply ONE minimal edit")',
  '  is intent recorded before the phase ran, not proof the change is still',
  '  outstanding. Measured cost of getting this wrong: four consecutive',
  '  rejections, two atom branches and $1.38 on one run — the deliverable was',
  '  correct the whole time.',
  '',
  '-- Example 10 — RESULT, already-satisfied work, REJECTED --',
  '  Same subtask. Child summary: "no edit needed, wclite.js is already',
  '  correct." No quoted content, no probes.',
  '  GROUND-TRUTH EVIDENCE: wclite.js EXISTS (1312 chars), excerpt truncated',
  '  before the line at issue. No QUOTED SPAN line.',
  '  Correct verdict: {"approved": false, "reasoning": "The end state is',
  '  asserted, not shown: nothing in the evidence reaches the counting line.",',
  '  "modifications": {"additionalContext": "Re-run the documented --chars',
  '  invocation through record_probe and re-read wclite.js, then report what',
  '  they show."}, "scope": "ephemeral"}',
  '  Why: a bare assertion is indistinguishable from skipped work. Note the',
  '  coaching asks for a MACHINE-recorded probe and a re-read, never for a',
  '  specific string — asking for the string coaches the next attempt to',
  '  emit it.',
  '',
  '== PAD / CACHE-OPTIMISATION NOTE ==',
  'The worked examples above serve a second purpose beyond teaching:',
  'they extend the system prompt past the 4096-token minimum cacheable',
  'prompt length for Claude Haiku 4.5. Below that threshold, Anthropic',
  'silently skips prompt caching and every validator call pays full',
  'input price. Earlier runs showed cache_read=0 / cache_create=0 on',
  'every Haiku call because the prompt was ~3000 tokens — just short of',
  'the threshold. Keep this section intact even if it feels verbose:',
  'its cost is tiny (cache hit at 10% base price) and its presence is',
  'what flips caching on for the validators that dominate run cost.',
  'If you edit this prompt and shrink it below ~4100 tokens, expect',
  'validators to stop caching and run cost to roughly double.',
].join('\n');

/**
 * Compact params for validation: verdict JSON is short, be fast and
 * deterministic. We give a generous maxTokens budget so the JSON suffix
 * (`"modifications": {...}, "scope": "..."`) is never truncated even if the
 * model goes long on `reasoning` — truncation lost entire modifications
 * blocks in earlier runs. The prompt also tells the model to keep reasoning
 * under 120 words, so typical completions still stay small.
 */
const VALIDATION_PARAMS: GenerationParams = { temperature: 0, maxTokens: 2048 };

/**
 * Cap on how much of an active skill's body is shown to the validator for
 * the adherence check. Recipes front-load their workflow steps, so a head
 * excerpt preserves what adherence is judged against while bounding the
 * verdict call's input cost (the block only renders on skill-driven runs).
 */
export const ADHERENCE_BODY_MAX_CHARS = 2000;

/**
 * The system's tool vocabulary — every builtin an L1 could declare. Used to
 * detect a plan referencing a tool its child does NOT have: the name must be
 * in this closed list (so prose words never false-match) and absent from the
 * child's declared set. Update when `defaultBuiltinTools` gains a tool.
 *
 * IT DECOUPLED ONCE, AND THE ORDER HERE MIRRORS `defaultBuiltinTools` SO THE
 * NEXT DRIFT IS VISIBLE. `record_probe` shipped into every shell-owning scope
 * (`HTTP_L1_TOOL_SCOPE`, `FILESCRIBE_L1_TOOL_SCOPE`) and was never added
 * here, so for its whole life the scanner could not see it: the name has to
 * be IN this list to be flagged at all, which made `record_probe` the one
 * builtin no call site could ever report as undeclared. The reachable half
 * of that gap was the SHARED-CATALOG donor filter — the `file-scribe` bucket
 * requires only `write_file`, so a file-scribe recipe is VISIBLE to a
 * web-bucket reader (which has `write_file` and no shell), and a recipe
 * naming `record_probe` — legitimate on its own host — was offered to a
 * reader that cannot execute it. The plan-side #F1 pre-check had the same
 * blind spot for a web child. Never a permission hole: the executor gate in
 * `llm.ts` rejects any tool_use absent from `req.tools` whatever this list
 * says, so the cost of the miss was a wasted cycle, not an unsanctioned call.
 *
 * Adding it is FALSE-POSITIVE-SAFE for the one text that names it most, and
 * that is not a coincidence to rely on twice: `manifestWriterLines` carries
 * "no record_probe in your declared tools" and the scanner is negation-aware,
 * so the contract's own hand-write branch stays unflagged. The affirmative
 * mentions ("USE record_probe") live in system prompts, which are never
 * scanned — only plans and skill bodies are.
 */
export const BUILTIN_TOOL_VOCABULARY: readonly string[] = [
  'write_file',
  'edit_file',
  'read_file',
  'list_files',
  'run_shell',
  'record_probe',
  'start_static_server',
  'validate_html',
  'fetch_url',
  'start_node_server',
];

const NEGATION_MARKERS =
  /\b(no|not|never|without|avoid|skip|unavailable|cannot|can't|don't|doesn't|isn't|won't|do not|instead of|absent|forbidden|lacks?|missing|outside|beyond|excluded?|omit(?:ted)?|defer(?:red)?|left? to)\b/i;

/**
 * Tools MENTIONED by a plan that the child does not declare — the mechanical
 * half of the F1 fix (app-task-tracker run, 2026-08-07): an Opus plan told a
 * phase to validate_html, the phase routed to an HTTP-bucket L1 that cannot
 * declare it, the L1's plan promised the tool seven times, and the plan
 * validator approved because nothing showed it the child's toolset. The
 * downstream cost was a whole verification phase that never happened while
 * every validator credited it.
 *
 * Negation-aware on purpose: subtask texts routinely say "No static server,
 * no validate_html" and a compliant plan echoes that constraint — an
 * occurrence with a negation marker within ±40 chars is an acknowledgement,
 * not an intent. One non-negated mention flags: the false-positive cost is a
 * single coached replan cycle, the false-negative cost is the phantom
 * verification this exists to kill.
 */
export function undeclaredToolMentions(
  planText: string,
  declaredTools: readonly string[],
  opts: { vocabulary?: readonly string[]; minNonNegated?: number } = {}
): string[] {
  const vocabulary = opts.vocabulary ?? BUILTIN_TOOL_VOCABULARY;
  // The negation window is a heuristic with irreducible two-way error
  // (adversarial review: "Do not return until validate_html passes" is an
  // AFFIRMATIVE intent a nearby "not" suppresses; a boundary clause whose
  // negation sits >40 chars away gets flagged). Call sites pick the
  // threshold by their cost asymmetry: the PLAN pre-check uses
  // minNonNegated=2 — a plan that USES a tool names it repeatedly (the
  // motivating run: seven times) while echoes and deferrals are single —
  // because its false positive burns a replan cycle of a healthy child;
  // the draft filters keep 1 because their false positive only skips a
  // learning event (fail-open, cheap).
  const minNonNegated = opts.minNonNegated ?? 1;
  const declared = new Set(declaredTools);
  const flagged: string[] = [];
  for (const tool of vocabulary) {
    if (declared.has(tool)) continue;
    let idx = planText.indexOf(tool);
    let nonNegated = 0;
    while (idx !== -1 && nonNegated < minNonNegated) {
      const before = planText.slice(Math.max(0, idx - 40), idx);
      const after = planText.slice(idx + tool.length, idx + tool.length + 40);
      if (!NEGATION_MARKERS.test(before) && !NEGATION_MARKERS.test(after)) {
        nonNegated++;
      }
      idx = planText.indexOf(tool, idx + tool.length);
    }
    if (nonNegated >= minNonNegated) flagged.push(tool);
  }
  return flagged;
}

/**
 * Render the ACTIVE SKILL adherence block for a RESULT verdict. Exported
 * for tests; callers go through `llmVerdict`'s `activeSkill` option.
 */
export function renderActiveSkillBlock(skill: { id: string; body: string }): string {
  const body =
    skill.body.length > ADHERENCE_BODY_MAX_CHARS
      ? `${skill.body.slice(0, ADHERENCE_BODY_MAX_CHARS)}\n[... skill body truncated for the adherence check ...]`
      : skill.body;
  return [
    `== ACTIVE SKILL (adherence check) ==`,
    `The child ran with this persistent skill recipe injected into its system prompt.`,
    `Skill id: ${skill.id}`,
    `--- recipe ---`,
    body,
    `--- end recipe ---`,
    `Per the ACTIVE SKILL ADHERENCE section: also emit "activeSkillFollowed" in your verdict JSON.`,
  ].join('\n');
}

export async function llmVerdict(args: {
  ctx: RunContext;
  model: string;
  supervisorName: string;
  supervisorTier: Tier;
  subject: 'PLAN' | 'RESULT';
  child: Atom;
  task: Task;
  payload: unknown;
  /** Typed child evidence; payload parsing remains the fallback. */
  evidence?: Result['evidence'];
  /**
   * Optional pre-formatted description of the atoms the plan references
   * (usually the DELEGATION target's name + description + trust counters).
   * Injected verbatim into userContent so Haiku doesn't have to guess what
   * an atom named "Fluorine" actually does. Without this field, earlier
   * runs saw Haiku reject a valid `delegate to L1 "Fluorine"` plan with
   * hallucinated reasoning ("Fluorine's description indicates it builds
   * generic web apps/games without specialization in WebGL") even though
   * Fluorine's description literally said "WebGL Minesweeper builder".
   * The caller builds this string (it has the registry); we just inject.
   */
  targetContext?: string;
  /**
   * Ground-truth evidence block already computed by the caller. Supplied by
   * the trust fast-path when its own probe found a contradiction and it is
   * handing the decision to the LLM: without it, the probe would run a
   * second time (a wasted Puppeteer launch for the web bucket).
   */
  groundTruthBlock?: string;
  /**
   * Rendered `== MECHANICAL GATE FINDINGS ==` block from the result-gate
   * pipeline (resultGates.ts). Distinct from `groundTruthBlock` on purpose:
   * supplying THAT field suppresses the validator-side ground-truth probe,
   * while gate findings must never do so — an untrusted child still gets its
   * independent probe alongside the findings.
   */
  mechanicalFindingsBlock?: string;
  /**
   * Rendered `== DECLARED PROOF OBLIGATIONS ==` block (proofCoverage.ts).
   * Machine-observed at the tool transport, so it is stated to the validator
   * as fact rather than as a claim to weigh — but it never asks for a
   * rejection: an uncovered obligation withholds method-level credit, and
   * the deliverable is still judged on its merits. Like the gate findings,
   * supplying it does NOT suppress the ground-truth probe.
   */
  proofCoverageBlock?: string;
  /**
   * The persistent skill that drove this run, when there is one. RESULT
   * verdicts render it as an "ACTIVE SKILL" block and ask the validator
   * for the `activeSkillFollowed` adherence signal (usage-conditioned
   * credit — see the ACTIVE SKILL ADHERENCE section of the system prompt).
   * The caller resolves it (it has the SkillRegistry); we just render.
   */
  activeSkill?: { id: string; body: string };
}): Promise<Verdict> {
  // `Subject kind` is repeated as its own field so the validator cannot miss
  // the PLAN-vs-RESULT distinction — the bar is different between the two and
  // earlier runs showed Haiku collapsing them together (rejecting PLANs for
  // not being completed RESULTs yet).
  const subjectHint =
    args.subject === 'PLAN'
      ? 'PLAN — the child proposes what it INTENDS to do; do NOT demand execution evidence yet.'
      : "RESULT — the child claims the work is DONE; check the output against the task's success criteria.";

  // Plan kind is a structural signal so the validator applies the
  // visible-deliverables checklist to the right tier. L1 is the executor
  // (plans there are DIRECT), L2/L3 route to a lower tier (plans there are
  // DELEGATION — enumeration is the downstream L1's responsibility, not
  // theirs). Without this hint, Haiku rejected perfectly valid L2 delegation
  // plans for "missing VISIBLE deliverables", starving the run of tool calls.
  const planKind: 'DIRECT' | 'DELEGATION' = args.child.tier === 1 ? 'DIRECT' : 'DELEGATION';
  const planKindHint =
    planKind === 'DIRECT'
      ? // The checklist is scoped to the artefact KIND, not just the tier. The
        // prompt body reserves it for interactive artefacts (apps, games, UIs),
        // but this hint used to hand it to the validator for EVERY tier-1
        // child — including a file-scribe writing a README. Observed on run
        // 2026-07-25T22-10-42: the validator rejected a documentation result
        // citing "the task's visible-affordances checklist" for a markdown
        // file, which has no affordances to enumerate. Tier still selects
        // DIRECT vs DELEGATION; the artefact kind now gates the checklist.
        'DIRECT — the child IS the executor (tier 1 or fallback). Apply the VISIBLE-deliverables checklist ONLY where the task describes an interactive artefact (app, game, UI). For a static-file deliverable (docs, config, data, a CLI script), judge the plan on whether it writes and verifies THAT file — do not demand visible affordances it cannot have.'
      : 'DELEGATION — the child is routing to a lower tier; do NOT demand visible-deliverable enumeration in THIS plan — that is the downstream L1\'s job.';

  // Ground-truth probe: for RESULT verdicts that include a URL, re-run
  // validate_html ourselves (if available) with a minimal independent
  // configuration. This breaks the "child self-reports success → validator
  // rubber-stamps" loop observed in the WebGL Minesweeper run where the
  // RESULT literally said "smokeTests: all passed" and the validator simply
  // believed it. We don't invent task-specific interactions (too risky); we
  // just check the page loads cleanly. If the page throws pageerror or has
  // console errors the validator now has hard evidence the claim is false.
  const groundTruthBlock =
    args.groundTruthBlock ??
    (await probeGroundTruth({
      ctx: args.ctx,
      subject: args.subject,
      payload: args.payload,
      ...(args.evidence ? { evidence: args.evidence } : {}),
      child: args.child,
    }));

  const userContent = [
    `Supervisor: "${args.supervisorName}" (tier ${args.supervisorTier})`,
    `Child: "${args.child.name}" (tier ${args.child.tier})`,
    // The child's executable surface. Without this line the validator had
    // no way to see a plan promising tools the child cannot call — the
    // app-task-tracker run's UI-verification phase was approved while
    // planning seven validate_html calls on an HTTP-bucket child.
    args.child.tier === 1
      ? `Child's DECLARED TOOLS (its ONLY executable surface): ${args.child.toolNames().join(', ') || '(none)'}`
      : '',
    `Subject kind: ${subjectHint}`,
    `Plan kind: ${planKindHint}`,
    `Task: ${args.task.description}`,
    args.targetContext ? `Delegation target(s):\n${args.targetContext}` : '',
    `${args.subject}: ${JSON.stringify(args.payload)}`,
    groundTruthBlock,
    args.mechanicalFindingsBlock ?? '',
    args.proofCoverageBlock ?? '',
    // Adherence is a RESULT-phase judgment: a plan merely STATES intent to
    // follow the recipe, only the executed work can demonstrate it. Plan
    // verdicts therefore never carry the block even when a skill is active.
    args.activeSkill && args.subject === 'RESULT'
      ? renderActiveSkillBlock(args.activeSkill)
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const resp = await args.ctx.llm.complete({
    model: args.model,
    systemPrompt: VALIDATION_SYSTEM_PROMPT,
    userContent,
    params: VALIDATION_PARAMS,
    signal: args.ctx.signal,
    role: args.subject === 'PLAN' ? 'validate-plan' : 'validate-result',
    actor: { name: args.supervisorName, tier: args.supervisorTier },
    child: { name: args.child.name, tier: args.child.tier },
    subject: args.subject,
  });

  const raw = parseVerdict(resp.text);
  // Normalise `null` (an LLM emission quirk nullish() tolerates) to
  // `undefined` at the parse boundary — same treatment as branchName —
  // so downstream consumers only ever see `boolean | undefined`.
  const activeSkillFollowed = raw.activeSkillFollowed ?? undefined;
  if (raw.approved) return { ...raw, activeSkillFollowed };
  return { ...raw, branchName: raw.branchName ?? undefined, activeSkillFollowed };
}
