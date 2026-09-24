import { dirname, basename, join } from 'node:path';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { inheritProbeManifest, PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';

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


/** What `seedWorkspace` copied, for the launch log. */
export interface SeedReport {
  /** Top-level entries of the seeded workspace. */
  readonly entries: number;
  /**
   * What happened to the inherited probe manifest: `absent` (the seed had
   * none), `kept` (byte-identical), `filtered` (unreplayable entries dropped),
   * `removed` (nothing replayable left, or not a regular file).
   */
  readonly manifest: 'absent' | 'kept' | 'filtered' | 'removed';
  readonly kept: number;
  readonly dropped: number;
  readonly problems: readonly string[];
}

/**
 * The ONE seed copy, used at launch and again when a seeded run deepens.
 *
 * A seed is the state a run starts from. Depth routing restarts a deepening
 * attempt "fresh" (decided 2026-09-13 for runs that carried no seed); since
 * 2026-09-23 every project run is seeded AND depth-routed, and a restart over
 * an empty directory rebuilt the project's whole corpus from nothing — then
 * seeded the next run from that. Fresh, for a seeded run, means the seed.
 *
 * The inherited `.atoma-probes.json` is filtered through
 * `inheritProbeManifest`: kept as a replay baseline, minus every entry no
 * reader can replay. The seed source is never modified.
 */
export function seedWorkspace(seedRoot: string, workspaceRoot: string): SeedReport {
  mkdirSync(workspaceRoot, { recursive: true });
  cpSync(seedRoot, workspaceRoot, { recursive: true });
  const entries = readdirSync(workspaceRoot).length;
  const manifestPath = join(workspaceRoot, PROBE_MANIFEST_FILENAME);
  let stat;
  try {
    stat = lstatSync(manifestPath);
  } catch {
    return { entries, manifest: 'absent', kept: 0, dropped: 0, problems: [] };
  }
  if (!stat.isFile()) {
    // A symlinked or special manifest is never followed: rewriting it would
    // write wherever the link points.
    rmSync(manifestPath, { recursive: true, force: true });
    return { entries, manifest: 'removed', kept: 0, dropped: 0, problems: ['not a regular file'] };
  }
  const inherited = inheritProbeManifest(readFileSync(manifestPath, 'utf8'));
  const problems = inherited.unreadable ? ['not a readable version-1 manifest'] : inherited.problems;
  if (inherited.text === null) {
    rmSync(manifestPath, { force: true });
    return { entries, manifest: 'removed', kept: 0, dropped: inherited.dropped, problems };
  }
  if (inherited.dropped === 0) {
    return { entries, manifest: 'kept', kept: inherited.kept, dropped: 0, problems: [] };
  }
  writeFileSync(manifestPath, inherited.text);
  return { entries, manifest: 'filtered', kept: inherited.kept, dropped: inherited.dropped, problems };
}

/** The launch-log line for a seed manifest that changed, or null when none did. */
export function describeSeedManifest(report: SeedReport): string | null {
  if (report.manifest === 'absent' || report.manifest === 'kept') return null;
  const detail = report.problems.length > 0 ? ` — ${report.problems.join('; ')}` : '';
  return report.manifest === 'removed'
    ? `seed ${PROBE_MANIFEST_FILENAME}: not inherited, nothing replayable (${report.dropped} entries dropped)${detail}`
    : `seed ${PROBE_MANIFEST_FILENAME}: kept ${report.kept} entries, dropped ${report.dropped} unreplayable${detail}`;
}
