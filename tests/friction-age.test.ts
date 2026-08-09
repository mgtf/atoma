import { describe, it, expect } from 'vitest';
import { ageLabel } from '../src/cli/friction.js';

/**
 * The friction report's recency column, at SUB-DAY resolution.
 *
 * It shipped with day granularity and misled its author within the hour: the
 * favicon 404 — fixed at 09:01 that morning — read as `today` and therefore
 * as a live signature, because the runs that produced it had started at
 * 04:39. Day granularity cannot separate "before this morning's fix" from
 * "just now", which is exactly the day you need it to.
 */
describe('ageLabel', () => {
  const now = Date.now();

  it('reports minutes under an hour, and never "0m"', () => {
    expect(ageLabel(now)).toBe('1m');
    expect(ageLabel(now - 5 * 60_000)).toBe('5m');
    expect(ageLabel(now - 59 * 60_000)).toBe('59m');
  });

  it('reports hours under a day — the resolution that was missing', () => {
    expect(ageLabel(now - 2 * 3_600_000)).toBe('2h');
    expect(ageLabel(now - 9 * 3_600_000)).toBe('9h');
    expect(ageLabel(now - 23 * 3_600_000)).toBe('23h');
  });

  it('reports days beyond that', () => {
    expect(ageLabel(now - 24 * 3_600_000)).toBe('1d');
    expect(ageLabel(now - 10 * 86_400_000)).toBe('10d');
  });

  it('degrades rather than lying when the timestamp is unusable', () => {
    expect(ageLabel(0)).toBe('?');
    expect(ageLabel(Number.NaN)).toBe('?');
  });
});
