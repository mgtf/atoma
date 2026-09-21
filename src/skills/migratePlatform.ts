import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openLedgerHandle } from '../core/ledger.js';
import { ProjectStore } from '../projects/store.js';
import { LEGACY_META_FILENAME, SkillRegistry, parseFrontmatter, readMetaChecked } from './registry.js';

/**
 * ONE catalog, ONE trust (`docs/platform-trust-2026-09-15.md`). The folds
 * below bring every earlier partition into it, each one idempotent and each
 * one keeping what it displaces beside the catalog rather than deleting it:
 *   - `migratePlatformSkills` — the per-project skill trees of the 2026-09-09
 *     layout: bodies copied once, counters ADDED to the catalog's;
 *   - `foldScopedSkillTrust` — the `.trust/<project>/<sha>/` sidecars of the
 *     2026-09-15 morning layout: counters added to the catalog's row;
 *   - `foldMergedNamespaces` — recipes learned under an atom identity the
 *     registry fold ABSORBED into a same-name row (`atom_id_merges`): moved
 *     under the kept identity, rows re-keyed, duplicates summed.
 *
 * Since 2026-09-18 (W4) the catalog's counters are ROWS in the product store,
 * so every fold takes a WRITABLE handle on it and goes through
 * `SkillRegistry`, whose single mutation path seeds a recipe's row from its
 * own unimported sidecar before adding to it — a fold that wrote a row
 * directly would win the race against the import and lose the public
 * sidecar's counters for good. The legacy trees themselves are read with
 * `sidecarsOnly`: a per-project tree shares the catalog's row keys and must
 * never be confused with it.
 */

/** The writable store handle a fold needs, from a handle or a path. */
function storeHandle(db: Database.Database | string): Database.Database {
  return typeof db === 'string' ? openLedgerHandle(db) : db;
}

