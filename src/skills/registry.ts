import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  appendLedger as appendLifecycle,
  appendLedgerStrict as appendLifecycleStrict,
  ledgerDbPath,
  openLedgerHandle,
  type LedgerEvent,
} from '../core/ledger.js';
import { join, resolve } from 'node:path';
import { skillNamespaceInfoSchema, type SkillNamespaceInfo } from '../contracts/skillCatalog.js';
import type { Skill, SkillFrontmatter, SkillLanguage, SkillMeta, SkillProvenance } from './types.js';
import { asStoredNamespace, type SkillNamespace } from './namespace.js';
import {
  IMPORTED_META_FILENAME,
  bumpMetaRow,
  deleteMetaRow,
  deleteNamespaceRows,
  ensureSkillMetaSchema,
  readMetaRow,
  readMetaRows,
  skillMetaTableExists,
  writeMetaRow,
} from './metaStore.js';
/** Re-exported for tests and tools that inspect a tree after import. */
export { IMPORTED_META_FILENAME } from './metaStore.js';

/**
 * Sidecar filename holding the original `kind: 'llm'` body of a skill
 * that has since been PROMOTED to `kind: 'script'`. Lives next to
 * SKILL.md inside the skill folder. Read on `loadFor`, written on
 * `promoteToScript`, consulted (and copied back) on `demoteToLlm`.
 * Plain text — no frontmatter — because its only purpose is to be
 * dropped back into SKILL.md verbatim during demotion.
 */
export const FALLBACK_FILENAME = '_fallback.md';

/**
 * The compiled body a demotion just retired, kept for post-mortems.
 *
 * `demoteToLlm` overwrites SKILL.md from `_fallback.md`, so before this the
 * failing artefact was DESTROYED at exactly the moment someone wants to read
 * it. Round 3's root cause (a compiled verifier deriving arguments from a
 * `bash -c` wrapped cmd and capturing the closing quote) was only diagnosable
 * because the dispatch's `write_file _skill_*.mjs` happened to be in the run
 * trace — luck, not design. Overwritten by the next demotion on purpose: the
 * most recent failure is the one being investigated.
 */
export const DEMOTED_SCRIPT_FILENAME = '_demoted-script.md';

/**
 * The LEGACY counter sidecar. Written by every release before 2026-09-18,
 * read by this one only to import it once (see `metaStore.ts`); never
 * written again.
 */
export const LEGACY_META_FILENAME = '_meta.json';

/**
 * Upper bound on the persisted `promotionRefusedReason`. Sonnet's refusal
 * explanations are one or two sentences; the cap only exists so a runaway
 * response can't balloon a row that every `loadFor` reads.
 */
export const REFUSAL_REASON_MAX_CHARS = 500;

export interface SkillRegistryOptions {
  /**
   * The store handle to keep trust in. The runner passes the handle its
   * `AtomRegistry` already holds, so a run's skill events and atom events
   * share one connection; the CLIs pass the store their `--db` names. Absent,
   * the registry uses the cached handle on the ledger's store
   * (`ATOMA_LEDGER_DB` ?? `ATOMA_DB_PATH` ?? `./atoma.db`) — the same file by
   * construction, since T6 requires the counters and the ledger together.
   *
   * ROWS BELONG TO THE CATALOG. They are keyed by namespace and skill id, so
   * two registries on two roots over one store share rows. A registry over a
   * tree that is NOT the catalog (a pre-2026-09-18 per-project tree being
   * migrated) uses `sidecarsOnly`.
   */
  readonly db?: Database.Database;
  /**
   * Read counters from legacy `_meta.json` sidecars only and refuse every
   * mutation: the shape of a tree from before the move, read for import.
   */
  readonly sidecarsOnly?: boolean;
}

/** Handles this process has already checked for the `skill_meta` table. */
const schemaChecked = new WeakSet<Database.Database>();
/** Read-only handles on a store that has no `skill_meta` table (a pre-move snapshot). */
const tableAbsent = new WeakSet<Database.Database>();

/**
 * Skill store: bodies on the filesystem, trust in the product store.
 *   <rootDir>/<atom-id>/<skill-id>/SKILL.md      (frontmatter + body)
 *   <rootDir>/<atom-id>/<skill-id>/_fallback.md  (llm body of a promoted script)
 *   skill_meta(namespace, skill_id, …)           (counters, stamps, matches)
 *
 * The serialiser is a tiny YAML frontmatter + markdown body parser —
 * we don't pull a YAML library because the frontmatter shape is fixed
 * and small (4 string-typed keys). Anything more complex than the
 * declared shape rejects with a clear error so a malformed skill
 * doesn't silently degrade to a half-loaded object.
 *
 * Counters are kept apart from SKILL.md so hand-edited bodies are never
 * rewritten by `recordSuccess` / `recordFailure` — the trust signal mutates
 * without touching the human-authored content. Until 2026-09-18 that meant
 * a `_meta.json` sidecar; it now means a row in the store (W4, see
 * `metaStore.ts` for why), and every mutation below is one `.immediate()`
 * transaction that writes the row AND its lifecycle event.
 *
 * FILE + ROW PAIRS. `save`, `promoteToScript`, `demoteToLlm`, `merge`,
 * `drop` and `dropNamespace` touch both a body on disk and a row in the
 * store, and no transaction spans the two. Each states its crash order at
 * the call site; the shared rule is that a crash may cost earned trust
 * (a zeroed counter that re-earns) but never hand trust to a body that did
 * not earn it, and never leave the store BELOW the ledger's projection.
 */
export class SkillRegistry {
  readonly rootDir: string;
  private readonly ownDb: Database.Database | undefined;
  private readonly sidecarsOnly: boolean;

  /**
   * ONE catalog, ONE trust, for every run on the platform: bodies, counters
   * and lifecycle are shared by the operator's runs and every organisation's
   * project runs alike (`docs/platform-trust-2026-09-15.md`). The per-project
   * trust scope of 2026-09-15 morning is folded back by
   * `foldScopedSkillTrust` in `migratePlatform.ts`.
   */
  constructor(rootDir = './skills', options: SkillRegistryOptions = {}) {
    this.rootDir = resolve(rootDir);
    this.ownDb = options.db;
    this.sidecarsOnly = options.sidecarsOnly === true;
  }

