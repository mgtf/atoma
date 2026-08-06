/**
 * STATIC SCAN of `kind: 'script'` skill bodies — the pre-execution gate
 * the supply-chain-poisoning literature calls for (arxiv 2604.03081:
 * static analysis alone caught 90.7% of poisoned skills; payloads hide
 * in plausible-looking code, not in adversarial prompts).
 *
 * atoma's compiled scripts are VERIFICATION artefacts: they read the
 * workspace, re-run documented commands (child_process is therefore
 * deliberately NOT flagged — the probe-manifest contract requires it),
 * diff outputs, and print one JSON envelope. They have no business
 * opening network connections, evaluating dynamic code, or touching
 * credential paths — the deny-list below is exactly those three
 * categories, kept TIGHT on purpose: a false positive quarantines a
 * useful skill (recoverable — operator reviews and `skills reset`),
 * but a broad pattern list would erode trust in the gate itself.
 *
 * Enforced at TWO points, both fail-closed for the script and fail-open
 * for the run:
 *   - promotion (`tryPromoteSkill`): a flagged compile output is refused
 *     with the scan verdict as the (generation-stamped) refusal reason —
 *     the anti-thrash machinery already knows how to park it;
 *   - match time (`L2.runSubtask`): a flagged script (hand-authored or
 *     legacy) is QUARANTINED — neither direct-dispatched NOR injected
 *     (the injected block instructs the L1 to run the body verbatim, so
 *     falling back to the LLM loop would still execute it). The run
 *     proceeds skill-less, exactly as if nothing had matched.
 *
 * Defence in depth: the sandbox env allowlist (#7a), scratch HOME and
 * symlink containment already bound what a malicious body can reach —
 * this gate exists so a flagged body does not RUN at all.
 */

interface ScanPattern {
  readonly flag: string;
  readonly re: RegExp;
}

const DENY_LIST: readonly ScanPattern[] = [
  // Network egress — a verification script's inputs are the workspace and
  // the probe manifest, never the network.
  { flag: 'network:fetch', re: /\bfetch\s*\(/ },
  { flag: 'network:http-module', re: /['"]node:https?['"]|require\(\s*['"]https?['"]\s*\)/ },
  { flag: 'network:raw-socket', re: /['"]node:(net|tls|dgram|dns)['"]|require\(\s*['"](net|tls|dgram|dns)['"]\s*\)/ },
  { flag: 'network:websocket', re: /\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b/ },
  // Dynamic code — the compile contract produces plain readable Node; an
  // eval layer only exists to hide something from this scan.
  { flag: 'dynamic-code:eval', re: /\beval\s*\(/ },
  { flag: 'dynamic-code:function-constructor', re: /\bnew\s+Function\s*\(/ },
  // Credential-bearing paths — the scratch HOME already hides the real
  // one (#7a companion), but a body that ASKS for these has told us what
  // it is.
  { flag: 'credentials:home-probe', re: /\bos\.homedir\s*\(|\bhomedir\s*\(\s*\)/ },
  { flag: 'credentials:dotfiles', re: /\.ssh\b|\.aws\b|\.netrc\b|id_rsa|\.npmrc\b/ },
];

/** Flags found in a script body; empty array = clean. */
export function scanScriptBody(body: string): string[] {
  const flags: string[] = [];
  for (const p of DENY_LIST) {
    if (p.re.test(body)) flags.push(p.flag);
  }
  return flags;
}
