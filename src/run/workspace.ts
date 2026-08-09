import { dirname, basename, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Stale artefacts from PREVIOUS runs pollute the current one. They land in
 * the read-back probe's `list_files` evidence block, and a phase that ends
 * with "confirm exactly <these files> exist" can legitimately flag them.
 * Measured on the csv2json run: the workspace still held `server.js`,
 * `data.db`, `views/` and a 180-entry `node_modules/` from an SSR run three
 * months earlier.
 *
 * Default behaviour is to WARN, never to touch the directory: the workspace
 * holds the user's deliverable and this example has no way to know whether
 * it has been collected yet. `--clean-workspace` ARCHIVES by rename rather
 * than deleting, for the same reason — a wrong call stays recoverable.
 */
/**
 * Node resolves a `.js` file's module system by walking UP from the file
 * until it finds a package.json — and the workspace lives under the atoma
 * repo, whose package.json says `"type": "module"`. A task that ships
 * CommonJS `.js` files WITHOUT its own package.json therefore crashes with
 * "require is not defined in ES module scope" — because of a file that sits
 * OUTSIDE the sandbox jail and outside every prompt's view. Measured on the
 * HTTP burn-in batches (2026-08-07): 8/10 runs wrote no local package.json,
 * and exactly the ones whose L1 happened to pick the CommonJS style crashed
 * and had to convert to ESM in-loop — an unfixable-from-inside environment
 * leak that no skill can learn its way around (each run's self-repair is
 * locally correct and leaves nothing durable behind).
 *
 * The fix is a SENTINEL package.json (`{}` — no "type", i.e. the exact
 * default a standalone folder would have) in the workspace's PARENT, which
 * stops Node's walk before it reaches the repo's. The parent is
 * harness-owned (`build/` — the same place prepareWorkspace puts archives),
 * and a task that writes its own package.json still wins, being closer.
 * Guarded to write ONLY when the nearest package.json above the parent
 * actually carries `"type": "module"` — in innocent layouts (no ancestor
 * package.json, or a CJS one) the sentinel would change nothing, so we
 * never touch directories that aren't ours to fix.
 */
export function ensureModuleResolutionBoundary(root: string): void {
  const parent = dirname(root);
  if (parent === root) return; // filesystem root — nowhere to fence
  const sentinel = join(parent, 'package.json');
  if (existsSync(sentinel)) return; // parent already IS a boundary
  // Find the nearest ancestor package.json strictly above the parent.
  let dir = dirname(parent);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      let hazardous = false;
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { type?: string };
        hazardous = parsed.type === 'module';
      } catch {
        // Unreadable/invalid ancestor manifest: Node would fail loudly on it
        // anyway; not this helper's problem.
      }
      if (hazardous) {
        // First run: the harness-owned parent may not exist yet (the sandbox
        // mkdirs the workspace AFTER prepareWorkspace runs).
        mkdirSync(parent, { recursive: true });
        writeFileSync(sentinel, '{}\n');
      }
      return; // nearest ancestor decides — hazardous or not, we're done
    }
    const up = dirname(dir);
    if (up === dir) return; // reached the filesystem root: no ancestor manifest
    dir = up;
  }
}

export function prepareWorkspace(root: string, clean: boolean): void {
  ensureModuleResolutionBoundary(root);
  if (!existsSync(root)) return;
  const stale = readdirSync(root);
  if (stale.length === 0) return;
  if (!clean) {
    const shown = stale.slice(0, 8).join(', ');
    console.log(
      `⚠ workspace is not empty (${stale.length} entries: ${shown}${stale.length > 8 ? ', …' : ''})`
    );
    console.log(
      '  stale artefacts appear in verification evidence — pass --clean-workspace to archive them'
    );
    return;
  }
  // A monotonic suffix keeps repeated archives distinct without a clock
  // (and without ever overwriting an earlier archive).
  const parent = dirname(root);
  const base = basename(root);
  let n = 1;
  while (existsSync(join(parent, `${base}.prev${n}`))) n++;
  const archived = join(parent, `${base}.prev${n}`);
  renameSync(root, archived);
  console.log(`workspace archived: ${archived} (${stale.length} entries) — starting clean`);
}

