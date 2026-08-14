import { describe, expect, it } from 'vitest';
import {
  ATOMA_MARK_TURN_MS,
  buildAtomaMarkFrame,
} from '../src/viz/client-gl/brand-mark.js';

describe('Atoma GPU brand mark', () => {
  it('keeps one readable, depth-sorted crystal with all three rank colors', () => {
    const frame = buildAtomaMarkFrame(0);
    expect(frame.faces).toHaveLength(6);
    expect(new Set(frame.faces.map((face) => face.tier))).toEqual(new Set([1, 2, 3]));

    for (let index = 1; index < frame.faces.length; index += 1) {
      expect(frame.faces[index]!.depth).toBeGreaterThanOrEqual(frame.faces[index - 1]!.depth);
    }
    for (const face of frame.faces) {
      const [a, b, c] = face.points;
      const twiceArea = Math.abs(
        a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)
      );
      expect(twiceArea).toBeGreaterThan(0.1);
      expect(face.fillColor).toBeGreaterThanOrEqual(0);
      expect(face.fillColor).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('turns briskly and changes face lighting without becoming frantic', () => {
    expect(ATOMA_MARK_TURN_MS).toBeGreaterThanOrEqual(8_000);
    expect(ATOMA_MARK_TURN_MS).toBeLessThanOrEqual(12_000);

    const start = buildAtomaMarkFrame(0);
    const quarterTurn = buildAtomaMarkFrame(ATOMA_MARK_TURN_MS / 4);
    expect(quarterTurn.yaw - start.yaw).toBeGreaterThan(1.45);
    expect(quarterTurn.yaw - start.yaw).toBeLessThan(1.75);

    const startColors = new Map(start.faces.map((face) => [face.id, face.fillColor]));
    expect(quarterTurn.faces.some((face) => startColors.get(face.id) !== face.fillColor)).toBe(true);
  });

  it('bounds its breathing motion and core pulse', () => {
    for (const elapsedMs of [0, 250, 1_000, 5_000, 30_000]) {
      const frame = buildAtomaMarkFrame(elapsedMs);
      expect(frame.scale).toBeGreaterThanOrEqual(0.978);
      expect(frame.scale).toBeLessThanOrEqual(1.002);
      expect(frame.pulse).toBeGreaterThanOrEqual(0);
      expect(frame.pulse).toBeLessThanOrEqual(1);
    }
  });
});
