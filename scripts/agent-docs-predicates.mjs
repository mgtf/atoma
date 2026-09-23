/**
 * agent-docs-predicates.mjs — the separator-sensitive decisions of
 * `check-agent-docs.mjs`, in ONE importable place. The checker itself runs at
 * module scope and exits the process, so importing it from a test would RUN
 * it (the same reason `i18n-predicates.mjs` exists beside `i18n.mjs`).
 *
 * Why these two functions are worth a module: both broke on Windows on
 * 2026-08-31, in the same file, in the same silent way — `resolve()` emits
 * backslashes on win32, so a `repoRoot + '/'` prefix test never matched (every
 * link "escaped the repository") and a POSIX-keyed Map lookup never hit (the
 * src/viz budget exception vanished). CI runs on ubuntu-latest only, so
 * neither could be caught behaviorally there — unless the platform is an
 * argument. Each predicate therefore takes a `pathImpl` so
 * `tests/check-agent-docs.test.ts` can exercise the Windows shape from any
 * host; production callers omit it and get the host implementation.
 */

import { isAbsolute, relative } from 'node:path';

/** Repo-relative paths are compared and mapped as POSIX, whatever the host. */
export function toPosix(path) {
  return path.split('\\').join('/');
}

/**
 * The repo-relative POSIX path of `resolvedPath` when it lies inside
 * `repoRoot`, or null when it escapes. `relative()` instead of a string-prefix
 * test: a prefix built with '/' never matches a win32 `resolve()` result, and
 * `isAbsolute` is load-bearing too — on win32, `relative()` across drives
 * returns the target absolute path, not a `..` walk.
 */
export function repoRelativeIfInside(repoRoot, resolvedPath, pathImpl = { relative, isAbsolute }) {
  const rel = pathImpl.relative(repoRoot, resolvedPath);
  if (rel.startsWith('..') || pathImpl.isAbsolute(rel)) return null;
  return toPosix(rel);
}

// 300 until 2026-08-23, when src/viz sat AT the cap while the next largest
// subsystem file was 175 lines: the limit had stopped shaping the split and
// started shaping SENTENCES, condensing new rules until they lost their
// reasons. A subsystem file is read only by an agent opening that subtree, so
// the pressure it needs is "one subsystem, one file", not a word count.
export const SUBSYSTEM_LINE_BUDGET = 500;
// src/viz owns more surfaces than any other subtree (trace projection, the GPU
// client, the frozen MUI fallback, the gated HTTP surfaces, push, and the i18n
// catalog contract). Splitting it further would mean inventing sub-subsystems
// that no agent opens on its own, so it carries a named, explicit exception
// rather than a silently raised global budget.
// src/preview is the second, for the same reason and on the same terms: one
// subtree that owns deliverable classification, the byte policy, the
// materialised copy, instance state and generations, container lifecycle, its
// own image, an all-or-nothing configuration with two named development
// profiles, the origin/claim/grant protocol, the response policy, egress
// approval, the HTTP surface and the client surface. There is no sub-subsystem
// an agent opens on its own, so the alternative to this line was shaving
// sentences until rules lost the reasons they exist for — the exact failure
// the 2026-08-23 note above records.
// 2026-09-18: src/viz sat AT its 600 cap when the handheld gate rule landed
// (one line). Raised to 620 for the same reason as above rather than
// condensing an unrelated rule to make room; a test pins the number so the
// next raise is a conscious change too.
// 2026-09-23: 620 → 660, the conscious raise that comment asked for. Every
// subsystem doc now owes an intentional-choices section (see
// `INTENTIONAL_CHOICES_HEADING` below), and src/viz was the one file with no
// room for its own. The alternative was again to shave unrelated rules, on
// the largest subtree, to make space for the section that exists to keep
// rules from being re-proposed.
export const SUBSYSTEM_LINE_BUDGET_OVERRIDES = new Map([
  ['src/viz/AGENTS.md', 660],
  ['src/preview/AGENTS.md', 560],
]);

/**
 * The heading every subsystem doc must carry.
 *
 * The root AGENTS.md states it as fact — "Every subsystem file carries its own
 * intentional-choices section listing the shortcuts already tried and reverted
 * there" — and on 2026-09-23 it was false for eight of eighteen files, with
 * nothing checking it. That gap is not cosmetic: the analyst's `proposedFix`
 * REQUIRES naming the intentional-choices section it read
 * (`checkedIntentionalChoices`), and a proposal without one is refused, so a
 * finding landing in a subsystem with no such section could never become a
 * mender-eligible defect. A missing section silently removed a subsystem from
 * the repair loop.
 */
export const INTENTIONAL_CHOICES_HEADING = '## Intentional choices and rejected shortcuts';

/** True when a subsystem doc carries the heading above, at the start of a line. */
export function hasIntentionalChoices(text) {
  return text.split('\n').some((line) => line.trimEnd() === INTENTIONAL_CHOICES_HEADING);
}

/**
 * The line budget for one subsystem doc. The override Map is keyed in POSIX,
 * so the lookup normalises the host-relative path before asking — passing a
 * raw win32 `relative()` result is exactly the 2026-08-31 regression.
 */
export function subsystemLineBudget(repoRoot, docPath, pathImpl = { relative }) {
  const shown = toPosix(pathImpl.relative(repoRoot, docPath));
  return SUBSYSTEM_LINE_BUDGET_OVERRIDES.get(shown) ?? SUBSYSTEM_LINE_BUDGET;
}
