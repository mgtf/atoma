/**
 * Per-label colour WITHOUT touching a shared `TextStyle`.
 *
 * The renderer deliberately shares one `TextStyle` per visual style so Pixi's
 * text-texture cache can hit at all (`AbstractText.styleKey` is keyed on
 * `style.uid`/`style._tick`, i.e. instance identity — a per-label style makes
 * every key unique and the cache dead on arrival). `GpuRenderer.textStyle`
 * says so and states the consequence: "Styles here are immutable once built:
 * mutating one would invalidate every label drawn with it."
 *
 * The button hover code then did exactly that — `labelText.style.fill = …` on
 * hover — with two results. Visibly, EVERY label sharing that style changed
 * colour, so rolling over one button lit up all of them. Invisibly, each
 * transition bumped `_tick` and invalidated the texture cache the sharing
 * exists to enable, so the hover also re-rasterised every one of those labels.
 *
 * `tint` is the per-instance channel for this. It MULTIPLIES, so a label must
 * be built at its brightest colour and tinted down; `multiplyTint` computes the
 * exact factor that takes `from` to `to`, and clamps rather than pretending a
 * multiply can brighten.
 */

/** Clamp to a byte, guarding NaN into 0 rather than through `Math.min`. */
function channel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function split(color: number): [number, number, number] {
  const c = channel(color >> 16 & 0xff);
  const m = channel(color >> 8 & 0xff);
  const y = channel(color & 0xff);
  return [c, m, y];
}

/**
 * The tint that renders a label built in `from` as `to`.
 *
 * A channel of `from` at 0 cannot be lifted by a multiply, so it yields 0xff
 * (no change) — the honest result, rather than a division by zero. A `to`
 * brighter than `from` clamps to 0xff for that channel: build the label
 * brighter if you need it brighter.
 */
export function multiplyTint(from: number, to: number): number {
  const [fr, fg, fb] = split(from);
  const [tr, tg, tb] = split(to);
  const ratio = (f: number, t: number): number => (f === 0 ? 0xff : channel(t / f * 255));
  return (ratio(fr, tr) << 16) | (ratio(fg, tg) << 8) | ratio(fb, tb);
}

/** No-op tint: what a pooled label must be reset to before reuse. */
export const NO_TINT = 0xffffff;

/**
 * Blend two colours per channel. Used to give a control a FAMILY identity
 * without shouting it: a filter chip at rest carries its kind's colour mixed
 * most of the way back toward the neutral idle grey, so five chips read as
 * five categories rather than as five alerts.
 */
export function mixColor(from: number, to: number, amount: number): number {
  const t = Math.max(0, Math.min(1, amount));
  const [fr, fg, fb] = split(from);
  const [tr, tg, tb] = split(to);
  const blend = (a: number, b: number): number => channel(a + (b - a) * t);
  return (blend(fr, tr) << 16) | (blend(fg, tg) << 8) | blend(fb, tb);
}
