import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../src/cli/args.js';

describe('shared CLI parser — flags anywhere (audit: silent-help failure)', () => {
  it('the DOCUMENTED flag-first form parses: registry --db x.db list', () => {
    const p = parseCliArgs(['node', 'cli', '--db', './x.db', 'list']);
    expect(p.command).toBe('list');
    expect(p.flags['db']).toBe('./x.db');
  });

  it('command-first form unchanged, with mixed flags and positionals', () => {
    const p = parseCliArgs(['node', 'cli', 'show', 'Helium', '--dir', './s', 'my-skill']);
    expect(p.command).toBe('show');
    expect(p.positional).toEqual(['Helium', 'my-skill']);
    expect(p.flags['dir']).toBe('./s');
  });

  it('bare flags become "true"; empty argv yields null command', () => {
    expect(parseCliArgs(['n', 'c', 'remove', 'X', '--force']).flags['force']).toBe('true');
    expect(parseCliArgs(['n', 'c']).command).toBeNull();
  });
});
