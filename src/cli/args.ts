/**
 * Shared CLI argument parser for the atoma CLIs (registry, skills, ledger).
 *
 * Fixes the flag-before-command bug each CLI had independently: the old
 * per-CLI parsers took `rest[0]` as the command unconditionally, so the
 * DOCUMENTED form `registry --db ./x.db list` parsed "--db" as an unknown
 * command and fell into help — with exit code 0, so scripts kept going on
 * a no-op (silent-help failure). This parser scans for the FIRST
 * non-flag-position token as the command, letting flags appear anywhere.
 *
 * Flag grammar (unchanged): `--key value` (value = next token when it does
 * not start with `--`), bare `--key` → "true".
 */

export interface ParsedCli {
  readonly command: string | null;
  readonly positional: string[];
  readonly flags: Record<string, string>;
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const rest = argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let command: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else if (command === null) {
      command = token;
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}
