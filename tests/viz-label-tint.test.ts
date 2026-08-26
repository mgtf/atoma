import { describe, expect, it } from 'vitest';
import {
  NO_TINT,
  multiplyTint,
  tintColor,
} from '../src/viz/client-gl/renderer/label-tint.js';
import { GPU_COLORS } from '../src/viz/client-gl/theme.js';

/** What the GPU does with a tint: multiply, per channel, in 0..1. */
function render(base: number, tint: number): number {
  const ch = (c: number, shift: number) => (c >> shift) & 0xff;
  const mul = (shift: number) =>
    Math.round((ch(base, shift) * ch(tint, shift)) / 255) & 0xff;
  return (mul(16) << 16) | (mul(8) << 8) | mul(0);
}

describe('multiplyTint', () => {
  it('produces the tint that renders a bright label at the idle colour', () => {
    // The exact pair the buttons use. This is the whole point of the helper:
    // labels are built at GPU_COLORS.text and dimmed per-instance, because
    // dimming through the SHARED TextStyle recoloured every label at once.
    const tint = multiplyTint(GPU_COLORS.text, 0xa9b5ca);
    expect(render(GPU_COLORS.text, tint)).toBe(0xa9b5ca);
  });

  it('round-trips a range of dimmings exactly', () => {
    for (const target of [0x000000, 0x334455, 0x808080, 0xa9b5ca, 0xe6edf7]) {
      expect(render(0xe6edf7, multiplyTint(0xe6edf7, target))).toBe(target);
    }
  });

  it('is the identity when source and target match', () => {
    expect(multiplyTint(0xe6edf7, 0xe6edf7)).toBe(NO_TINT);
  });

  it('clamps rather than pretending a multiply can brighten', () => {
    // 0x40 cannot be lifted to 0xff by multiplying, so the channel saturates.
    expect(multiplyTint(0x404040, 0xffffff)).toBe(NO_TINT);
    expect(render(0x404040, multiplyTint(0x404040, 0xffffff))).toBe(0x404040);
  });

  it('leaves a zero channel alone instead of dividing by zero', () => {
    // R is 0 in the source and cannot be lifted by a multiply, so it yields
    // 0xff (no change) rather than Infinity; G and B still scale normally.
    expect(multiplyTint(0x00ff80, 0x00ff40)).toBe(0xffff80);
    // An all-zero source is the degenerate case and must stay a valid colour.
    expect(multiplyTint(0x000000, 0xffffff)).toBe(NO_TINT);
    expect(Number.isNaN(multiplyTint(0x000000, 0xffffff))).toBe(false);
  });

  it('never emits a channel outside a byte', () => {
    for (const from of [0x010203, 0xffffff, 0x000000, 0x7f7f7f]) {
      for (const to of [0x000000, 0xffffff, 0x123456]) {
        const tint = multiplyTint(from, to);
        expect(tint).toBeGreaterThanOrEqual(0);
        expect(tint).toBeLessThanOrEqual(0xffffff);
      }
    }
  });
});

describe('tintColor', () => {
  it('returns the source colour for Pixi no-tint white', () => {
    expect(tintColor(0x172a49, NO_TINT)).toBe(0x172a49);
  });

  it('applies every packed channel as a multiplicative factor', () => {
    expect(tintColor(0x804020, 0x80ff40)).toBe(0x404008);
  });
});
