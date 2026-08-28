import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABANDONED_AFTER_MS, isIndexEntryLive, isRunLive } from '../src/viz/liveness.js';
import * as runUtils from '../src/viz/client/run-utils.js';

/**
 * THE VITE BUNDLE BOUNDARY. `npm run viz:build` empties `dist/viz/client/` and
 * fills it with hashed assets, so the `.js` that `tsc` emitted there is GONE
 * by the end of `npm run build`. Any server-side module importing from
 * `src/viz/client/` therefore resolves nothing at runtime — and nothing in
 * typecheck, lint or `tests/` can see it, because they all run from source.
 *
 * Measured: the sentinel's operator source imported `isIndexEntryLive` from
 * `client/run-utils.js` (as `watch.ts` had, harmlessly, while only `tsx` ever
 * loaded it). The moment the compiled viz server imported that source for its
 * sentinel endpoint, `node dist/viz/server.js` died with ERR_MODULE_NOT_FOUND
 * and the GPU smoke could not even connect.
 *
 * The behavioural proof is `npm run viz:smoke`, which needs a real Chrome and
 * so cannot live here — and since 2026-08-24 it is no longer in
 * `release:check` either, so this guard is now the ONLY automatic one. That
 * raises its stakes rather than lowering them: a source scan, which the repo
 * permits for an architectural boundary that source-running tests cannot
 * otherwise observe, failing in the same commit as the mistake.
 */

const CLIENT_PREFIX = join('src', 'viz', 'client') + '/';
// The suite runs from the repository root (vitest's cwd), like the scan below.
const REPO_ROOT = process.cwd();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** `from '<spec>'` for every import/export that is NOT type-only. */
function runtimeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+([^;]*?)from\s+'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[2] ?? '';
    // `import type { … }` and `export type { … }` are erased entirely.
    if (/^type\s/.test(clause.trim())) continue;
    specifiers.push(match[3]!);
  }
  return specifiers;
}

describe('the Vite bundle boundary', () => {
  it('has no server-side runtime import from src/viz/client/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const normalised = file.replace(/\\/g, '/');
      // The client and the GL client are bundled together: they may import
      // each other, and the shared modules under `client/` are library code
      // for exactly that.
      if (normalised.startsWith('src/viz/client/')) continue;
      if (normalised.startsWith('src/viz/client-gl/')) continue;
      for (const specifier of runtimeImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const resolved = relative(process.cwd(), resolve(dirname(file), specifier));
        if (resolved.replace(/\\/g, '/').startsWith(CLIENT_PREFIX.replace(/\\/g, '/'))) {
          offenders.push(`${normalised} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every root module out of the dev proxy prefixes it matches by', () => {
    // 2026-08-27, finding 3.7. The dev server proxies by PREFIX (`/api`,
    // `/auth`, `/webhooks`), and Vite serves root modules at `/<name>.ts`, so a
    // root file whose name starts with a proxied prefix is swallowed by the
    // proxy and 404s in dev only — the failure `cae2bfa` fixed by renaming
    // `api-*.ts`. Nothing mechanical stopped the next one.
    const config = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const prefixes = [...config.matchAll(/'(\/[a-z]+)':\s*`http/g)].map((match) => match[1]!);
    // The list is read from the config, not restated here: a fourth proxy
    // entry must extend this guard by existing, not by being remembered.
    expect(prefixes).toContain('/api');
    expect(prefixes.length).toBeGreaterThanOrEqual(3);
    const clientRoots = ['client', 'client-gl'].flatMap((name) => {
      const dir = resolve(REPO_ROOT, 'src', 'viz', name);
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${name}/${entry.name}`);
    });
    const swallowed = clientRoots.filter((file) => {
      const base = file.slice(file.indexOf('/') + 1);
      return prefixes.some((prefix) => base.startsWith(prefix.slice(1)));
    });
    expect(swallowed).toEqual([]);
  });

  it('keeps ONE definition of the live predicates behind both import paths', () => {
    // `client/run-utils.ts` re-exports them so every browser call site is
    // unchanged. Same function object, not a copy: two copies of a threshold
    // is how one becomes 12 minutes and the other 15.
    expect(runUtils.isIndexEntryLive).toBe(isIndexEntryLive);
    expect(runUtils.isRunLive).toBe(isRunLive);
    expect(runUtils.ABANDONED_AFTER_MS).toBe(ABANDONED_AFTER_MS);
    expect(ABANDONED_AFTER_MS).toBe(12 * 60 * 1000);
  });
});