  registerNamespace(namespace: string, info: SkillNamespaceInfo): void {
    const parsed = skillNamespaceInfoSchema.parse(info);
    const dir = this.namespaceDir(namespace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '_namespace.json');
    const bytes = JSON.stringify(parsed);
    if (existsSync(file) && readFileSync(file, 'utf8') === bytes) return;
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, file);
  }

  namespaceInfo(namespace: string): SkillNamespaceInfo | null {
    try {
      return skillNamespaceInfoSchema.parse(JSON.parse(readFileSync(join(this.namespaceDir(namespace), '_namespace.json'), 'utf8')));
    } catch { return null; }
  }

  // ---------------------------------------------------------------------
  // The store
  // ---------------------------------------------------------------------

  /**
   * The WRITABLE store handle: the caller's, or the cached handle on the
   * ledger's store. Resolved per call rather than cached on the instance, so
   * a test that repoints `ATOMA_LEDGER_DB` and closes the cached handles
   * between cases never leaves a registry holding a closed connection.
   *
   * Both store open paths (`openDb`, `openLedgerHandle`) already create the
   * table through `ensureLedgerSchema` — ONE schema step. The DDL here is for
   * a caller's bare `new Database(path)` handle, and a read-only handle is
   * only CHECKED: a snapshot that predates the table is read through the
   * sidecars and never written to.
   */
  private writeStore(): Database.Database {
    if (this.sidecarsOnly) throw new Error('this SkillRegistry reads legacy sidecars only and does not mutate');
    const db = this.ownDb ?? openLedgerHandle(ledgerDbPath());
    if (!schemaChecked.has(db)) {
      if (db.readonly) {
        if (!skillMetaTableExists(db)) tableAbsent.add(db);
      } else {
        ensureSkillMetaSchema(db);
      }
      schemaChecked.add(db);
    }
    return db;
  }

  /**
   * The store handle for a READ, or null when there is nothing to read from:
   * a sidecars-only registry, no caller handle and no store file yet (a
   * reader must not create `./atoma.db` as a side effect of listing skills),
   * or a read-only handle on a store without the table.
   */
  private readStore(): Database.Database | null {
    if (this.sidecarsOnly) return null;
    if (!this.ownDb && !existsSync(ledgerDbPath())) return null;
    const db = this.writeStore();
    return tableAbsent.has(db) ? null : db;
  }

  /**
   * `.immediate()` is what makes each mutation one write transaction that
   * takes its lock before its read (W4a). better-sqlite3 turns a nested
   * transaction into a SAVEPOINT and silently drops the mode, so a caller
   * that wrapped a skill mutation in its own transaction would lose the
   * guarantee without an error. Refused instead.
   */
  private assertNotNested(db: Database.Database): void {
    if (db.inTransaction) {
      throw new Error('SkillRegistry mutations open their own immediate transaction and cannot run inside another');
    }
  }

  // A skill entity is `<namespace>/<skill-id>` and the namespace is the
  // owning molecule's atom id (T4), so the label already IS the stable key.
  private recordEvent(event: Parameters<typeof appendLifecycle>[0], db: Database.Database) {
    appendLifecycle({ entityId: event.entity, ...event }, db);
  }

  private recordEventStrict(event: Parameters<typeof appendLifecycleStrict>[0], db: Database.Database) {
    appendLifecycleStrict({ entityId: event.entity, ...event }, db);
  }

  /** Return the full directory holding all skills for an L1 molecule. */
  private namespaceDir(l1Name: string): string {
    return join(this.rootDir, sanitise(l1Name));
  }

  private skillDir(l1Name: string, skillId: string): string {
    return join(this.namespaceDir(l1Name), sanitise(skillId));
  }

  /**
   * The row for a recipe, SEEDED if absent — from the legacy sidecar when
   * there is one to import, at zero otherwise. Runs inside the caller's
   * transaction. Returns null, writing nothing, when the sidecar exists and
   * cannot be read: a counter we cannot read is not a counter at zero, and
   * the torn bytes stay where an operator can recover them.
   *
   * The sidecar is renamed AFTER the transaction commits (see `afterCommit`),
   * so a rollback never leaves the counters imported into nothing. A crash
   * between commit and rename leaves a stale `_meta.json` beside a live row;
   * it is ignored (a row wins) and `importLegacySidecars` renames it later.
   */
  private seedRow(
    db: Database.Database,
    namespace: string,
    skillId: string,
    afterCommit: (() => void)[]
  ): SkillMeta | null {
    const existing = readMetaRow(db, namespace, skillId);
    if (existing) return existing;
    const legacy = join(this.skillDir(namespace, skillId), LEGACY_META_FILENAME);
    let seed: SkillMeta = { successes: 0, failures: 0, updatedAt: nowIso() };
    if (existsSync(legacy)) {
      const read = readMetaChecked(legacy);
      if (read.corrupt) return null;
      seed = read.meta;
      afterCommit.push(() => retireSidecar(legacy));
    }
    writeMetaRow(db, namespace, skillId, seed);
    return seed;
  }

  /**
   * The single mutation path. ONE `.immediate()` transaction: seed the row if
   * needed, compute the next state from the current one, write it as one
   * statement, append the event. `mutate` returning undefined is a checked
   * read/no-op. Returns null when the mutation was refused (unreadable
   * legacy sidecar), leaving store, files and ledger untouched.
   */
  private mutateMeta(
    namespace: string,
    skillId: string,
    mutate: (current: SkillMeta) => SkillMeta | undefined,
    event?: Omit<LedgerEvent, 'at'> | ((next: SkillMeta) => Omit<LedgerEvent, 'at'>),
    options: { strict?: boolean; also?: (db: Database.Database) => void } = {}
  ): SkillMeta | null {
    const db = this.writeStore();
    this.assertNotNested(db);
    const afterCommit: (() => void)[] = [];
    const result = db.transaction((): SkillMeta | null => {
      const current = this.seedRow(db, namespace, skillId, afterCommit);
      if (current === null) return null;
      const next = mutate(current);
      const written = next ?? current;
      if (event) {
        const ev = typeof event === 'function' ? event(written) : event;
        // JOURNAL FIRST for the strict callers: inside one transaction the
        // order changes nothing about atomicity, but a strict append that
        // throws must leave the store untouched, and it does — the
        // transaction rolls back before the row write is even attempted.
        if (options.strict) this.recordEventStrict(ev, db);
        else this.recordEvent(ev, db);
      }
      if (next !== undefined) writeMetaRow(db, namespace, skillId, next);
      options.also?.(db);
      return written;
    }).immediate();
    if (result !== null) for (const run of afterCommit) run();
    return result;
  }

  /**
   * The current meta WITHOUT writing: the row, else the legacy sidecar, else
   * zeros. Null when the sidecar exists and is unreadable. What a file+row
   * mutation checks BEFORE touching any file.
   */
  private peekMeta(namespace: string, skillId: string): SkillMeta | null {
    const db = this.readStore();
    const row = db ? readMetaRow(db, namespace, skillId) : null;
    if (row) return row;
    const legacy = join(this.skillDir(namespace, skillId), LEGACY_META_FILENAME);
    if (!existsSync(legacy)) return { successes: 0, failures: 0, updatedAt: nowIso() };
    const read = readMetaChecked(legacy);
    return read.corrupt ? null : read.meta;
  }

  /**
   * Import every legacy `_meta.json` under the root that has no row yet, and
   * retire every sidecar that already has one. Run by
   * `reconcilePlatformSkills` before a run and at coordinator startup, so
   * readers stop depending on sidecars after the first run of this release.
   * A sidecar that will not parse is left alone and reported, exactly as a
   * mutation would refuse it.
   */
  importLegacySidecars(): { imported: number; retired: number; unreadable: string[] } {
    const out = { imported: 0, retired: 0, unreadable: [] as string[] };
    if (!existsSync(this.rootDir)) return out;
    const db = this.writeStore();
    for (const namespace of this.listNamespaces()) {
      const dir = this.namespaceDir(namespace);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const legacy = join(skillDir, LEGACY_META_FILENAME);
        if (!existsSync(join(skillDir, 'SKILL.md')) || !existsSync(legacy)) continue;
        if (readMetaRow(db, namespace, entry.name)) {
          retireSidecar(legacy);
          out.retired++;
          continue;
        }
        const read = readMetaChecked(legacy);
        if (read.corrupt) { out.unreadable.push(legacy); continue; }
        db.transaction(() => { writeMetaRow(db, namespace, entry.name, read.meta); }).immediate();
        retireSidecar(legacy);
        out.imported++;
      }
    }
    return out;
  }

  /**
   * Add counters earned elsewhere into a recipe's row — the platform folds
   * (`migratePlatform.ts`): per-project trees, `.trust` sidecars, absorbed
   * namespaces. The target keeps its own provenance and stamps. Null when
   * the target's legacy sidecar is unreadable.
   */
  addCounters(namespace: string, skillId: string, source: SkillMeta): SkillMeta | null {
    const later = (a?: string, b?: string): string | undefined => (!a ? b : !b ? a : a > b ? a : b);
    return this.mutateMeta(namespace, skillId, (target) => {
      const matches = (target.matches ?? 0) + (source.matches ?? 0);
      const directFailures = (target.directFailures ?? 0) + (source.directFailures ?? 0);
      const lastMatchedAt = later(target.lastMatchedAt, source.lastMatchedAt);
      return {
        ...target,
        successes: target.successes + source.successes,
        failures: target.failures + source.failures,
        updatedAt: later(target.updatedAt, source.updatedAt) ?? nowIso(),
        ...(matches ? { matches } : {}),
        ...(directFailures ? { directFailures } : {}),
        ...(lastMatchedAt ? { lastMatchedAt } : {}),
        ...(target.provenance ? {} : source.provenance ? { provenance: source.provenance } : {}),
      };
    });
  }

  /**
   * Move one recipe's trust from an ABSORBED namespace to the KEPT one — the
   * registry fold (`atom_id_merges`) moved the body's folder, and the row has
   * to follow or the moved body reads 0/0 while its counters sit orphaned
   * under an identity no reader resolves. Counters ADD when the kept
   * namespace already has the recipe (a run is a run: trust earned under
   * either identity counts once, on the kept row). One transaction: seed both
   * sides from any unimported sidecar, sum, delete the absorbed row, and
   * journal a `skill-merge` naming the absorbed entity with the counters it
   * moved, so `projectCounters` follows exactly as it does for `type-merge`.
   * Returns null when either side's legacy sidecar is unreadable.
   */
  absorbNamespaceSkill(absorbedNs: string, keptNs: string, skillId: string): SkillMeta | null {
    const db = this.writeStore();
    this.assertNotNested(db);
    const afterCommit: (() => void)[] = [];
    const later = (a?: string, b?: string): string | undefined => (!a ? b : !b ? a : a > b ? a : b);
    const result = db.transaction((): SkillMeta | null => {
      const source = this.seedRow(db, absorbedNs, skillId, afterCommit);
      if (source === null) return null;
      const target = this.seedRow(db, keptNs, skillId, afterCommit);
      if (target === null) return null;
      const matches = (target.matches ?? 0) + (source.matches ?? 0);
      const directFailures = (target.directFailures ?? 0) + (source.directFailures ?? 0);
      const lastMatchedAt = later(target.lastMatchedAt, source.lastMatchedAt);
      const next: SkillMeta = {
        ...target,
        successes: target.successes + source.successes,
        failures: target.failures + source.failures,
        updatedAt: later(target.updatedAt, source.updatedAt) ?? nowIso(),
        ...(matches ? { matches } : {}),
        ...(directFailures ? { directFailures } : {}),
        ...(lastMatchedAt ? { lastMatchedAt } : {}),
        ...(target.provenance ? {} : source.provenance ? { provenance: source.provenance } : {}),
      };
      this.recordEvent(
        {
          kind: 'skill-merge',
          entity: `${keptNs}/${skillId}`,
          detail: {
            absorbed: skillId,
            absorbedEntity: `${absorbedNs}/${skillId}`,
            successes: source.successes,
            failures: source.failures,
          },
        },
        db
      );
      writeMetaRow(db, keptNs, skillId, next);
      deleteMetaRow(db, absorbedNs, skillId);
      return next;
    }).immediate();
    if (result !== null) for (const run of afterCommit) run();
    return result;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /**
   * Load every skill belonging to a molecule. Missing namespace returns
   * an empty list (a fresh molecule has no skills). Malformed skill folders
   * (no SKILL.md, bad frontmatter) are SKIPPED with a console.warn
   * rather than throwing — one bad file should not bring down the
   * whole atom. Counters come from the store in ONE read per namespace;
   * a recipe with no row yet reads its legacy sidecar, if any.
   */
  loadFor(l1Name: string): Skill[] {
    const dir = this.namespaceDir(l1Name);
    if (!existsSync(dir)) return [];
    const db = this.readStore();
    const rows = db ? readMetaRows(db, l1Name) : new Map<string, SkillMeta>();
    const out: Skill[] = [];
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      let st;
      try {
        st = statSync(skillDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const text = readFileSync(skillFile, 'utf8');
        const { frontmatter, body } = parseFrontmatter(text);
        const meta = rows.get(entry) ?? readMeta(join(skillDir, LEGACY_META_FILENAME));
        const fallbackPath = join(skillDir, FALLBACK_FILENAME);
        const fallbackBody = existsSync(fallbackPath)
          ? readFileSync(fallbackPath, 'utf8').trim()
          : undefined;
        out.push({
          id: frontmatter.id,
          description: frontmatter.description,
          whenToUse: frontmatter.whenToUse,
          kind: frontmatter.kind,
          ...(frontmatter.language !== undefined ? { language: frontmatter.language } : {}),
          ...(frontmatter.trigger !== undefined ? { trigger: frontmatter.trigger } : {}),
          body,
          ...(fallbackBody ? { fallbackBody } : {}),
          successes: meta.successes,
          failures: meta.failures,
          updatedAt: meta.updatedAt,
          ...(meta.promotionRefusedAt ? { promotionRefusedAt: meta.promotionRefusedAt } : {}),
          ...(meta.promotionRefusedReason
            ? { promotionRefusedReason: meta.promotionRefusedReason }
            : {}),
          ...(meta.promotionRefusedGeneration
            ? { promotionRefusedGeneration: meta.promotionRefusedGeneration }
            : {}),
          ...(meta.compiledGeneration ? { compiledGeneration: meta.compiledGeneration } : {}),
          ...(meta.declaredWrites && meta.declaredWrites.length > 0
            ? { declaredWrites: meta.declaredWrites }
            : {}),
          ...(meta.provenance ? { provenance: meta.provenance } : {}),
          ...(meta.directFailures ? { directFailures: meta.directFailures } : {}),
          ...(meta.matches ? { matches: meta.matches } : {}),
          ...(meta.lastMatchedAt ? { lastMatchedAt: meta.lastMatchedAt } : {}),
        });
      } catch (err) {

        console.warn(
          `[SkillRegistry] skipping ${skillFile}: ${(err as Error).message}`
        );
      }
    }
    // Stable sort by id so prefilter prompts are deterministic.
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /**
   * Enumerate the L1 namespaces that have at least one skill folder.
   * Used by the skills CLI to sweep the whole store.
   */
  listNamespaces(): SkillNamespace[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter((entry) => !entry.startsWith('.'))
      .filter((entry) => {
        try {
          return statSync(join(this.rootDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b))
      // Read back out of the store, so these ARE namespaces by construction.
      .map(asStoredNamespace);
  }

  // ---------------------------------------------------------------------
  // Body + row mutations
  // ---------------------------------------------------------------------

  /**
   * Persist a skill to disk. Creates the namespace + skill directories
   * as needed and resets counters to zero on first save (a re-save of
   * the same id refreshes content but PRESERVES counters — patches
   * shouldn't punish a skill that was earning trust).
   *
   * CREATE versus REWRITE. A body that did not exist earned nothing, so a
   * save that CREATES the skill writes its row at zero even when a row is
   * already there — the orphan a `drop` racing an in-flight run's credit can
   * leave, or a crash between a folder removal and its row deletion. Trust
   * is body-bound; letting a new body inherit an orphan's counters is the
   * corruption "patch resets trust" exists to prevent. The zeroing is
   * journaled (`skill-save` with `created: true`, which the projection zeroes
   * on) so `ledger check` agrees.
   *
   * CRASH ORDER: SKILL.md first, atomically, then the row and the event in
   * one transaction. A crash between the two leaves the new body with the
   * previous row — a stale refusal stamp at worst, which costs one skipped
   * compile attempt until the next save. The reverse order would clear the
   * stamp for a body that never landed.
   */
  save(
    l1Name: string,
    skill: Pick<Skill, 'id' | 'description' | 'whenToUse' | 'kind' | 'body'> &
      Partial<Pick<Skill, 'language' | 'trigger'>>,
    provenance?: SkillProvenance
  ): Skill {
    if (skill.kind === 'script' && !skill.language) {
      throw new Error(`save: kind:"script" requires a language (node|python|bash)`);
    }
    if (skill.kind === 'llm' && skill.language) {
      throw new Error(`save: kind:"llm" must not declare a language; got "${skill.language}"`);
    }
    if (skill.kind === 'script' && skill.trigger) {
      throw new Error(`save: kind:"script" must not declare a trigger — event skills are guidance, not scripts`);
    }
    const dir = this.skillDir(l1Name, skill.id);
    mkdirSync(dir, { recursive: true });
    // A body rewrite changes the meaning of several metadata fields. Check
    // the trust record BEFORE touching SKILL.md so a torn legacy sidecar
    // cannot be silently paired with a new body or normalised to 0/0.
    if (this.peekMeta(l1Name, skill.id) === null) {
      throw new Error(`save: refusing to rewrite ${skill.id} while ${join(dir, LEGACY_META_FILENAME)} is unreadable`);
    }
    const md = renderFrontmatter(
      {
        id: skill.id,
        description: skill.description,
        whenToUse: skill.whenToUse,
        kind: skill.kind,
        ...(skill.language ? { language: skill.language } : {}),
        ...(skill.trigger ? { trigger: skill.trigger } : {}),
      },
      skill.body
    );
    // Atomic: the catalog is shared by every run on the host, so a reader
    // never sees a half-written body.
    const bodyPath = join(dir, 'SKILL.md');
    const created = !existsSync(bodyPath);
    const temp = `${bodyPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, md, 'utf8');
      renameSync(temp, bodyPath);
    } finally { rmSync(temp, { force: true }); }
    // A REWRITE preserves existing counters. INTENTIONALLY DROP
    // `promotionRefusedAt`: a save() means the body changed (or the kind
    // flipped). Sonnet's prior refusal was a judgment about the OLD body; the
    // new body deserves a fresh compile attempt next time the trust gate is
    // crossed. Without this clear, an `improveSkillBody`-revised recipe could
    // never earn promotion even if the rewrite makes it script-shaped.
    const meta = this.mutateMeta(
      l1Name,
      skill.id,
      (existing) => {
        const nextProvenance: SkillProvenance | undefined = provenance
          ? { ...provenance, at: provenance.at ?? nowIso() }
          : created ? undefined : existing.provenance;
        return {
          successes: created ? 0 : existing.successes,
          failures: created ? 0 : existing.failures,
          updatedAt: nowIso(),
          ...(nextProvenance ? { provenance: nextProvenance } : {}),
          // Match history survives a body rewrite for the same reason the
          // counters do: the stats gap (matches vs driven) compares against
          // counters that save() preserves.
          ...(!created && existing.matches ? { matches: existing.matches } : {}),
          ...(!created && existing.lastMatchedAt ? { lastMatchedAt: existing.lastMatchedAt } : {}),
        };
      },
      {
        kind: 'skill-save',
        entity: `${l1Name}/${skill.id}`,
        detail: {
          kind: skill.kind,
          ...(provenance ? { mechanism: provenance.mechanism } : {}),
          ...(created ? { created: true } : {}),
        },
      }
    );
    // Only an external edit in the tiny interval after the preflight can
    // reach this branch.
    if (meta === null) {
      throw new Error(`save: ${join(dir, LEGACY_META_FILENAME)} became unreadable during the rewrite`);
    }
    return {
      id: skill.id,
      description: skill.description,
      whenToUse: skill.whenToUse,
      kind: skill.kind,
      ...(skill.language ? { language: skill.language } : {}),
      body: skill.body,
      successes: meta.successes,
      failures: meta.failures,
      updatedAt: meta.updatedAt,
    };
  }

  /**
   * Mark a skill as having recently failed Sonnet compile (the model
   * answered `{"promotable": false, ...}`). The supervisor's
   * promotion gate skips any skill whose record carries this stamp,
   * preventing a fresh Sonnet compile call on every future success
   * for a skill whose recipe is structurally non-promotable (e.g.
   * recipes containing irreducible LLM reasoning steps like SQL
   * schema design or external-API shape choice). The stamp is
   * cleared automatically by `save()` whenever the skill body is
   * rewritten — a revised body is a new compile candidate.
   *
   * No-op (returns null) when the skill folder doesn't exist; we
   * never create a record for a non-existent skill.
   */
  markPromotionRefused(
    l1Name: string,
    skillId: string,
    reason?: string,
    generation?: string
  ): SkillMeta | null {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    const trimmed = reason?.trim().slice(0, REFUSAL_REASON_MAX_CHARS);
    const at = nowIso();
    return this.mutateMeta(
      l1Name,
      skillId,
      (cur) => ({
        ...cur,
        promotionRefusedAt: at,
        ...(trimmed ? { promotionRefusedReason: trimmed } : {}),
        ...(generation ? { promotionRefusedGeneration: generation } : {}),
        updatedAt: at,
      }),
      {
        kind: 'promotion-refused',
        entity: `${l1Name}/${skillId}`,
        detail: { ...(generation ? { generation } : {}), ...(trimmed ? { reason: trimmed.slice(0, 160) } : {}) },
      }
    );
  }

  /**
   * Bump the consecutive deterministic-dispatch failure count and return
   * the new value. See `SkillMeta.directFailures` for semantics — this is
   * NOT the trust failure counter. No-op (returns 0) for a missing skill.
   */
  markDirectFailure(l1Name: string, skillId: string): number {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return 0;
    const next = this.mutateMeta(
      l1Name,
      skillId,
      (cur) => ({
        ...cur,
        directFailures: (cur.directFailures ?? 0) + 1,
        updatedAt: nowIso(),
      }),
      (written) => ({
        kind: 'direct-failure',
        entity: `${l1Name}/${skillId}`,
        detail: { streak: written.directFailures ?? 0 },
      })
    );
    return next?.directFailures ?? 0;
  }

  /**
   * Drop the refusal/demotion stamp (timestamp, reason, generation) while
   * KEEPING counters. Used when the stamp is stale because the compile
   * prompt generation moved on — the stamp's premise no longer holds, so
   * the evolved compiler deserves a shot without an operator reset.
   */
  clearPromotionRefusal(l1Name: string, skillId: string): void {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return;
    this.mutateMeta(l1Name, skillId, (cur) => {
      if (!cur.promotionRefusedAt) return undefined;
      const {
        promotionRefusedAt: _a,
        promotionRefusedReason: _r,
        promotionRefusedGeneration: _g,
        ...rest
      } = cur;
      return { ...rest, updatedAt: nowIso() };
    });
  }

  /**
   * Record a skill-prefilter match — see `SkillMeta.matches`. Called at
   * match time (before the run outcome is known) so the stats gap between
   * matches and driven runs surfaces free-riding and never-picked skills.
   * NOT a ledger event: a match is neither a trust nor a lifecycle
   * mutation, and it fires on every skill-driven subtask. No-op for a
   * missing skill.
   */
  markMatched(l1Name: string, skillId: string): void {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return;
    const at = nowIso();
    this.mutateMeta(l1Name, skillId, (cur) => ({
      ...cur,
      matches: (cur.matches ?? 0) + 1,
      lastMatchedAt: at,
      updatedAt: at,
    }));
  }

  /**
   * Delete a skill outright (CLI `skills drop`). The operator's
   * catalog-hygiene verb: retire never-matched debris and free-riding
   * recipes that `skills stats` surfaced. Destructive — the CLI guards
   * proven skills (successes > 0) behind --force; the registry method
   * itself only refuses a missing skill (returns false).
   *
   * CRASH ORDER: folder first, then the row and the event in one
   * transaction — the order the sidecar era had. A crash between the two
   * leaves an orphan row with no body: invisible to every reader (they walk
   * the folders), never compared by `ledger check`, and zeroed by the next
   * `save` that CREATES a body under the id. The reverse order was reviewed
   * and rejected (2026-09-18): a body that outlives its row reads 0/0 under a
   * ledger that still projects its successes — the IMPOSSIBLE direction —
   * and a failed `rmSync` reaches the same state with no crash at all.
   */
  drop(l1Name: string, skillId: string): boolean {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return false;
    const db = this.writeStore();
    this.assertNotNested(db);
    rmSync(dir, { recursive: true, force: true });
    db.transaction(() => {
      deleteMetaRow(db, l1Name, skillId);
      this.recordEvent({ kind: 'skill-drop', entity: `${l1Name}/${skillId}` }, db);
    }).immediate();
    return true;
  }

  /**
   * Delete a whole namespace (CLI `registry remove` / `dedupe`).
   *
   * After T4 the skill path is the atom id. `mergeInto` and `remove` delete
   * the atom row and used to leave `skills/<loser-atom-id>/` behind — an
   * orphan `listNamespaces` still shows and no live atom will `loadFor`.
   * This is the operator reaper for that leftover, not a skill-body merge:
   * the recipes die with the identity, rows included. Returns false when the
   * directory is already gone. Same crash order as `drop`.
   */
  dropNamespace(ns: string): boolean {
    const dir = this.namespaceDir(ns);
    if (!existsSync(dir)) return false;
    const db = this.writeStore();
    this.assertNotNested(db);
    rmSync(dir, { recursive: true, force: true });
    db.transaction(() => {
      deleteNamespaceRows(db, ns);
      this.recordEvent({ kind: 'skill-drop', entity: ns, detail: { namespace: true } }, db);
    }).immediate();
    return true;
  }

  /**
   * Consolidate two skills of one L1 (CLI `skills merge`): the KEEPER's
   * matching surface absorbs the other skill's `when_to_use`, and the
   * absorbed skill is deleted. Deliberately MECHANICAL, no LLM:
   *   - the keeper's BODY, description, kind and counters are untouched —
   *     trust is body-bound, and an unchanged body keeps its earned trust
   *     (this is also why we do NOT route through save(), which would
   *     clear the promotion-refusal stamp on the premise of a body change);
   *   - the absorbed body is deleted, and its counters die with it —
   *     summing counters earned by a DIFFERENT body would inflate trust,
   *     the exact corruption "patch resets trust" exists to prevent.
   * The point of a merge is routing: future subtasks that would have
   * matched the absorbed skill now reach the keeper. If the absorbed body
   * is the one worth keeping, merge in the other direction.
   * Returns the merged keeper, or null when either skill is missing.
   *
   * CRASH ORDER: keeper body, absorbed folder, then one transaction (keeper
   * timestamp, absorbed row deleted, event) — `drop`'s reasoning: an orphan
   * row is invisible and zeroed by the next creating `save`, a resurfaced
   * body would read below the ledger.
   */
  merge(l1Name: string, keepId: string, absorbId: string): Skill | null {
    if (keepId === absorbId) return null;
    const keepDir = this.skillDir(l1Name, keepId);
    const absorbDir = this.skillDir(l1Name, absorbId);
    const keepFile = join(keepDir, 'SKILL.md');
    if (!existsSync(keepFile) || !existsSync(join(absorbDir, 'SKILL.md'))) return null;
    const keep = parseFrontmatter(readFileSync(keepFile, 'utf8'));
    const absorb = parseFrontmatter(readFileSync(join(absorbDir, 'SKILL.md'), 'utf8'));
    const mergedWhenToUse = keep.frontmatter.whenToUse.includes(absorb.frontmatter.whenToUse)
      ? keep.frontmatter.whenToUse
      : `${keep.frontmatter.whenToUse}; also: ${absorb.frontmatter.whenToUse}`;
    // Validate the keeper's record before changing either skill.
    if (this.peekMeta(l1Name, keepId) === null) return null;
    writeFileSync(
      keepFile,
      renderFrontmatter({ ...keep.frontmatter, whenToUse: mergedWhenToUse }, keep.body),
      'utf8'
    );
    rmSync(absorbDir, { recursive: true, force: true });
    const touched = this.mutateMeta(
      l1Name,
      keepId,
      (cur) => ({ ...cur, updatedAt: nowIso() }),
      { kind: 'skill-merge', entity: `${l1Name}/${keepId}`, detail: { absorbed: absorbId } },
      { also: (db) => { deleteMetaRow(db, l1Name, absorbId); } }
    );
    if (touched === null) {
      throw new Error(`merge: the record of ${l1Name}/${keepId} became unreadable during the merge`);
    }
    const merged = this.loadFor(l1Name).find((s) => s.id === keepId);
    return merged ?? null;
  }

  /**
   * Reset the deterministic-failure streak — called on a deterministic
   * SUCCESS only. An LLM-loop success is deliberately not a reset: it
   * proves the recipe, not the script.
   */
  clearDirectFailures(l1Name: string, skillId: string): void {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return;
    this.mutateMeta(l1Name, skillId, (cur) => {
      if (!cur.directFailures) return undefined;
      const { directFailures: _dropped, ...rest } = cur;
      return { ...rest, updatedAt: nowIso() };
    });
  }

  /**
   * Promote an existing `kind: 'llm'` skill to `kind: 'script'`. Writes
   * the current llm body to the `_fallback.md` sidecar so demotion can
   * restore it verbatim, then rewrites SKILL.md with the new script
   * body + language.
   *
   * Counters are RESET to 0/0. They were preserved in the original
   * implementation ("a body reformulation of an already-trusted skill"),
   * and that reasoning is wrong in a way that turned out to be dangerous:
   * the successes were all earned by the MARKDOWN recipe driving a
   * validated LLM tool-loop, while the compiled script is a brand-new
   * artefact that has never executed even once. Inheriting 5/0 armed the
   * deterministic dispatch (`shouldTrustSkill` needs 3/0) on its very
   * first match — and that path returns before the supervise loop, so
   * nothing would have validated its output, and `onFailed`/`demoteToLlm`
   * are unreachable from it. Observed on `document-cli-from-source` after
   * the 2026-07-25 run. Resetting makes the script form earn its 3 clean
   * runs THROUGH the validated loop before it is trusted to run unwatched.
   *
   * Refuses (throws) if the skill on disk is already `kind: 'script'`.
   * That guard keeps double-promotion from clobbering an existing
   * fallback (the original llm body would be lost).
   *
   * CRASH ORDER (audit finding, re-derived for the row): the old sequence
   * wrote SKILL.md kind:script FIRST with counters preserved and zeroed
   * them after — a crash in that window left a NEVER-EXECUTED script armed
   * for the no-validator deterministic dispatch. Now: fallback sidecar,
   * then ONE transaction (zeroed row with compiledGeneration and
   * provenance, plus the `promote` event), then SKILL.md LAST as the
   * commit point. A crash anywhere leaves the llm form — worst case with
   * zeroed counters and a `promote` event, which agree with each other
   * (the projection zeroes on `promote`) and merely re-earn trust.
   */
  promoteToScript(args: {
    l1Name: string;
    skillId: string;
    language: SkillLanguage;
    scriptBody: string;
    /** COMPILE_PROMPT_GENERATION that produced scriptBody. */
    compiledGeneration?: string;
    /** Model id that ran the compile — provenance {mechanism:'compiled'}. */
    compiledBy?: string;
    /** Compiler-declared write paths, already cross-checked by the caller. */
    declaredWrites?: readonly string[];
  }): Skill {
    const dir = this.skillDir(args.l1Name, args.skillId);
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) {
      throw new Error(`promoteToScript: no skill at ${skillFile}`);
    }
    const text = readFileSync(skillFile, 'utf8');
    const { frontmatter, body: currentBody } = parseFrontmatter(text);
    if (frontmatter.kind !== 'llm') {
      throw new Error(
        `promoteToScript: skill ${args.skillId} is already kind:"${frontmatter.kind}"; refusing to overwrite`
      );
    }
    if (this.peekMeta(args.l1Name, args.skillId) === null) {
      throw new Error(
        `promoteToScript: refusing to promote ${args.skillId} while ${join(dir, LEGACY_META_FILENAME)} is unreadable`
      );
    }
    writeFileSync(join(dir, FALLBACK_FILENAME), currentBody.trim() + '\n', 'utf8');
    const meta: SkillMeta = {
      successes: 0,
      failures: 0,
      updatedAt: nowIso(),
      ...(args.compiledGeneration ? { compiledGeneration: args.compiledGeneration } : {}),
      ...(args.declaredWrites && args.declaredWrites.length > 0
        ? { declaredWrites: [...args.declaredWrites] }
        : {}),
      provenance: {
        mechanism: 'compiled',
        ...(args.compiledBy ? { model: args.compiledBy } : {}),
        at: nowIso(),
      },
    };
    const writtenMeta = this.mutateMeta(args.l1Name, args.skillId, () => meta, {
      kind: 'promote',
      entity: `${args.l1Name}/${args.skillId}`,
      detail: { language: args.language, ...(args.compiledGeneration ? { compiledGeneration: args.compiledGeneration } : {}) },
    });
    if (writtenMeta === null) {
      throw new Error(`promoteToScript: the record of ${args.skillId} became unreadable during promotion`);
    }
    const md = renderFrontmatter(
      {
        id: frontmatter.id,
        description: frontmatter.description,
        whenToUse: frontmatter.whenToUse,
        kind: 'script',
        language: args.language,
      },
      args.scriptBody
    );
    writeFileSync(skillFile, md, 'utf8');
    return {
      id: frontmatter.id,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      kind: 'script',
      language: args.language,
      body: args.scriptBody,
      successes: writtenMeta.successes,
      failures: writtenMeta.failures,
      updatedAt: writtenMeta.updatedAt,
      ...(writtenMeta.compiledGeneration
        ? { compiledGeneration: writtenMeta.compiledGeneration }
        : {}),
      ...(writtenMeta.declaredWrites && writtenMeta.declaredWrites.length > 0
        ? { declaredWrites: writtenMeta.declaredWrites }
        : {}),
      ...(writtenMeta.provenance ? { provenance: writtenMeta.provenance } : {}),
    };
  }

  /**
   * Demote a `kind: 'script'` skill back to `kind: 'llm'` by restoring
   * the fallback body that was preserved at promotion time. Counters
   * are PRESERVED (the failure counter has already been bumped via
   * `recordFailure` upstream — that's what triggers demotion in the
   * first place). The `_fallback.md` sidecar is INTENTIONALLY left in
   * place: keeping it lets a future re-promotion compare against the
   * historical body, and a `failures > 0` gate at promote-attempt
   * time blocks accidental re-promotion until counters are reset.
   *
   * No-op (returns null) when the skill doesn't exist, isn't currently
   * kind:script, or has no fallback body — the caller should treat
   * those as "nothing to demote" rather than as errors.
   */
  demoteToLlm(l1Name: string, skillId: string): Skill | null {
    const dir = this.skillDir(l1Name, skillId);
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) return null;
    const text = readFileSync(skillFile, 'utf8');
    const { frontmatter } = parseFrontmatter(text);
    if (frontmatter.kind !== 'script') return null;
    const fallbackPath = join(dir, FALLBACK_FILENAME);
    if (!existsSync(fallbackPath)) return null;
    const fallbackBody = readFileSync(fallbackPath, 'utf8').trim();
    if (!fallbackBody) return null;
    if (this.peekMeta(l1Name, skillId) === null) return null;
    // Preserve the script being retired BEFORE save() overwrites it. Never
    // fatal: a post-mortem aid must not be able to block the safety action it
    // documents.
    try {
      writeFileSync(join(dir, DEMOTED_SCRIPT_FILENAME), text, 'utf8');
    } catch {
      /* best effort — demotion proceeds regardless */
    }
    const demoted = this.save(l1Name, {
      id: frontmatter.id,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      kind: 'llm',
      body: fallbackBody,
    });
    this.recordEvent({ kind: 'demote', entity: `${l1Name}/${skillId}` }, this.writeStore());
    return demoted;
  }

  /**
   * Operator-facing counter reset (CLI `skills reset`). Zeroes both
   * counters AND drops `promotionRefusedAt` — the reset expresses an
   * explicit operator judgment that the skill deserves a fresh start,
   * which includes a fresh Sonnet compile attempt once it re-earns the
   * promotion threshold. This is the only sanctioned way out of the
   * two dead-ends the automatic gates create: `failures > 0` blocks
   * re-promotion forever after a demotion, and a compile-refusal stamp
   * parks an unchanged body indefinitely.
   *
   * Returns the fresh meta, or null when the skill doesn't exist (we
   * never create a record for a non-existent skill).
   */
  resetCounters(l1Name: string, skillId: string): SkillMeta | null {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    // A reset zeroes COUNTERS and drops the refusal stamp — it does not
    // rewrite history about the body itself: compiledGeneration (which
    // compiler produced the current script) and provenance (who wrote the
    // body) describe the artefact, not its trust, and survive the reset.
    return this.mutateMeta(
      l1Name,
      skillId,
      (cur) => ({
        successes: 0,
        failures: 0,
        updatedAt: nowIso(),
        ...(cur.compiledGeneration ? { compiledGeneration: cur.compiledGeneration } : {}),
        ...(cur.provenance ? { provenance: cur.provenance } : {}),
      }),
      { kind: 'counters-reset', entity: `${l1Name}/${skillId}`, detail: { reason: 'reset' } }
    );
  }

  /**
   * Retract MISATTRIBUTED counter increments without discarding the rest —
   * the surgical sibling of `resetCounters`, mirroring
   * `AtomRegistry.compensateCounters` exactly (negative integer deltas, a
   * mandatory reason, a floor at zero, and a ledger event `projectCounters`
   * understands, so `ledger check` stays exact instead of reporting the
   * store as impossibly below the ledger).
   *
   * MEASURED 2026-08-21: `build-inline-html-widget` stood at 7 clean
   * successes and 2 failures inherited from a run killed by its wall-clock
   * budget — an environment failure, which is "not evidence against the
   * recipe". With failures > 0 the recipe could never become
   * promotion-eligible again, and the only surface was all-or-nothing
   * `reset`: removing 2 wrong failures cost 7 right successes.
   *
   * Refusal stamps, compiledGeneration and provenance are untouched — they
   * describe the body, not its trust; clearing the stamp stays `reset`'s job.
   *
   * The event and the counter write are ONE transaction (strict append: a
   * failure to journal rolls the counter back), which is what the
   * journal-first ordering of the sidecar era was approximating.
   */
  compensateCounters(
    l1Name: string,
    skillId: string,
    args: { successes?: number; failures?: number; reason: string }
  ): SkillMeta | null {
    const successes = args.successes ?? 0;
    const failures = args.failures ?? 0;
    if (
      !Number.isInteger(successes) ||
      !Number.isInteger(failures) ||
      successes > 0 ||
      failures > 0 ||
      (successes === 0 && failures === 0)
    ) {
      throw new Error('counter compensation requires at least one negative integer delta');
    }
    if (args.reason.trim().length === 0) {
      throw new Error('counter compensation requires a reason');
    }
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    const current = this.peekMeta(l1Name, skillId);
    if (current === null) return null;
    if (current.successes + successes < 0 || current.failures + failures < 0) {
      throw new Error(
        `counter compensation would make ${l1Name}/${skillId} negative (store ${current.successes}✓/${current.failures}✗)`
      );
    }
    return this.mutateMeta(
      l1Name,
      skillId,
      (cur) => ({
        ...cur,
        successes: Math.max(0, cur.successes + successes),
        failures: Math.max(0, cur.failures + failures),
        updatedAt: nowIso(),
      }),
      {
        kind: 'skill-counter-compensation',
        entity: `${l1Name}/${skillId}`,
        detail: { successes, failures, reason: args.reason.trim() },
      },
      { strict: true }
    );
  }

  /**
   * Bump the success counter for a known skill (no-op if not found).
   * `opts.via` names the EXECUTING atom when it differs from the owner
   * namespace (shared-catalog credit) — recorded in the ledger detail so
   * the cross-namespace channel that arms the no-validator paths stays
   * auditable ("who supplied the 3 successes"); inert for `ledger check`,
   * which only projects counters.
   */
  recordSuccess(l1Name: string, skillId: string, opts?: { via?: string }): void {
    this.bump(l1Name, skillId, 'success', {
      kind: 'skill-success',
      entity: `${l1Name}/${skillId}`,
      ...(opts?.via && opts.via !== l1Name ? { detail: { via: opts.via } } : {}),
    });
  }

  /** Bump the failure counter for a known skill (no-op if not found). */
  recordFailure(l1Name: string, skillId: string, opts?: { via?: string }): void {
    this.bump(l1Name, skillId, 'failure', {
      kind: 'skill-failure',
      entity: `${l1Name}/${skillId}`,
      ...(opts?.via && opts.via !== l1Name ? { detail: { via: opts.via } } : {}),
    });
  }

  /**
   * THE COUNTER AND ITS EVENT ARE ONE TRANSACTION (T6).
   *
   * The sidecar era could only ORDER the two writes: the append came after
   * the bump, because a bump that silently no-ops (a dropped recipe still
   * named by an in-flight run) must not leave an event for a counter that
   * never moved — the store BELOW the ledger, the one direction `check`
   * reports as IMPOSSIBLE. A row gets the guarantee the atom side always
   * had: the increment is one statement computed by SQLite, the event is
   * inserted in the same transaction, and neither lands without the other.
   *
   * @returns true when a counter was actually written.
   */
  private bump(
    l1Name: string,
    skillId: string,
    kind: 'success' | 'failure',
    event: Omit<LedgerEvent, 'at'>
  ): boolean {
    const dir = this.skillDir(l1Name, skillId);
    // No skill on disk at all — no SKILL.md, no skill folder. The
    // bump silently no-ops; the supervise loop must not create a
    // counter for a skill that doesn't exist.
    if (!existsSync(join(dir, 'SKILL.md'))) return false;
    const db = this.writeStore();
    this.assertNotNested(db);
    const afterCommit: (() => void)[] = [];
    const bumped = db.transaction((): boolean => {
      // Hand-written skills come WITHOUT a record. The first counter bump
      // seeds one at zero so future loads see persistent counters — observed
      // when seeding a kind:script skill via cat heredoc and watching its
      // counter stay empty. A record we cannot read (torn legacy sidecar) is
      // not a record at zero: refusing costs one uncounted run, preserves
      // the torn bytes, and writes no event.
      if (this.seedRow(db, l1Name, skillId, afterCommit) === null) return false;
      if (!bumpMetaRow(db, l1Name, skillId, kind, nowIso())) return false;
      this.recordEvent(event, db);
      return true;
    }).immediate();
    if (bumped) for (const run of afterCommit) run();
    return bumped;
  }
}

/**
 * Reject anything that could escape the skills root.
 *
 * The charset test alone did NOT do that: `.` and `..` are made entirely of
 * accepted characters, so `join(rootDir, '..', id)` walked straight out of
 * the namespace the function exists to enforce. REPRODUCED end to end — an
 * L2/L3 validator verdict carries an LLM-authored `branchName`
 * (`verdictSchema.branchName`), `L2Atom`/`L3Atom` pass it to
 * `AtomRegistry.branch` as `overrideName`, it becomes the atom NAME, and the
 * atom name is this component. A verdict emitting `".."` therefore wrote a
 * SKILL.md one directory above the skills root.
 *
 * Traversal is now rejected explicitly rather than as a side effect of the
 * charset, so the guarantee survives any future widening of the charset.
 */
function sanitise(s: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || /^\.+$/.test(s)) {
    throw new Error(`unsafe skill path component: ${s}`);
  }
  return s;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Rename an imported legacy sidecar to `_meta.imported.json`: still
 * readable as evidence of what the file said, never a source again. A
 * previous import's file is replaced — the newest import is the one that
 * matters, and its bytes are already in the row.
 */
function retireSidecar(path: string): void {
  try {
    renameSync(path, join(path, '..', IMPORTED_META_FILENAME));
  } catch {
    /* a sidecar we cannot rename is ignored by every reader while its row exists */
  }
}

/**
 * Write a LEGACY sidecar atomically. No production path writes one since
 * 2026-09-18; this remains for fixtures that model a pre-import tree.
 *
 * The temporary file lives beside the target so rename cannot cross a
 * filesystem boundary. `wx` prevents an astronomically unlikely UUID
 * collision from truncating someone else's temp file; the finally cleanup is
 * harmless after a successful rename and removes debris after any exception.
 */
export function writeMetaAtomic(path: string, meta: SkillMeta): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(meta, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/** Read a legacy sidecar tolerantly: absent → zeros, unreadable → warn and zeros. */
function readMeta(path: string): SkillMeta {
  if (!existsSync(path)) return { successes: 0, failures: 0, updatedAt: nowIso() };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    assertSkillMetaShape(parsed);
    const obj = parsed;
    const promotionRefusedAt =
      typeof obj.promotionRefusedAt === 'string' && obj.promotionRefusedAt.length > 0
        ? obj.promotionRefusedAt
        : undefined;
    // The reason is meaningless without its stamp — a hand-edited meta that
    // deleted the stamp but left the reason reads as unstamped.
    const promotionRefusedReason =
      promotionRefusedAt &&
      typeof obj.promotionRefusedReason === 'string' &&
      obj.promotionRefusedReason.length > 0
        ? obj.promotionRefusedReason.slice(0, REFUSAL_REASON_MAX_CHARS)
        : undefined;
    const directFailures =
      typeof obj.directFailures === 'number' && obj.directFailures > 0
        ? Math.floor(obj.directFailures)
        : undefined;
    return {
      successes: obj.successes,
      failures: obj.failures,
      updatedAt: obj.updatedAt,
      ...(promotionRefusedAt ? { promotionRefusedAt } : {}),
      ...(promotionRefusedReason ? { promotionRefusedReason } : {}),
      ...(promotionRefusedAt && typeof obj.promotionRefusedGeneration === 'string' && obj.promotionRefusedGeneration.length > 0
        ? { promotionRefusedGeneration: obj.promotionRefusedGeneration }
        : {}),
      ...(typeof obj.compiledGeneration === 'string' && obj.compiledGeneration.length > 0
        ? { compiledGeneration: obj.compiledGeneration }
        : {}),
      ...(obj.provenance &&
      typeof obj.provenance === 'object' &&
      !Array.isArray(obj.provenance) &&
      typeof (obj.provenance as unknown as Record<string, unknown>)['mechanism'] === 'string'
        ? { provenance: obj.provenance }
        : {}),
      ...(directFailures ? { directFailures } : {}),
      ...(typeof obj.matches === 'number' && obj.matches > 0
        ? { matches: Math.floor(obj.matches) }
        : {}),
      ...(typeof obj.lastMatchedAt === 'string' && obj.lastMatchedAt.length > 0
        ? { lastMatchedAt: obj.lastMatchedAt }
        : {}),
      ...(Array.isArray(obj.declaredWrites) &&
      obj.declaredWrites.every((w): w is string => typeof w === 'string' && w.length > 0)
        ? { declaredWrites: obj.declaredWrites }
        : {}),
    };
  } catch (err) {
    // LOUD, and mutation callers are told. A torn sidecar used to become a
    // silent 0/0 that the next whole-object write persisted; every mutation
    // now enters through `seedRow`, which refuses to import it. Recovery is a
    // hand edit, or `npm run ledger -- check`, which can still project the
    // counters.
    corruptMetaPaths.add(path);

    console.warn(
      `[skills] unreadable ${path} (${(err as Error).message}) — counters left ALONE rather than reset. Repair it by hand or check \`npm run ledger -- tail\`.`
    );
    return { successes: 0, failures: 0, updatedAt: nowIso() };
  }
}

function assertSkillMetaShape(value: unknown): asserts value is SkillMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata root must be an object');
  }
  const obj = value as Record<string, unknown>;
  for (const field of ['successes', 'failures'] as const) {
    const count = obj[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`metadata ${field} must be a non-negative safe integer`);
    }
  }
  if (typeof obj['updatedAt'] !== 'string' || obj['updatedAt'].length === 0) {
    throw new Error('metadata updatedAt must be a non-empty string');
  }
  for (const field of ['directFailures', 'matches'] as const) {
    const count = obj[field];
    if (
      count !== undefined &&
      (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    ) {
      throw new Error(`metadata ${field} must be a non-negative safe integer when present`);
    }
  }
  for (const field of [
    'promotionRefusedAt',
    'promotionRefusedReason',
    'promotionRefusedGeneration',
    'compiledGeneration',
    'lastMatchedAt',
  ] as const) {
    const text = obj[field];
    if (text !== undefined && (typeof text !== 'string' || text.length === 0)) {
      throw new Error(`metadata ${field} must be a non-empty string when present`);
    }
  }
  const provenance = obj['provenance'];
  if (provenance !== undefined) {
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
      throw new Error('metadata provenance must be an object when present');
    }
    const record = provenance as Record<string, unknown>;
    if (
      !['distilled', 'revised', 'compiled', 'hand-authored'].includes(
        String(record['mechanism'])
      )
    ) {
      throw new Error('metadata provenance.mechanism is invalid');
    }
    for (const field of ['model', 'at'] as const) {
      const text = record[field];
      if (text !== undefined && (typeof text !== 'string' || text.length === 0)) {
        throw new Error(`metadata provenance.${field} must be a non-empty string when present`);
      }
    }
  }
}

