import { describe, it, expect } from 'vitest';
import { parseArgTokens, parseCliArgs } from '../src/cli/args.js';

describe('shared CLI parser — flags anywhere (audit: silent-help failure)', () => {
  it('the DOCUMENTED flag-first form parses: registry --db x.db list', () => {
    const p = parseCliArgs(['node', 'cli', '--db', './x.db', 'list']);
    expect(p.command).toBe('list');
    expect(p.flags['db']).toBe('./x.db');
  });

  it('command-first form unchanged, with mixed flags and positionals', () => {
    const p = parseCliArgs(['node', 'cli', 'show', 'Methane', '--dir', './s', 'my-skill']);
    expect(p.command).toBe('show');
    expect(p.positional).toEqual(['Methane', 'my-skill']);
    expect(p.flags['dir']).toBe('./s');
  });

  it('bare flags become "true"; empty argv yields null command', () => {
    expect(parseCliArgs(['n', 'c', 'remove', 'X', '--force']).flags['force']).toBe('true');
    expect(parseCliArgs(['n', 'c']).command).toBeNull();
  });
});

describe('declared boolean flags — never consume the next token', () => {
  it('skills drop --force <l1> <id> keeps both positionals', () => {
    const p = parseCliArgs(['n', 'c', 'drop', '--force', 'Methane', 'skill-1'], {
      booleanFlags: ['force'],
    });
    expect(p.command).toBe('drop');
    expect(p.flags['force']).toBe('true');
    expect(p.positional).toEqual(['Methane', 'skill-1']);
  });

  it('flag-before-command no longer eats the command: registry --apply dedupe', () => {
    const p = parseCliArgs(['n', 'c', '--apply', 'dedupe'], { booleanFlags: ['apply'] });
    expect(p.command).toBe('dedupe');
    expect(p.flags['apply']).toBe('true');
  });

  it('an UNDECLARED flag keeps the greedy grammar next to a declared one', () => {
    const p = parseCliArgs(['n', 'c', 'list', '--force', '--db', './x.db'], {
      booleanFlags: ['force'],
    });
    expect(p.flags['force']).toBe('true');
    expect(p.flags['db']).toBe('./x.db');
    expect(p.undeclaredFlags).toEqual(['--db']);
  });
});

describe('negatable flags — --no-<flag> is honored ONLY where declared', () => {
  it('--no-baseline writes flags.baseline="false" without consuming', () => {
    const p = parseArgTokens(['--no-baseline', 'the goal'], { negatableFlags: ['baseline'] });
    expect(p.flags['baseline']).toBe('false');
    expect(p.command).toBe('the goal');
  });

  it('the LAST spelling wins in either direction', () => {
    const g = { negatableFlags: ['baseline'] } as const;
    expect(parseArgTokens(['--no-baseline', '--baseline'], g).flags['baseline']).toBe('true');
    expect(parseArgTokens(['--baseline', '--no-baseline'], g).flags['baseline']).toBe('false');
  });

  it('a non-negatable boolean does NOT materialize its key from --no-: force stays absent', () => {
    // skills tests `'force' in flags`; an auto-negated `--no-force` writing
    // flags.force="false" would have INVERTED the check to force=on.
    const p = parseArgTokens(['drop', '--no-force', 'X', 'Y'], { booleanFlags: ['force'] });
    expect('force' in p.flags).toBe(false);
    // Undeclared → greedy grammar applies to the no- spelling itself.
    expect(p.flags['no-force']).toBe('X');
    expect(p.undeclaredFlags).toEqual(['--no-force']);
  });
});

describe('declared value flags — consume the next token unconditionally', () => {
  it('takes even a --looking token as the value (runner --seed contract)', () => {
    const p = parseArgTokens(['--seed', '--weird-dir', 'the goal'], { valueFlags: ['seed'] });
    expect(p.flags['seed']).toBe('--weird-dir');
    expect(p.command).toBe('the goal');
    expect(p.undeclaredFlags).toEqual([]);
  });

  it('a trailing declared value flag records the empty string, not "true"', () => {
    expect(parseArgTokens(['--seed'], { valueFlags: ['seed'] }).flags['seed']).toBe('');
  });
});

describe('undeclared: "discard" — warn-and-discard material for a closed flag set', () => {
  it('drops the flag WITHOUT eating the following positional', () => {
    const p = parseArgTokens(['--bogus', 'the goal'], { undeclared: 'discard' });
    expect(p.command).toBe('the goal');
    expect('bogus' in p.flags).toBe(false);
    expect(p.undeclaredFlags).toEqual(['--bogus']);
  });

  it('reports every occurrence in order, with the -- prefix', () => {
    const p = parseArgTokens(['--a', '--b', '--a'], { undeclared: 'discard' });
    expect(p.undeclaredFlags).toEqual(['--a', '--b', '--a']);
  });
});
