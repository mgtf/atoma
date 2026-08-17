import type { SkillNamespace } from './namespace.js';
import { bucketIdForToolNames, bucketRequiredToolNames } from '../atoms/capability.js';

/**
 * SHARED-CATALOG VISIBILITY LATTICE (commit B of the bucket-namespace plan).
 * ==========================================================================
 * Skills stay stored per-L1 (`./skills/<l1-name>/` — ZERO migration; the
 * adversarial design pass rejected bucket directories: the flagship
 * duplicated replay recipes lived in DIFFERENT buckets, `sanitise` rejects
 * the `+` in bucket ids, and a re-key would have orphaned ~290 ledger
 * events). What becomes bucket-shaped is VISIBILITY at match time:
 *
 *   a donor namespace is visible to a reader iff the donor's bucket is
 *   EXECUTABLE by the reader — `required(bucket(donorTools)) ⊆ readerTools`.
 *
 * A subset test, not bucket equality, so the lattice composes: an
 * http-bucket reader (which has write_file + run_shell) can execute
 * file-scribe recipes; a file-scribe reader cannot execute http recipes.
 * This delivers the two measured wins — cross-host duplication (the same
 * logical recipe matured twice, 14 runs) and branch amnesia (an escalation
 * branch starts with an empty catalog exactly when the repertoire matters:
 * a toolset-preserving branch now inherits its lineage's whole bucket view
 * on its first run) — while preserving the three guarantees that made
 * per-L1 namespaces defensible: toolset compatibility, comparable trust
 * evidence, bounded catalogs.
 *
 * Credit/blame still lands on the OWNER namespace (commit A′: the
 * (id, owner) pair rides the L1 instance). Writes (learn, save, bumps)
 * always target a per-L1 namespace; the lattice is read-only.
 *
 * Kill switch: ATOMA_SKILL_SHARED_CATALOG=0 restores the exact legacy
 * behaviour ([home] only) — same env-flag family as ATOMA_SKILL_DIRECT.
 */

export function sharedCatalogEnabled(): boolean {
  return process.env['ATOMA_SKILL_SHARED_CATALOG'] !== '0';
}

export function visibleSkillNamespaces(args: {
  /** The resolved L1's OWN namespace — the write target and always first. */
  home: SkillNamespace;
  /** Declared tool names of the resolved L1 (the reader). */
  readerToolNames: readonly string[];
  /** All namespaces present in the skill store. */
  namespaces: readonly SkillNamespace[];
  /**
   * Declared tool names of a namespace's L1 type, or null when the type
   * is no longer in the atom registry (orphaned namespace — never offered
   * as a donor: without a live toolset its bucket is unknowable).
   */
  toolNamesFor: (ns: SkillNamespace) => readonly string[] | null;
}): SkillNamespace[] {
  if (!sharedCatalogEnabled()) return [args.home];
  const readerSet = new Set(args.readerToolNames);
  const donors = args.namespaces
    .filter((ns) => ns !== args.home)
    .filter((ns) => {
      const donorTools = args.toolNamesFor(ns);
      if (donorTools === null) return false;
      const bucket = bucketIdForToolNames(donorTools);
      if (bucket === null) return false;
      const required = bucketRequiredToolNames(bucket);
      // Executability of the donor's CLASS by the reader — the lattice
      // test. Per-skill filters at match time (llm body text scan, script
      // ABI rule) then police individual recipes.
      return required !== null && required.every((r) => readerSet.has(r));
    })
    // Deterministic order — the prefilter decision cache hashes the
    // catalog text; an unstable order would produce permanent misses.
    .sort();
  return [args.home, ...donors];
}
