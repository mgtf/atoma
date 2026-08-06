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
  /**
   * True when the pattern is only meaningful for scripts that have NO
   * business on the network. An HTTP-bucket skill probes a server it just
   * booted — that IS its verification — so these are lifted for it (see
   * `ScanOptions.allowLoopbackNetwork`).
   */
  readonly networkOnly?: boolean;
}

const DENY_LIST: readonly ScanPattern[] = [
  // Network egress — for a workspace-only verification script the inputs
  // are files and the probe manifest, never the network.
  { flag: 'network:fetch', re: /\bfetch\s*\(/, networkOnly: true },
  { flag: 'network:http-module', re: /['"]node:https?['"]|require\(\s*['"]https?['"]\s*\)/, networkOnly: true },
  { flag: 'network:raw-socket', re: /['"]node:(net|tls|dgram|dns)['"]|require\(\s*['"](net|tls|dgram|dns)['"]\s*\)/, networkOnly: true },
  { flag: 'network:websocket', re: /\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b/, networkOnly: true },
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

/**
 * Absolute http(s) URL literal pointing somewhere OTHER than loopback.
 * For a network-allowed script this is the actual exfiltration
 * signature — the destination, not the verb. Loopback host forms are
 * enumerated rather than pattern-guessed so a lookalike domain
 * ("localhost.evil.com") does not slip through as a prefix match.
 */
const EXTERNAL_URL_RE =
  /https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$))[a-zA-Z0-9.-]+/;

export interface ScanOptions {
  /**
   * Set for skills hosted by an L1 whose declared tools include the HTTP
   * pair (`fetch_url` / `start_node_server`). Those scripts boot a server
   * and probe it over HTTP — network access IS their verification, so the
   * blanket network flags would refuse the entire family's compilations.
   * Measured: `probe-crud-json-api-lifecycle` reached 5✓, Sonnet compiled
   * it correctly, and the scan rejected the result for `network:fetch` on
   * a script whose every request went to the loopback server it had just
   * started. Network primitives are lifted; a non-loopback URL literal is
   * still flagged, because that is the part that would actually exfiltrate.
   */
  readonly allowLoopbackNetwork?: boolean;
}

/** Flags found in a script body; empty array = clean. */
export function scanScriptBody(body: string, opts: ScanOptions = {}): string[] {
  const flags: string[] = [];
  for (const p of DENY_LIST) {
    if (p.networkOnly && opts.allowLoopbackNetwork) continue;
    if (p.re.test(body)) flags.push(p.flag);
  }
  if (opts.allowLoopbackNetwork && EXTERNAL_URL_RE.test(body)) {
    flags.push('network:external-url');
  }
  return flags;
}

/**
 * Does this host L1 legitimately speak HTTP? Derived from the DECLARED
 * toolset, the same way capability buckets are — an atom that was handed
 * `fetch_url` / `start_node_server` was built to probe servers.
 */
export function hostAllowsLoopbackNetwork(toolNames: readonly string[]): boolean {
  return toolNames.includes('fetch_url') || toolNames.includes('start_node_server');
}

/**
 * Generation id of the SCAN itself. The promotion-refusal stamp's premise
 * is "recompiling this body reproduces the same refusal" — and the scan is
 * an INPUT to that decision, exactly like the compile prompt. Fold it into
 * the stamped generation so tightening (or, as here, correcting) the
 * deny-list expires stamps it caused, instead of parking a skill forever
 * against a rule that no longer exists.
 */
export const SCAN_GENERATION = (() => {
  const canonical =
    DENY_LIST.map((p) => `${p.flag}:${p.re.source}:${p.networkOnly ? 1 : 0}`).join('|') +
    '|' + EXTERNAL_URL_RE.source;
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) h = ((h * 33) ^ canonical.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
})();
