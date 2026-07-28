import { dirname, basename, join } from 'node:path';
import { existsSync, readdirSync, renameSync } from 'node:fs';

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
export function prepareWorkspace(root: string, clean: boolean): void {
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

