/**
 * Shared CLI argument parser for the atoma CLIs (registry, skills, ledger,
 * friction) AND the runner (via `parseArgTokens`).
 *
 * Fixes the flag-before-command bug each CLI had independently: the old
 * per-CLI parsers took `rest[0]` as the command unconditionally, so the
 * DOCUMENTED form `registry --db ./x.db list` parsed "--db" as an unknown
 * command and fell into help — with exit code 0, so scripts kept going on
 * a no-op (silent-help failure). This parser scans for the FIRST
 * non-flag-position token as the command, letting flags appear anywhere.
 *
 * Grammar, per token `--key`:
 *   1. `key` declared in `booleanFlags` (or `negatableFlags`, which implies
 *      boolean) → `flags[key] = 'true'`; NEVER consumes the next token. This
 *      is what lets `--clean-workspace <goal>` and `drop --force <l1> <id>`
 *      keep their positionals instead of feeding them to the flag.
 *   2. `key` is `no-<f>` with `f` declared in `negatableFlags` →
 *      `flags[f] = 'false'`; never consumes. Negation is OPT-IN per flag:
 *      a caller that tests `'force' in flags` must not have a stray
 *      `--no-force` materialize the key.
 *   3. `key` declared in `valueFlags` → consumes the next token as the value
 *      UNCONDITIONALLY, even one that looks like a flag (the runner's
 *      historical `--seed` contract); a trailing declared value flag records
 *      the empty string so the caller can tell "seen without value" from
 *      "absent".
 *   4. undeclared → the greedy heuristic: `--key value` when the next token
 *      does not start with `--`, else bare `--key` → "true". With
 *      `undeclared: 'discard'` the token is instead dropped without touching
 *      `flags` or the next token — the runner's warn-and-discard contract,
 *      where an unknown flag must never eat the goal.
 *
 * Every occurrence of an undeclared flag is also reported in order in
 * `undeclaredFlags` (with its `--` prefix), so a caller with a CLOSED flag
 * set can warn per occurrence without re-tokenizing argv.
 */

export interface ParsedCli {
  readonly command: string | null;
  readonly positional: string[];
  readonly flags: Record<string, string>;
  /** Ordered occurrences (with `--` prefix) of flags matching no declaration. */
  readonly undeclaredFlags: readonly string[];
}

export interface CliGrammar {
  /** Flags that never consume the next token; bare presence → "true". */
  readonly booleanFlags?: readonly string[];
  /** Boolean flags that ALSO accept an explicit `--no-<flag>` → "false". */
  readonly negatableFlags?: readonly string[];
  /** Flags that always consume the next token, even a `--`-looking one. */
  readonly valueFlags?: readonly string[];
  /** How an undeclared flag behaves: greedy (default) or discarded. */
  readonly undeclared?: 'greedy' | 'discard';
}

/**
 * Core tokenizer over an ALREADY-SLICED token list. The runner calls this
 * directly because its argv arrives pre-sliced from `runTask`; process CLIs
 * use `parseCliArgs`, which slices `process.argv` first. One grammar, two
 * entrypoints — never a second tokenizer.
 */
export function parseArgTokens(
  tokens: readonly string[],
  grammar: CliGrammar = {}
): ParsedCli {
  const booleans = new Set([
    ...(grammar.booleanFlags ?? []),
    ...(grammar.negatableFlags ?? []),
  ]);
  const negatable = new Set(grammar.negatableFlags ?? []);
  const values = new Set(grammar.valueFlags ?? []);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const undeclaredFlags: string[] = [];
  let command: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (booleans.has(key)) {
        flags[key] = 'true';
      } else if (key.startsWith('no-') && negatable.has(key.slice(3))) {
        flags[key.slice(3)] = 'false';
      } else if (values.has(key)) {
        flags[key] = tokens[i + 1] ?? '';
        i++;
      } else {
        undeclaredFlags.push(token);
        if (grammar.undeclared === 'discard') continue;
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = 'true';
        }
      }
    } else if (command === null) {
      command = token;
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags, undeclaredFlags };
}

export function parseCliArgs(argv: readonly string[], grammar: CliGrammar = {}): ParsedCli {
  return parseArgTokens(argv.slice(2), grammar);
}
