import {  manifestReaderLines } from '../contracts/probeManifest.js';

/**
 * The compile-prompt TEMPLATE, extracted so its GENERATION can be hashed.
 * Any edit to these static lines changes COMPILE_PROMPT_GENERATION, which
 * refusal/demotion stamps record — a stamp from an older generation must NOT
 * keep blocking recompilation, because its premise ("recompiling the same
 * body reproduces the same script") is false once the COMPILER itself
 * evolved. Observed live: the probe-manifest contract landed and a stamped
 * skill needed a manual operator reset to benefit from it.
 */
export function buildCompileSkillPrompt(args: {
  skillId: string;
  skillDescription: string;
  skillWhenToUse: string;
  skillBody: string;
  subTaskDescription: string;
  resultSummary: string;
}): string {
  return [
      `You are PROMOTING a SKILL — a reusable how-to recipe attached to a tier-1`,
      `element — from kind:llm (markdown instructions for the LLM tool-loop) to`,
      `kind:script (a deterministic Node.js program). The L1 atom will execute`,
      `the script via write_file + run_shell on every future match instead of`,
      `re-discovering the steps with an LLM tool-loop. That cuts Haiku`,
      `tool-loop spend on stable patterns to ~zero.`,
      ``,
      `RUNTIME CONTRACT — your script will be invoked as:`,
      `  node _skill_<id>.mjs '<json-encoded-subtask-description>'`,
      `MODULE SEMANTICS — the scratch file is .mjs, so write ESM: import`,
      `built-ins via \`import fs from 'node:fs'\` (never require()). ESM has`,
      `no __dirname/__filename — derive paths from process.cwd(). The .mjs`,
      `extension shields the script from the workspace's own package.json`,
      `(a task-authored "type" field must never change how this script runs).`,
      `i.e. process.argv[2] is a JSON-encoded string carrying the natural-language`,
      `subtask. Your script may parse hints from it (regex / string contains) but`,
      `should mostly rely on the deterministic steps the recipe encodes. The`,
      `script's final stdout MUST be a single JSON line of shape`,
      `{"output": <deliverable>, "summary": "<one sentence including a verbatim`,
      `\\"== GROUND TRUTH ==\\" block as the L1 result-reporting contract requires>"}.`,
      ``,
      `NO TASK-SPECIFIC LITERALS — MANDATORY. The script is reused across every`,
      `future task in its class, so it must DERIVE everything task-specific from`,
      `the workspace and from argv[2]. Never hardcode a filename, an argument`,
      `value, a CLI flag or an expected output that came from the ONE example`,
      `run below. Observed failure: a promoted documentation script carried`,
      `\`invocations = ['node index.js sample.txt']\` from the file-analyzer task`,
      `it was learned on, so a later Caesar-cipher CLI shipped a README whose`,
      `documented examples printed the usage message instead of ciphering —`,
      `and every validator approved it, because the artefact itself was fine.`,
      `Derive invocations by reading the entry file's argument handling and its`,
      `usage string; if you cannot derive them, exit NON-ZERO rather than`,
      `inventing a plausible-looking example. A script that fabricates`,
      `documentation is worse than one that refuses.`,
      ``,
      `INPUT VARIANCE — MANDATORY. Model-authored artefacts the script reads`,
      `(READMEs, docs, configs) vary in formatting between runs: fenced blocks`,
      `vs inline code, "$ " prompt prefixes, prose annotations, different`,
      `heading levels. Extraction logic must tolerate that variance, and a`,
      `command's ARGUMENTS ARE PART OF THE COMMAND — capture the complete`,
      `command line (e.g. the full fenced line), never a prefix truncated at a`,
      `quote or punctuation. Observed failure: a compiled reverify script`,
      `matched commands with a character class that excluded quotes, so`,
      `\`node index.js "Hello World"\` was amputated to \`node index.js\`, four`,
      `documented invocations deduped into one bare command, and the script`,
      `reported a phantom mismatch on a correct deliverable. When extraction`,
      `finds nothing where the recipe expects something, exit NON-ZERO.`,
      ``,
      ...manifestReaderLines(),
      ``,
      `NETWORK POLICY — MANDATORY. The compiled body is statically scanned`,
      `before promotion, and unless the HOST L1 declares HTTP tools`,
      `(fetch_url / start_node_server) the scan REFUSES any network primitive:`,
      `fetch, node:http(s), net/tls/dgram/dns, WebSocket. Do NOT import them`,
      `to "verify a server yourself" — when a recipe's verification involves`,
      `HTTP, the workspace's own executable harness is the replay unit: spawn`,
      `it via child_process (always allowed) and judge its exit code; the`,
      `harness does the networking. Observed refusal: a replay recipe was`,
      `compiled with node:http + raw sockets to re-probe routes directly and`,
      `the scan parked it — a spawn-only script compiles clean and does the`,
      `same job. Even on an HTTP-tooled host, only loopback destinations are`,
      `tolerated; an absolute non-loopback URL literal is refused always.`,
      ``,
      `FAILURE SIGNALLING — MANDATORY. There is NO validator downstream of a`,
      `trusted script: whatever you print is taken as the deliverable. So if a`,
      `precondition is missing or a step fails, you MUST:`,
      `  - write the diagnosis to stderr, AND`,
      `  - exit with a NON-ZERO code (process.exit(1)).`,
      `Do NOT print a success-shaped envelope carrying a "FAILED …" summary and`,
      `then exit 0 — the supervisor reads the exit code, and a zero exit means`,
      `"the deliverable is done". Never emit "output": null. And if the script`,
      `computes a validity verdict (allValid, passed, ok…), a FALSE verdict IS`,
      `a failure: exit non-zero. Never bury it as data inside a zero-exit`,
      `envelope — a compiled verifier shipped exactly that shape and a`,
      `sabotaged file sailed through with EXIT=0.`,
      ``,
      `If the recipe has irreducible LLM steps — 'pick the right SQL helpers',`,
      `'design a schema', 'reason about the API shape' — you cannot promote it.`,
      `In that case return {"promotable": false, "reason": "<one sentence>"}.`,
      `Don't force a fragile script just to satisfy the request.`,
      ``,
      `== SKILL ID ==`,
      args.skillId,
      ``,
      `== SKILL DESCRIPTION ==`,
      args.skillDescription,
      ``,
      `== SKILL when_to_use ==`,
      args.skillWhenToUse,
      ``,
      `== CURRENT (kind:llm) BODY ==`,
      args.skillBody,
      ``,
      `== EXAMPLE SUBTASK THAT THIS SKILL JUST HANDLED ==`,
      args.subTaskDescription,
      ``,
      `== EXAMPLE L1 SUMMARY OF THAT RUN ==`,
      args.resultSummary,
      ``,
      `The two EXAMPLE blocks above are ILLUSTRATIVE context — one run this`,
      `skill happened to drive. They tell you the workflow's shape, not its`,
      `parameters: the compiled script will be dispatched against DIFFERENT`,
      `subtasks whose filenames, arguments and outputs share nothing with`,
      `this example. Judge promotability against the BODY's recipe, not`,
      `against how well you could script this one example.`,
      ``,
      `Output ONLY a JSON object — no fences, no preamble, first character "{":`,
      `  Promotable case: {"promotable": true, "language": "node", "body": "<full script source>"}`,
      `  Refusal case:    {"promotable": false, "reason": "<one sentence>"}`,
      `The script body MUST be the COMPLETE source — do not truncate, do not`,
      `paste placeholders. Use only stdlib + the dependencies the recipe`,
      `already names (e.g. better-sqlite3); install via npm at runtime when`,
      `needed; emit LISTENING_ON_PORT=<n> on stdout if you spawn a server.`,
    ].join('\n');
}

/** djb2 over the template rendered with fixed placeholders → 8-hex id. */
function hashGeneration(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export const COMPILE_PROMPT_GENERATION = hashGeneration(
  buildCompileSkillPrompt({
    skillId: '_gen_',
    skillDescription: '_gen_',
    skillWhenToUse: '_gen_',
    skillBody: '_gen_',
    subTaskDescription: '_gen_',
    resultSummary: '_gen_',
  })
);