/** Copy preserved project recipes into the commons; never delete or overwrite originals. */
export function migratePlatformSkills(input: { dbPath: string; projectsRoot: string; skillsRoot: string }): number {
  const db = openLedgerHandle(input.dbPath);
  const projects = new ProjectStore(db, { initialize: false }).listAllProjects();
  const catalog = new SkillRegistry(input.skillsRoot, { db });
  let imported = 0;
  for (const project of projects) {
    const source = join(resolve(input.projectsRoot), 'orgs', project.orgId, 'projects', project.projectId, 'skills');
    const receipt = join(catalog.rootDir, '.migrations', `${project.projectId}.json`);
    if (!existsSync(source) || existsSync(receipt)) continue;
    let ancestor = resolve(input.projectsRoot);
    for (const component of ['', ...relative(ancestor, source).split(sep)]) {
      ancestor = join(ancestor, component);
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`unsafe skills ancestor: ${ancestor}`);
    }
    assertRegularTree(source);
    if (existsSync(catalog.rootDir)) assertRegularTree(catalog.rootDir);
    const legacy = new SkillRegistry(source, { sidecarsOnly: true });
    // Runtime readers tolerate broken recipes; migration must retain a retry
    // instead of marking an omitted recipe as successfully imported.
    for (const namespace of legacy.listNamespaces()) {
      for (const entry of readdirSync(join(source, namespace), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(source, namespace, entry.name);
        if (!existsSync(join(dir, 'SKILL.md'))) continue;
        const { frontmatter } = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
        if (frontmatter.id !== entry.name || readMetaChecked(join(dir, LEGACY_META_FILENAME)).corrupt) {
          throw new Error(`invalid legacy skill: ${namespace}/${entry.name}`);
        }
      }
    }
    const entries = legacy.listNamespaces().flatMap(namespace => legacy.loadFor(namespace).map(skill => ({ namespace, skill })));
    if (entries.length === 0) continue;
    // Check all collisions before the first catalog write. A different body
    // under the same persisted identity requires an explicit reconciliation.
    for (const { namespace, skill } of entries) {
      const from = join(source, namespace, skill.id, 'SKILL.md');
      const to = join(catalog.rootDir, namespace, skill.id, 'SKILL.md');
      if (existsSync(to) && !readFileSync(from).equals(readFileSync(to))) {
        throw new Error(`platform skills migration conflict: ${namespace}/${skill.id}`);
      }
    }
    const backup = join(dirname(source), `skills-before-platform-${Date.now()}-${randomUUID()}`);
    cpSync(source, backup, { recursive: true, errorOnExist: true, force: false });
    for (const { namespace, skill } of entries) {
      const from = join(source, namespace, skill.id);
      const to = join(catalog.rootDir, namespace, skill.id);
      mkdirSync(to, { recursive: true });
      for (const file of ['SKILL.md', '_fallback.md', '_demoted-script.md']) {
        if (existsSync(join(from, file)) && !existsSync(join(to, file))) cpSync(join(from, file), join(to, file), { errorOnExist: true, force: false });
      }
      // A run is a run: the trust this project's runs earned counts on the
      // platform's one row, added to whatever the catalog already holds.
      const oldMeta = join(from, LEGACY_META_FILENAME);
      if (existsSync(oldMeta) && catalog.addCounters(namespace, skill.id, readMetaChecked(oldMeta).meta) === null) {
        throw new Error(`unreadable skill trust: ${join(to, LEGACY_META_FILENAME)}`);
      }
      let info: { name: string; tools_json: string } | undefined;
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='atom_types'").get()) {
        info = db.prepare('SELECT name, tools_json FROM atom_types WHERE atom_id = ?').get(namespace) as typeof info;
      }
      if (info) {
        const tools = JSON.parse(info.tools_json) as Array<{ name: string }>;
        catalog.registerNamespace(namespace, { name: info.name, tools: tools.map(tool => tool.name) });
      }
      imported++;
    }
    mkdirSync(dirname(receipt), { recursive: true });
    const temp = `${receipt}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ backup, count: entries.length }));
    renameSync(temp, receipt);
  }
  return imported;
}

/**
 * Fold the `.trust/<project-id>/<body-sha256>/<ns>/<id>/_meta.json` sidecars
 * into the catalog's rows, counters added, then set the whole `.trust` tree
 * aside as `.trust-before-platform-<stamp>`. Sidecars whose recipe no longer
 * exists in the catalog travel with the set-aside tree.
 */
export function foldScopedSkillTrust(input: { db: Database.Database | string; skillsRoot: string }): number {
  const root = resolve(input.skillsRoot);
  const trust = join(root, '.trust');
  if (!existsSync(trust)) return 0;
  const catalog = new SkillRegistry(root, { db: storeHandle(input.db) });
  let folded = 0;
  for (const scope of readdirSync(trust, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const digest of readdirSync(join(trust, scope.name), { withFileTypes: true })) {
      if (!digest.isDirectory()) continue;
      const base = join(trust, scope.name, digest.name);
      for (const namespace of readdirSync(base, { withFileTypes: true })) {
        if (!namespace.isDirectory()) continue;
        for (const skill of readdirSync(join(base, namespace.name), { withFileTypes: true })) {
          if (!skill.isDirectory()) continue;
          const scoped = join(base, namespace.name, skill.name, LEGACY_META_FILENAME);
          const target = join(root, namespace.name, skill.name);
          if (!existsSync(scoped) || !existsSync(join(target, 'SKILL.md'))) continue;
          const read = readMetaChecked(scoped);
          if (read.corrupt) throw new Error(`unreadable skill trust: ${scoped}`);
          if (catalog.addCounters(namespace.name, skill.name, read.meta) === null) {
            throw new Error(`unreadable skill trust: ${join(target, LEGACY_META_FILENAME)}`);
          }
          folded++;
        }
      }
    }
  }
  renameSync(trust, join(root, `.trust-before-platform-${Date.now()}-${randomUUID()}`));
  return folded;
}

/**
 * Move the recipes of every atom identity the registry fold absorbed under
 * the identity it was absorbed into. The body's folder moves; its row is
 * RE-KEYED in the same step (`absorbNamespaceSkill`), summing into the kept
 * row when the kept identity already has the recipe, whose body then wins
 * and the absorbed copy's folder is set aside under `.merged-before-platform/`.
 */
export function foldMergedNamespaces(input: { db: Database.Database | string; skillsRoot: string }): number {
  const root = resolve(input.skillsRoot);
  const db = storeHandle(input.db);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='atom_id_merges'").get()) return 0;
  const catalog = new SkillRegistry(root, { db });
  const merges = db.prepare('SELECT absorbed_atom_id, kept_atom_id FROM atom_id_merges').all() as
    { absorbed_atom_id: string; kept_atom_id: string }[];
  let moved = 0;
  for (const merge of merges) {
    const absorbed = join(root, merge.absorbed_atom_id);
    if (!existsSync(absorbed) || !lstatSync(absorbed).isDirectory()) continue;
    const kept = join(root, merge.kept_atom_id);
    mkdirSync(kept, { recursive: true });
    const aside = join(root, '.merged-before-platform', `${merge.absorbed_atom_id}-${Date.now()}-${randomUUID()}`);
    for (const entry of readdirSync(absorbed, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(absorbed, entry.name, 'SKILL.md'))) continue;
      const from = join(absorbed, entry.name);
      const to = join(kept, entry.name);
      // Trust first, while the body still sits where its sidecar (if any)
      // names it; then the body. A crash between leaves the absorbed body
      // with no row, zeroed by the projection's `skill-merge` rule.
      if (catalog.absorbNamespaceSkill(merge.absorbed_atom_id, merge.kept_atom_id, entry.name) === null) {
        throw new Error(`unreadable skill trust: ${join(from, LEGACY_META_FILENAME)}`);
      }
      if (!existsSync(to)) { renameSync(from, to); moved++; continue; }
      mkdirSync(aside, { recursive: true });
      renameSync(from, join(aside, entry.name));
      moved++;
    }
    // Whatever is left (the namespace card, stray files) goes aside whole.
    mkdirSync(dirname(aside), { recursive: true });
    renameSync(absorbed, existsSync(aside) ? join(aside, '_namespace') : aside);
  }
  return moved;
}

/**
 * Every fold, in order; what the coordinator runs at startup and the runner
 * before a run. The legacy sidecar import comes FIRST, so a fold that adds
 * to a recipe never races the import of that recipe's own sidecar (the
 * registry seeds before adding anyway; this keeps the order legible and the
 * `imported` count honest). A sidecar that will not parse is skipped and
 * reported, not thrown: one torn file must not block every run on the host.
 */
export function reconcilePlatformSkills(
  input: { db: Database.Database | string; skillsRoot: string }
): { imported: number; retired: number; unreadable: string[]; trust: number; merged: number } {
  const db = storeHandle(input.db);
  const legacy = new SkillRegistry(input.skillsRoot, { db }).importLegacySidecars();
  const trust = foldScopedSkillTrust({ db, skillsRoot: input.skillsRoot });
  const merged = foldMergedNamespaces({ db, skillsRoot: input.skillsRoot });
  return { ...legacy, trust, merged };
}

function assertRegularTree(directory: string): void {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`unsafe skills directory: ${directory}`);
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`unsafe skills entry: ${file}`);
    if (stat.isDirectory()) assertRegularTree(file);
  }
}
