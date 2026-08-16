/**
 * Retained text labels — THE reason a re-render stops being a re-rasterisation.
 *
 * `GpuRenderer.render()` tears the scene down and rebuilds it on every state
 * change, and scroll offsets live in that state: one wheel tick destroys and
 * re-creates every visible label. Each `new Text()` costs a canvas2D
 * measurement, a rasterisation and a texture upload, and Pixi's own text
 * texture cache cannot absorb it — `AbstractText.styleKey` is
 * `${text}:${style.uid}-${style._tick}:${resolution}`, so a per-label
 * `new TextStyle()` makes every key unique by construction and the cache never
 * hits. Sharing styles fixes the key; this cache keeps the `Text` objects
 * themselves alive so the work is not redone at all.
 *
 * Contract for the caller, in `render()` order:
 *
 *   1. `beginRender()` BEFORE tearing the scene down. It detaches every
 *      retained label from its parent, so the caller's recursive
 *      `destroy({ children: true })` walks past them instead of through them.
 *   2. `acquire(key, create)` while drawing. Same key twice in one render
 *      returns two distinct labels — a pool per key, indexed by use order,
 *      because the same string can legitimately appear twice on screen.
 *   3. `endRender()` at the end. Keys unused for `maxIdleRenders` consecutive
 *      renders are released, and a key drawn fewer times than it was pooled
 *      for gives its surplus back immediately.
 *
 * Retention is therefore bounded by construction: what the last
 * `maxIdleRenders + 1` renders drew, and the views are virtualised, so that is
 * a small multiple of one viewport — not of the run.
 *
 * `release` must detach the label from any shared style before destroying it.
 * Pixi's `AbstractText.destroy()` does NOT unsubscribe from its style's
 * `update` event, so a shared style would accumulate one listener per evicted
 * label, each holding the destroyed label alive. Assigning a throwaway style
 * first goes through the setter, which does unsubscribe.
 */

export interface LabelCacheHooks<T> {
  /** Remove from the parent container so a container teardown skips it. */
  detach(label: T): void;
  /** Evict for good: unsubscribe from shared state, then destroy. */
  release(label: T): void;
  /**
   * True when something OUTSIDE the cache destroyed this label.
   *
   * The cache lends labels out; it does not own what callers do with the
   * containers it lends them into. An animation that outlives its render and
   * ends in `container.destroy({ children: true })` walks straight through a
   * retained label and destroys it, and the pool has no way to notice — the
   * next `acquire` hands back a corpse whose `position` is null, and the
   * renderer dies on `label.position.set(...)` several renders later, far from
   * the code that caused it. Measured on RUNS↔SKILLS navigation once the view
   * transition had time to complete (560ms) before the next one started.
   *
   * The two sites that did that now detach first, which is the real fix. This
   * hook is the backstop that keeps the whole CLASS of mistake from reaching
   * the renderer, because the cache is the one place every reuse passes
   * through.
   */
  isDestroyed?(label: T): boolean;
}

export interface LabelCacheOptions<T> extends LabelCacheHooks<T> {
  /**
   * Consecutive renders a key may go unused before eviction. The default of 2
   * spans a scroll tick and a poll refresh, so a label leaving the viewport
   * and coming straight back is still free.
   */
  maxIdleRenders?: number;
}

interface LabelPool<T> {
  labels: T[];
  used: number;
  idle: number;
}

export class LabelCache<T> {
  private readonly pools = new Map<string, LabelPool<T>>();
  private readonly hooks: LabelCacheHooks<T>;
  private readonly maxIdleRenders: number;
  private createdThisRender = 0;
  private reusedThisRender = 0;

  constructor(options: LabelCacheOptions<T>) {
    this.hooks = options;
    this.maxIdleRenders = options.maxIdleRenders ?? 2;
  }

  /** Detach every retained label and reset per-render use counts. */
  beginRender(): void {
    this.createdThisRender = 0;
    this.reusedThisRender = 0;
    for (const pool of this.pools.values()) {
      pool.used = 0;
      // A label destroyed behind the cache's back cannot be detached or
      // released; touching one throws inside Pixi. Skipping is safe: it is
      // replaced in place on the next `acquire` for its slot.
      for (const label of pool.labels) {
        if (!this.hooks.isDestroyed?.(label)) this.hooks.detach(label);
      }
    }
  }

  /**
   * A label for `key`, reused when one is pooled and not already handed out
   * this render. `create` builds a fresh one otherwise.
   */
  acquire(key: string, create: () => T): T {
    let pool = this.pools.get(key);
    if (!pool) {
      pool = { labels: [], used: 0, idle: 0 };
      this.pools.set(key, pool);
    }
    const index = pool.used++;
    const pooled = pool.labels[index];
    if (pooled !== undefined && !this.hooks.isDestroyed?.(pooled)) {
      this.reusedThisRender++;
      return pooled;
    }
    this.createdThisRender++;
    const label = create();
    // Replace IN PLACE when a destroyed label is being evicted: `used` is
    // already past this slot, so pushing would shift every later index and
    // hand the next caller the wrong label.
    if (pooled !== undefined) pool.labels[index] = label;
    else pool.labels.push(label);
    return label;
  }

  /** Release surplus labels and keys that have gone idle too long. */
  endRender(): void {
    for (const [key, pool] of this.pools) {
      if (pool.used === 0) {
        pool.idle++;
        if (pool.idle > this.maxIdleRenders) {
          for (const label of pool.labels) {
            if (!this.hooks.isDestroyed?.(label)) this.hooks.release(label);
          }
          this.pools.delete(key);
        }
        continue;
      }
      pool.idle = 0;
      // Drawn fewer times than pooled for: the surplus is dead weight now.
      // Immediate, because the key stays hot and would otherwise never be
      // revisited by the idle sweep above.
      for (const label of pool.labels.splice(pool.used)) {
        if (!this.hooks.isDestroyed?.(label)) this.hooks.release(label);
      }
    }
  }

  /** Release everything. The cache is reusable afterwards. */
  clear(): void {
    for (const pool of this.pools.values()) {
      for (const label of pool.labels) {
        if (this.hooks.isDestroyed?.(label)) continue;
        this.hooks.detach(label);
        this.hooks.release(label);
      }
    }
    this.pools.clear();
  }

  /** Retained label count — bookkeeping for tests and diagnostics. */
  get size(): number {
    let total = 0;
    for (const pool of this.pools.values()) total += pool.labels.length;
    return total;
  }

  /**
   * Labels built from scratch in the current render — the ones that paid a
   * canvas measurement, a rasterisation and a texture upload. This is the
   * direct measure of whether retention is working: on a scroll tick over
   * already-seen content it should be a small fraction of `reused`.
   */
  get created(): number {
    return this.createdThisRender;
  }

  /** Labels served from the pool in the current render. */
  get reused(): number {
    return this.reusedThisRender;
  }
}
