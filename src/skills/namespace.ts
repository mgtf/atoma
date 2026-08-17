declare const brand: unique symbol;

/**
 * The key a skill namespace is filed under on disk.
 *
 * WHAT THIS IS FOR. The atom NAME is being demoted from identity to display
 * label (T4). `SkillRegistry` keys directories by name today and must key them
 * by `atomId`. Both are `string`, so the swap is one TypeScript would wave
 * straight through: a production site left passing a name would typecheck, run,
 * and quietly file skills under a namespace nothing else reads. This brand
 * exists so the compiler refuses that.
 *
 * WHERE THE BRAND APPLIES, AND WHERE IT DELIBERATELY DOES NOT. It types the
 * production CARRIERS — `ownerNs`, `activeSkillNs`, `blameNs`, `args.l1Name`
 * and friends — so nothing can put a bare `atom.name` into one. It is NOT on
 * `SkillRegistry`'s public parameters, and that is a deliberate limit rather
 * than an oversight:
 *
 *   - The store is genuinely KEY-AGNOSTIC. `namespaceDir` is
 *     `join(rootDir, sanitise(ns))`; it files skills under whatever key it is
 *     handed and reads them back from the same one. A namespace is not
 *     required to be an atom id for the store to be correct, and asserting
 *     that it is would over-constrain a component whose contract is "give me a
 *     key".
 *   - Consequently ~280 test call sites that pass `'Water'` as an arbitrary
 *     opaque key are CORRECT both before and after the flip. Branding the
 *     public API would have rewritten all of them to buy a guarantee about
 *     production code that the carrier typing already provides.
 *
 * WHAT ACTUALLY GUARDS THE FLIP is therefore not a type at the store boundary
 * but a behavioural test through the production path: create an atom, drive a
 * skill through the real lifecycle, and assert the directory on disk is the
 * atom's id. Unit tests that mint their own namespaces cannot catch a
 * production path still looking up by name — only exercising that path can.
 */
export type SkillNamespace = string & { readonly [brand]: 'SkillNamespace' };

/**
 * The namespace an atom's skills belong to — the ONE derivation.
 *
 * Takes the whole identity rather than one field so which field is load-bearing
 * stops being the caller's business. Callers already hold an atom or a registry
 * type, so this is not extra work for them; it is the choke point that makes
 * the name→id change a one-line edit here instead of a hunt.
 */
export function namespaceOf(atom: {
  readonly atomId: string;
  readonly name: string;
}): SkillNamespace {
  // FLIP POINT. Still the NAME, so wiring the call sites through this function
  // changes no behaviour and can be verified on its own. Becomes `atom.atomId`
  // in the same commit as the on-disk migration and not before: the moment this
  // returns an id, the directories still called Water, Methane and Ammonia stop
  // being found, and every skill in them goes silently missing.
  return atom.name as SkillNamespace;
}

/**
 * Re-admit a namespace that came OUT of the store (`listNamespaces`, the
 * visibility lattice, an operator CLI argument, an MCP request parameter).
 *
 * Values read back from the store are namespaces by construction — they were
 * written as one — so this is a widening, not a conversion. It is the only
 * sanctioned way to make a `SkillNamespace` without an atom, kept separate from
 * `namespaceOf` so that grepping this name lists every place that trusts a
 * string it did not derive itself.
 */
export function asStoredNamespace(raw: string): SkillNamespace {
  return raw as SkillNamespace;
}
