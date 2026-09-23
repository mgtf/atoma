import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SUBSYSTEM_LINE_BUDGET,
  SUBSYSTEM_LINE_BUDGET_OVERRIDES,
  hasIntentionalChoices,
  INTENTIONAL_CHOICES_HEADING,
  repoRelativeIfInside,
  subsystemLineBudget,
  toPosix,
} from '../scripts/agent-docs-predicates.mjs';

const checkerPath = fileURLToPath(new URL('../scripts/check-agent-docs.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Regression coverage for 2026-08-31: check-agent-docs.mjs had two separator
// bugs that only fire on a win32 host — a `repoRoot + '/'` prefix test that
// classified EVERY Markdown link as escaping the repository, and a POSIX-keyed
// budget-override lookup queried with a raw win32 `relative()` result, so the
// src/viz exception never applied. CI runs on ubuntu-latest only, which is
// exactly why both survived: the platform has to be an INPUT for Linux to
// exercise the Windows shape. `path.win32` and `path.posix` are those inputs.

describe('docs:check, across the process boundary it ships as', () => {
  it('passes against this repository on this host', () => {
    const result = spawnSync(process.execPath, [checkerPath], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^agent docs ok: /);
  });
});

describe('link containment', () => {
  it('accepts a repo-internal link on a Windows-shaped root', () => {
    // The 2026-08-31 shape: `C:\repo\docs\...` never starts with `C:\repo/`,
    // so the old prefix test failed the FIRST link of AGENTS.md.
    expect(
      repoRelativeIfInside('C:\\repo', 'C:\\repo\\docs\\incidents\\record.md', win32),
    ).toBe('docs/incidents/record.md');
  });

  it('still rejects a genuine escape on a Windows-shaped root', () => {
    expect(repoRelativeIfInside('C:\\repo', 'C:\\outside.md', win32)).toBeNull();
    expect(repoRelativeIfInside('C:\\repo', 'C:\\other\\docs\\x.md', win32)).toBeNull();
  });

  it('rejects a cross-drive link, which win32 relative() reports as absolute, not as ..', () => {
    expect(repoRelativeIfInside('C:\\repo', 'D:\\repo\\docs\\x.md', win32)).toBeNull();
  });

  it('rejects a sibling directory whose name merely extends the root', () => {
    // The one case the old prefix test genuinely guarded: without the '/',
    // 'C:\repository' would have prefix-matched 'C:\repo'. relative() walks
    // out ('..\repository\x.md'), so the guarantee survives the fix.
    expect(repoRelativeIfInside('C:\\repo', 'C:\\repository\\x.md', win32)).toBeNull();
    expect(repoRelativeIfInside('/repo', '/repository/x.md', posix)).toBeNull();
  });

  it('behaves identically on a POSIX root', () => {
    expect(repoRelativeIfInside('/repo', '/repo/docs/x.md', posix)).toBe('docs/x.md');
    expect(repoRelativeIfInside('/repo', '/outside.md', posix)).toBeNull();
  });
});

describe('subsystem line budgets', () => {
  it('pins the policy values, so a budget change is a conscious test change', () => {
    expect(SUBSYSTEM_LINE_BUDGET).toBe(500);
  });

  it('requires the intentional-choices heading in EVERY subsystem doc', () => {
    // The root contract asserts this as fact, and on 2026-09-23 it was false
    // for eight of eighteen files with nothing checking it. The cost is not
    // tidiness: `proposedFix.checkedIntentionalChoices` is required of the
    // analyst, so a subsystem with no such section could never produce a
    // mender-eligible defect.
    const docs = globSync('src/*/AGENTS.md', { cwd: repoRoot }).sort();
    expect(docs.length).toBeGreaterThan(10);
    const missing = docs.filter(
      (doc) => !hasIntentionalChoices(readFileSync(join(repoRoot, doc), 'utf8')),
    );
    expect(missing).toEqual([]);
  });

  it('matches the heading exactly, not a prefix of it', () => {
    // Two files carried a truncated '## Intentional choices' until 2026-09-23.
    // A predicate that accepted the prefix would have left the catalogue with
    // two spellings of one section, which is the opposite of what a reader
    // told to go find it needs.
    expect(hasIntentionalChoices(`# doc\n\n${INTENTIONAL_CHOICES_HEADING}\n\n- a\n`)).toBe(true);
    expect(hasIntentionalChoices('# doc\n\n## Intentional choices\n\n- a\n')).toBe(false);
    expect(hasIntentionalChoices(`# doc\n\ntext ${INTENTIONAL_CHOICES_HEADING} inline\n`)).toBe(false);
  });

  it('keys every override in POSIX, the shape the lookup normalises to', () => {
    // The 2026-08-31 bug in mirror image: an override added with backslashes
    // would never match on ANY platform, silently re-imposing the default.
    for (const key of SUBSYSTEM_LINE_BUDGET_OVERRIDES.keys()) {
      expect(key).toBe(toPosix(key));
    }
  });

  it('resolves the src/viz exception on a Windows-shaped root', () => {
    // The second 2026-08-31 bug: the Map is keyed 'src/viz/AGENTS.md', and a
    // raw win32 relative() ('src\\viz\\AGENTS.md') missed it, re-imposing the
    // 500-line default on a 569-line file.
    expect(subsystemLineBudget('C:\\repo', 'C:\\repo\\src\\viz\\AGENTS.md', win32)).toBe(660);
  });

  it('resolves the same exception on a POSIX root', () => {
    expect(subsystemLineBudget('/repo', '/repo/src/viz/AGENTS.md', posix)).toBe(660);
  });

  it('gives every other subsystem the default, on either root shape', () => {
    expect(subsystemLineBudget('C:\\repo', 'C:\\repo\\src\\atoms\\AGENTS.md', win32)).toBe(
      SUBSYSTEM_LINE_BUDGET,
    );
    expect(subsystemLineBudget('/repo', '/repo/src/atoms/AGENTS.md', posix)).toBe(
      SUBSYSTEM_LINE_BUDGET,
    );
  });
});

describe('toPosix', () => {
  it('maps win32 separators and leaves POSIX paths alone', () => {
    expect(toPosix('src\\viz\\AGENTS.md')).toBe('src/viz/AGENTS.md');
    expect(toPosix('src/viz/AGENTS.md')).toBe('src/viz/AGENTS.md');
  });
});