/**
 * Paths whose last read failed to parse. `loadFor` keeps the tolerant
 * read-and-warn contract; the import path consults this state through
 * `readMetaChecked` and fails closed.
 */
const corruptMetaPaths = new Set<string>();

/** `readMeta`, plus whether the file was unreadable rather than absent. */
export function readMetaChecked(path: string): { meta: SkillMeta; corrupt: boolean } {
  corruptMetaPaths.delete(path);
  const meta = readMeta(path);
  return { meta, corrupt: corruptMetaPaths.has(path) };
}

/**
 * Tiny frontmatter parser. Accepts:
 *   ---
 *   id: <kebab>
 *   description: <single line>
 *   when_to_use: <single line>
 *   kind: llm | script
 *   ---
 *   <markdown body>
 *
 * Single-line values only; embedded newlines / lists / nested keys
 * not supported in phase 1. We snake_case the YAML keys to follow
 * the Claude Skills convention; runtime types stay camelCase.
 */
export function parseFrontmatter(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md missing frontmatter delimiters');
  const head = m[1] ?? '';
  const body = (m[2] ?? '').trim();
  const lines = head.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error(`malformed frontmatter line: ${line}`);
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip optional surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  // Agent Skills spec compliance: the canonical key is `name`
  // (agentskills.io base spec — 1-64 chars, kebab, must match the parent
  // directory, all of which atoma's id rules already guarantee). Runtime
  // identity stays `Skill.id`.
  const id = fields['name'];
  const description = fields['description'];
  const whenToUse = fields['when_to_use'];
  const kindRaw = fields['kind'] ?? 'llm';
  const languageRaw = fields['language'];
  if (!id) throw new Error('SKILL.md frontmatter missing required field: name');
  if (!description) throw new Error('SKILL.md frontmatter missing required field: description');
  if (!whenToUse) throw new Error('SKILL.md frontmatter missing required field: when_to_use');
  if (kindRaw !== 'llm' && kindRaw !== 'script') {
    throw new Error(`SKILL.md frontmatter "kind" must be llm | script, got: ${kindRaw}`);
  }
  // Language is required for kind:script, forbidden for kind:llm.
  let language: SkillLanguage | undefined;
  if (kindRaw === 'script') {
    if (!languageRaw) {
      throw new Error('SKILL.md frontmatter kind:"script" requires a "language" field (node|python|bash)');
    }
    if (languageRaw !== 'node' && languageRaw !== 'python' && languageRaw !== 'bash') {
      throw new Error(`SKILL.md frontmatter "language" must be node|python|bash, got: ${languageRaw}`);
    }
    language = languageRaw;
  } else if (languageRaw) {
    throw new Error(`SKILL.md frontmatter "language" only valid with kind:"script"; got language=${languageRaw} on kind:llm`);
  }
  // Trigger marks an EVENT-DRIVEN skill (recovery guidance matched against
  // mid-run events) — guidance cannot be a script, so the combination is a
  // structural error, not a tolerated variant.
  const trigger = fields['trigger'];
  if (trigger && kindRaw === 'script') {
    throw new Error('SKILL.md frontmatter "trigger" only valid with kind:"llm" — event skills are guidance, not scripts');
  }
  return {
    frontmatter: {
      id,
      description,
      whenToUse,
      kind: kindRaw,
      ...(language ? { language } : {}),
      ...(trigger ? { trigger } : {}),
    },
    body,
  };
}

/**
 * Inverse of parseFrontmatter — emits a minimal canonical SKILL.md text
 * with the spec-canonical `name` key.
 */
export function renderFrontmatter(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = [
    '---',
    `name: ${frontmatter.id}`,
    `description: ${frontmatter.description}`,
    `when_to_use: ${frontmatter.whenToUse}`,
    `kind: ${frontmatter.kind}`,
  ];
  if (frontmatter.language) lines.push(`language: ${frontmatter.language}`);
  if (frontmatter.trigger) lines.push(`trigger: ${frontmatter.trigger}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}
