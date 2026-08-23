/**
 * THE LANGUAGES THIS PLATFORM SPEAKS — one list, read by everything.
 * ==================================================================
 *
 * There were two: the client catalog's `Locale` union and the push router's
 * `PushLocale`. Nothing kept them equal. Adding a third language meant
 * finding both, and a miss would have shipped a UI that speaks a language the
 * notifications do not — the same one-concept-two-definitions shape the root
 * contract warns about, with the divergence merely waiting for a third entry.
 *
 * Deliberately dependency-free: this module is imported by the browser bundle
 * AND by the server, so it must cost the client nothing and must never reach
 * for a React or a Node API. Adding a locale is one entry here, plus its
 * catalog — the loops that fan out over languages read this list.
 */

export const SUPPORTED_LOCALES = ['en', 'fr'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The language everything falls back to, and the one source copy is authored in. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Endonyms: a language picker names each language in that language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
};

/** A narrowing test, for callers that must try the NEXT source on a miss. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** A total read, for callers that have no next source: unknown means default. */
export function asLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
