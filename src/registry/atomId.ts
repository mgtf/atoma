import { randomUUID } from 'node:crypto';

/**
 * Surrogate identity for an atom type — invariant T4 in
 * docs/saas-architecture.md.
 *
 * WHAT THIS REPLACES. A taxonomy name currently does triple duty: display
 * label, identity, and filesystem namespace (`SkillRegistry.namespaceDir` is
 * `join(rootDir, sanitise(l1Name))`). That coupling has already produced two
 * confirmed defects — `sanitise` accepting `..` while an LLM-authored
 * `overrideName` became a path component, and a post-`remove` `branch`
 * reissuing a dead name and inheriting its skill directory. Both are closed
 * pointwise and regression-tested; the coupling that produced them is what
 * this id removes.
 *
 * WHY NOT `(tier, ordinal)`, WHICH IS ALREADY THE PRIMARY KEY. It is stable
 * — ordinals are allocated over live ∪ history and never reissued — but it is
 * only unique WITHIN one store. atoma is heading for a hosted platform beside
 * customer-operated on-premise installs, so two stores allocating `(1, 42)`
 * independently is the normal case, not the exotic one. Anything that later
 * moves, reconciles or shares an atom across stores needs an identifier that
 * cannot collide, and a store-local ordinal cannot provide it.
 *
 * WHY NOT A ULID, WHICH §5/T4 NAMES. A ULID adds lexicographic ordering by
 * creation time, which is redundant here — `created_at` is already a column —
 * and would add a dependency for id generation alone. `randomUUID` is in the
 * Node standard library and satisfies the property the invariant is actually
 * about: a surrogate that never collides and carries no meaning. The
 * deviation is deliberate; T4's requirement is met, its spelling is not.
 *
 * PATH SAFETY (T5). The generated form is `[0-9a-f-]{36}`, so it can never
 * traverse: no dots, no separators, no LLM-authored bytes. `isAtomId` is the
 * assertion to make before an id is used as a path component, so the
 * guarantee is checked rather than assumed.
 */
export function newAtomId(): string {
  return randomUUID();
}

/** Exact shape of a generated atom id — see PATH SAFETY above. */
export function isAtomId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
