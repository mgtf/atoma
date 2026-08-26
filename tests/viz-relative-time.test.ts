import { describe, expect, it } from 'vitest';
import {
  RELATIVE_TIME_HORIZON_MS,
  absoluteTimestamp,
  relativeTime,
  relativeTimeParts,
  timestampMs,
  timestampTooltip,
} from '../src/viz/client-gl/renderer/relative-time.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { formatDateTime } from '../src/viz/client/date-format.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Midday, so a "yesterday" case cannot straddle midnight by accident. */
const NOW = new Date(2026, 7, 23, 12, 0, 0).getTime();

const fr = (key: string, vars?: Record<string, unknown>) => translate('fr', key, vars);
const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

describe('relative time buckets', () => {
  it('names each bucket the product asked for, in French', () => {
    const at = (age: number) => relativeTime(NOW - age, fr, 'fr-FR', NOW);
    expect(at(3 * SECOND)).toBe('il y a quelques secondes');
    expect(at(40 * SECOND)).toBe('il y a quelques secondes');
    expect(at(60 * SECOND)).toBe('il y a une minute');
    expect(at(10 * MINUTE)).toBe('il y a quelques minutes');
    expect(at(70 * MINUTE)).toBe('il y a une heure');
    expect(at(2 * HOUR)).toBe('il y a 2 heures');
    expect(at(DAY)).toBe('hier');
    expect(at(2 * DAY)).toBe('avant-hier');
    expect(at(3 * DAY)).toBe('il y a 3 jours');
    expect(at(8 * DAY)).toBe('il y a une semaine');
    expect(at(13 * DAY)).toBe('il y a une semaine');
  });

  it('translates the same buckets in English', () => {
    const at = (age: number) => relativeTime(NOW - age, en, 'en-GB', NOW);
    expect(at(3 * SECOND)).toBe('a few seconds ago');
    expect(at(10 * MINUTE)).toBe('a few minutes ago');
    expect(at(2 * HOUR)).toBe('2 hours ago');
    expect(at(2 * DAY)).toBe('the day before yesterday');
    expect(at(8 * DAY)).toBe('a week ago');
  });

  it('never says "1 days" or "1 weeks": the singular catalog entry fires', () => {
    // `count === 1` is exactly the case the buckets above route elsewhere, so
    // this pins the CATALOG rather than the routing — a future threshold move
    // must not be able to produce the plural form for one.
    expect(fr('time.daysAgo', { count: 1 })).toBe('hier');
    expect(fr('time.weeksAgo', { count: 1 })).toBe('il y a une semaine');
    expect(en('time.daysAgo', { count: 1 })).toBe('yesterday');
    expect(en('time.hoursAgo', { count: 1 })).toBe('an hour ago');
  });

  it('shows an exact date once the age passes two weeks', () => {
    const parts = relativeTimeParts(NOW - RELATIVE_TIME_HORIZON_MS, NOW);
    expect(parts.exact).toBe(true);
    // Just inside the horizon is still a phrase, so the boundary is pinned on
    // both sides rather than only where it is easy.
    expect(relativeTimeParts(NOW - RELATIVE_TIME_HORIZON_MS + SECOND, NOW).exact).toBe(false);
    const label = relativeTime(NOW - 40 * DAY, fr, 'fr-FR', NOW);
    expect(label).not.toContain('il y a');
    expect(label).toContain('2026');
  });

  it('counts "yesterday" by the CALENDAR day, not by 24 elapsed hours', () => {
    // 01:00 today, looking at 23:00 last night: two hours of elapsed time, but
    // the reader means "hier". An age/DAY floor would have said 0 days.
    const lateNight = new Date(2026, 7, 23, 1, 0, 0).getTime();
    const yesterdayEvening = new Date(2026, 7, 22, 23, 0, 0).getTime();
    expect(relativeTimeParts(yesterdayEvening, lateNight).key).toBe('time.hoursAgo');
    // And 23 hours ago, which crossed midnight, is yesterday rather than "23 hours".
    const yesterdayMorning = new Date(2026, 7, 22, 2, 0, 0).getTime();
    expect(relativeTimeParts(yesterdayMorning, lateNight).key).toBe('time.yesterday');
  });

  it('reports a future stamp as the freshest bucket, not a negative age', () => {
    // Clock skew between the server that stamped a row and the browser reading
    // it must not produce "il y a -3 secondes" or an exact date.
    expect(relativeTime(NOW + 5 * SECOND, fr, 'fr-FR', NOW)).toBe('il y a quelques secondes');
    expect(relativeTime(NOW + 3 * DAY, fr, 'fr-FR', NOW)).toBe('il y a quelques secondes');
  });

  it('takes an ISO string or epoch ms, and refuses to render "Invalid Date"', () => {
    const iso = new Date(NOW - 2 * HOUR).toISOString();
    expect(relativeTime(iso, fr, 'fr-FR', NOW)).toBe('il y a 2 heures');
    expect(timestampMs(iso)).toBe(NOW - 2 * HOUR);
    // A row with a broken stamp must still draw its other fields.
    expect(relativeTime('not a date', fr, 'fr-FR', NOW)).toBe('');
    expect(timestampMs('not a date')).toBeNull();
    expect(timestampTooltip('not a date', 'fr-FR')).toBeNull();
  });
});

describe('the hover bubble text', () => {
  it('formats the exact instant in the reader locale, with the time of day', () => {
    const at = new Date(2026, 7, 23, 14, 35, 7).getTime();
    const french = absoluteTimestamp(at, 'fr-FR');
    const english = absoluteTimestamp(at, 'en-GB');
    expect(french).not.toBe(english);
    expect(french.toLowerCase()).toContain('août');
    expect(english.toLowerCase()).toContain('august');
    // The relative phrase is lossy; the bubble is what makes it lossless, so it
    // must carry seconds and not just a date.
    for (const rendered of [french, english]) {
      expect(rendered).toContain('2026');
      expect(rendered).toMatch(/14[:h]35/);
      expect(rendered).toContain('07');
    }
  });
});

describe('human-readable metadata timestamps', () => {
  it('uses the reader locale without seconds and preserves invalid source values', () => {
    const at = '2026-08-28T14:32:47.000Z';
    const rendered = formatDateTime(at, 'fr-FR');
    expect(rendered.toLowerCase()).toContain('août');
    expect(rendered).toContain('2026');
    expect(rendered).not.toContain('47');
    expect(formatDateTime('not-an-instant', 'fr-FR')).toBe('not-an-instant');
  });
});
