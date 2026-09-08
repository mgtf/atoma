import type { RegistryOwner } from '../contracts/registryOwner.js';
import { randomUUID } from 'node:crypto';
import {
  AtomRegistry,
  type AtomType,
  type CreateSeed,
} from '../registry/atomRegistry.js';
import type { DB } from '../registry/db.js';
import type { AtomModifications, Tier } from '../core/types.js';
import {
  snapshotType,
  type TraceRecorder,
  type VizAtomRef,
} from './trace.js';

/**
 * AtomRegistry subclass that logs every create / patch / branch / counter
 * bump into a TraceRecorder. Drops in wherever the base class was used —
 * both examples accept `AtomRegistry` so this is a one-line swap.
 */
export class RecordingRegistry extends AtomRegistry {
  constructor(db: DB, private readonly recorder: TraceRecorder, owner?: RegistryOwner, authorize?: () => boolean) {
    super(db, owner, authorize);
  }

  private ref(name: string): VizAtomRef {
    const type = this.getByName(name);
    return {
      name,
      ...(type ? { tier: type.tier } : {}),
    };
  }

  private childRef(type: AtomType): VizAtomRef {
    return { name: type.name, tier: type.tier };
  }

  override create(tier: Tier, seed: CreateSeed): AtomType {
    const t = super.create(tier, seed);
    this.recorder.record({
      id: randomUUID(),
      ts: Date.now(),
      kind: 'registry',
      op: 'create',
      tier: t.tier,
      name: t.name,
      by: seed.createdBy,
      actor: this.ref(seed.createdBy),
      child: this.childRef(t),
      version: t.version,
      snapshot: snapshotType(t),
    });
    return t;
  }

  override patch(
    name: string,
    mods: AtomModifications,
    modifiedBy: string,
    reason?: string
  ): AtomType {
    const before = this.getByName(name);
    const t = super.patch(name, mods, modifiedBy, reason);
    // `AtomRegistry.patch` short-circuits no-op patches (merged ≡ current).
    // When that happens the version stays the same and nothing was persisted;
    // we mirror that by not emitting a registry event at all, so the viz
    // timeline doesn't surface ghost `patch` entries.
    if (before && t.version === before.version) return t;
    const evt = {
      id: randomUUID(),
      ts: Date.now(),
      kind: 'registry' as const,
      op: 'patch' as const,
      tier: t.tier,
      name: t.name,
      by: modifiedBy,
      actor: this.ref(modifiedBy),
      child: this.childRef(t),
      version: t.version,
      modifications: mods,
      snapshot: snapshotType(t),
      ...(before ? { from: `${before.name}@v${before.version}` } : {}),
      ...(reason ? { reason } : {}),
    };
    this.recorder.record(evt);
    return t;
  }

  override branch(
    fromName: string,
    mods: AtomModifications,
    createdBy: string,
    overrideName?: string
  ): AtomType {
    const t = super.branch(fromName, mods, createdBy, overrideName);
    this.recorder.record({
      id: randomUUID(),
      ts: Date.now(),
      kind: 'registry',
      op: 'branch',
      tier: t.tier,
      name: t.name,
      by: createdBy,
      actor: this.ref(createdBy),
      child: this.childRef(t),
      from: fromName,
      version: t.version,
      modifications: mods,
      snapshot: snapshotType(t),
    });
    return t;
  }

  override recordSuccess(name: string, by?: string): void {
    super.recordSuccess(name, by);
    const target = this.getByName(name);
    this.recorder.record({
      id: randomUUID(),
      ts: Date.now(),
      kind: 'registry',
      op: 'recordSuccess',
      name,
      ...(by ? { by, actor: this.ref(by) } : {}),
      ...(target
        ? { tier: target.tier, child: this.childRef(target), version: target.version }
        : {}),
    });
  }

  override recordFailure(name: string, by?: string): void {
    super.recordFailure(name, by);
    const target = this.getByName(name);
    this.recorder.record({
      id: randomUUID(),
      ts: Date.now(),
      kind: 'registry',
      op: 'recordFailure',
      name,
      ...(by ? { by, actor: this.ref(by) } : {}),
      ...(target
        ? { tier: target.tier, child: this.childRef(target), version: target.version }
        : {}),
    });
  }
}
