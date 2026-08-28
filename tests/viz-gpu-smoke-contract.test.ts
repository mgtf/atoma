import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE BROWSER SMOKE NAMES CONTROLS THAT MUST EXIST.
 *
 * `scripts/viz-gpu-smoke.mjs` drives a real Chrome and asserts on hit targets
 * BY ID. Since 2026-08-24 it is out of `release:check` and out of CI (on the
 * runner's CPU rasteriser it failed on its own frame timing rather than on the
 * change under test), so an id it asks for can stop existing and nothing says
 * so until someone runs the smoke by hand.
 *
 * That happened: the i18n commit of 2026-08-27 renamed the locale control from
 * `locale.toggle` to `locale.menu.toggle` and did not touch the smoke, which
 * then looked for a name nothing records and failed its focused-rail assertion
 * — a whole day of viz work later. The rename was correct; the silence was
 * not.
 *
 * A SOURCE SCAN, which this repo permits exactly here: the property is that
 * two files agree on a name, the observing test cannot run a browser, and
 * nothing else in `npm run check` loads either file. It proves the ids MATCH,
 * never that the controls behave — that stays `npm run viz:smoke` on a machine
 * with a real GPU.
 */

const REPO_ROOT = process.cwd();
const SMOKE = join(REPO_ROOT, 'scripts', 'viz-gpu-smoke.mjs');
const RENDERER = join(REPO_ROOT, 'src', 'viz', 'client-gl', 'gpu-renderer.ts');

/** Every client-GL source, since a control may be recorded by any view. */
function clientGlSources(dir = join(REPO_ROOT, 'src', 'viz', 'client-gl'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) clientGlSources(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(readFileSync(full, 'utf8'));
  }
  return out;
}

/**
 * Is this id one the renderer can produce? Either verbatim, or COMPOSED — an
 * id like `nav.runs` or `run.filter.kind.llm` is built from a template whose
 * literal half is a prefix ending at a dot. Both forms count; an id matching
 * neither is a name nothing records.
 */
function idIsRecorded(id: string, sources: string): boolean {
  if (sources.includes(`'${id}'`)) return true;
  const parts = id.split('.');
  for (let take = parts.length - 1; take >= 1; take -= 1) {
    const prefix = parts.slice(0, take).join('.');
    if (sources.includes(`\`${prefix}.\${`)) return true;
  }
  return false;
}

/**
 * Every control id the smoke names as a literal — the four shapes it asks with.
 * Ids the smoke itself only matches by PREFIX (`startsWith('nav.')`) are not
 * collected: there is no single name to check.
 */
function smokeControlIds(smoke: string): string[] {
  const ids = new Set<string>();
  for (const match of smoke.matchAll(/control\('([^']+)'\)/g)) ids.add(match[1]!);
  for (const match of smoke.matchAll(/entry\.id === '([^']+)'/g)) ids.add(match[1]!);
  for (const match of smoke.matchAll(/clickTarget\('([^']+)'\)/g)) ids.add(match[1]!);
  for (const match of smoke.matchAll(/waitForHitTarget\(page, '([^']+)'/g)) ids.add(match[1]!);
  return [...ids].sort();
}

describe('the browser smoke and the renderer agree on control ids', () => {
  it('every id the smoke asks for is one the renderer records', () => {
    const smoke = readFileSync(SMOKE, 'utf8');
    const sources = clientGlSources().join('\n');
    const ids = smokeControlIds(smoke);
    // A guard that found nothing to guard would pass forever in silence.
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids).toContain('locale.menu.toggle');
    expect(ids).toContain('account.menu.toggle');

    const missing = ids.filter((id) => !idIsRecorded(id, sources));
    expect(missing).toEqual([]);
    // The composed form must not become a hole the literal check hides in:
    // an id no source can build, verbatim or by template, still fails.
    expect(idIsRecorded('locale.toggle', sources)).toBe(false);
    expect(idIsRecorded('nav.runs', sources)).toBe(true);
  });

  it('the smoke reads the gutter the way the renderer draws it', () => {
    // Second divergence of the same class and the same week: 831654e made
    // focus deliberately gutter-less (no header seam to wash, and a wash
    // there reads as a second frame edge under the rounded corner) while the
    // smoke kept asserting the OVERVIEW shape. Pinned as a pair so the next
    // change to one has to look at the other.
    const helper = readFileSync(
      join(REPO_ROOT, 'src', 'viz', 'client-gl', 'renderer', 'view-frame.ts'),
      'utf8'
    );
    expect(helper).toMatch(/if \(focused\) return \[\];/);
    const smoke = readFileSync(SMOKE, 'utf8');
    expect(smoke).toContain('gutterPresent');
    expect(smoke).not.toContain('gutterIsViewportFirstChild');
  });

  it('the renderer names the two chrome menus the same way', () => {
    // The rename that broke the smoke was itself right — `locale.toggle` was
    // the odd one out beside `account.menu.toggle`. Pinning the pair keeps a
    // future rename from splitting them again.
    const renderer = readFileSync(RENDERER, 'utf8');
    expect(renderer).toContain(`'locale.menu.toggle'`);
    expect(renderer).toContain(`'account.menu.toggle'`);
    expect(renderer).not.toMatch(/'locale\.toggle'/);
  });
});
