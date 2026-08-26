import { formatDateTime } from '../../client/date-format.js';

/**
 * ONE relative-time vocabulary, for every timestamp the GPU client shows.
 *
 * A journal row, a run's start and a project's last activity are all "how long
 * ago", and three call sites formatting their own would drift on the day a
 * threshold moves. So the buckets live here, the catalog holds their words,
 * and every caller passes the same `t` it already has.
 *
 * Deliberately NOT `Intl.RelativeTimeFormat`: that formats a NUMBER in a unit
 * ("il y a 2 jours", "il y a 14 jours") and has no way to say "hier",
 * "avant-hier", or the vague "il y a quelques minutes" this product asks for.
 * The unit choice is the interesting half and it would still be ours; the
 * words are a dozen catalog entries. Intl still does the work it is good at —
 * `absoluteTimestamp` below is a locale-formatted exact date.
 *
 * Past instants only. A timestamp in the FUTURE (a clock skew between the
 * server that stamped it and the browser reading it) is reported as the
 * freshest bucket rather than as a negative age, so a few seconds of skew
 * reads as "just now" instead of "in 3 seconds".
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Past this age a relative phrase stops helping and the exact date is shown. */
export const RELATIVE_TIME_HORIZON_MS = 2 * WEEK;

export interface RelativeTimeParts {
  /** The catalog key to translate. */
  readonly key: string;
  /** Interpolation vars, `count` included so i18next can select a plural form. */
  readonly vars?: Record<string, number>;
  /** True once the age passed the horizon: `key` is unused, show the date. */
  readonly exact: boolean;
}

/**
 * Which bucket an age falls in, as a catalog key. Split from the formatting so
 * a test can pin the thresholds without going through a translation catalog.
 *
 * Days are counted in CALENDAR days, not in 24h multiples: at 01:00, something
 * stamped at 23:00 was "hier", and `Math.floor(age / DAY)` would call it
 * "quelques secondes"-adjacent nonsense — 0 days. Weeks stay elapsed-time,
 * where the ambiguity does not bite.
 */
export function relativeTimeParts(at: number, now: number): RelativeTimeParts {
  const age = Math.max(0, now - at);
  if (age >= RELATIVE_TIME_HORIZON_MS) return { key: 'time.exact', exact: true };
  if (age < 45 * SECOND) return { key: 'time.secondsAgo', exact: false };
  if (age < 90 * SECOND) return { key: 'time.oneMinuteAgo', exact: false };
  if (age < 45 * MINUTE) return { key: 'time.minutesAgo', exact: false };
  if (age < 90 * MINUTE) return { key: 'time.oneHourAgo', exact: false };
  if (age < 22 * HOUR) {
    return { key: 'time.hoursAgo', vars: { count: Math.round(age / HOUR) }, exact: false };
  }
  const days = calendarDaysBetween(at, now);
  if (days <= 1) return { key: 'time.yesterday', exact: false };
  if (days === 2) return { key: 'time.dayBeforeYesterday', exact: false };
  if (age < WEEK) return { key: 'time.daysAgo', vars: { count: days }, exact: false };
  return { key: 'time.weeksAgo', vars: { count: Math.floor(age / WEEK) }, exact: false };
}

/**
 * Whole days between two instants by LOCAL midnight, so "hier" means the
 * previous calendar day in the reader's own timezone.
 */
function calendarDaysBetween(at: number, now: number): number {
  const startOfDay = (ms: number): number => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(at)) / DAY));
}

/** The exact instant, in the reader's locale. What the hover bubble shows. */
export function absoluteTimestamp(at: number, locale: string): string {
  return formatDateTime(at, locale, { seconds: true, dateStyle: 'full' });
}

/**
 * The label for a timestamp: a relative phrase, or the exact date once the
 * age passes the horizon. `at` may be an ISO string or epoch ms; an
 * unparseable value comes back as the empty string rather than "Invalid Date",
 * because a row with a bad stamp must still render its other fields.
 */
export function relativeTime(
  at: string | number,
  t: (key: string, vars?: Record<string, unknown>) => string,
  locale: string,
  now: number = Date.now()
): string {
  const ms = timestampMs(at);
  if (ms === null) return '';
  const parts = relativeTimeParts(ms, now);
  if (parts.exact) return absoluteDate(ms, locale);
  return t(parts.key, parts.vars);
}

/** Past the horizon: a date, without the time of day the bubble already holds. */
function absoluteDate(at: number, locale: string): string {
  return new Date(at).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Epoch ms from an ISO string or a number, or null if it will not parse. */
export function timestampMs(at: string | number): number | null {
  const ms = typeof at === 'number' ? at : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The hover bubble's text, or null when the stamp will not parse. */
export function timestampTooltip(at: string | number, locale: string): string | null {
  const ms = timestampMs(at);
  return ms === null ? null : absoluteTimestamp(ms, locale);
}
