import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  asLocale,
  isLocale,
} from '../src/contracts/locales.js';
import { I18N_CATALOGS } from '../src/viz/client/i18n.js';
import { PUSH_LOCALES, PUSH_ROUTES } from '../src/viz/push/routes.js';

/**
 * ONE LIST OF LANGUAGES, and everything that fans out over languages is held
 * to it. The UI catalog and the push copy used to declare their own unions,
 * so a third language could have shipped in the interface while the
 * notifications silently stayed bilingual. These assertions are what makes
 * adding a locale a one-line change that FAILS until the copy exists —
 * loudly, here, rather than quietly, in someone's notification tray.
 */
describe('the supported-locale list is the single source', () => {
  it('the UI catalogs cover exactly the supported locales', () => {
    expect(Object.keys(I18N_CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('push speaks the same languages as the interface', () => {
    expect([...PUSH_LOCALES]).toEqual([...SUPPORTED_LOCALES]);
  });

  it('every notifying route carries copy for every locale', () => {
    for (const [kind, route] of Object.entries(PUSH_ROUTES)) {
      if (!route) continue;
      expect(Object.keys(route.copy).sort(), `${kind} copy`).toEqual(
        [...SUPPORTED_LOCALES].sort()
      );
    }
  });

  it('every locale has an endonym for a language picker', () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('reads a locale totally, and narrows partially', () => {
    expect(asLocale('fr')).toBe('fr');
    // No next source to try: anything unknown resolves to the default.
    expect(asLocale('de')).toBe(DEFAULT_LOCALE);
    expect(asLocale(null)).toBe(DEFAULT_LOCALE);
    expect(asLocale(7)).toBe(DEFAULT_LOCALE);
    // A narrowing read reports the miss instead of hiding it behind a default.
    expect(isLocale('de')).toBe(false);
    expect(isLocale('en')).toBe(true);
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});
