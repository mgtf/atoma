import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  asLocale,
  isLocale,
  nextLocale,
} from '../src/contracts/locales.js';
import {
  createTranslator,
  I18N_CATALOGS,
  translate,
} from '../src/viz/client/i18n-catalog.js';
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

  it('every notifying route renders for every locale, with explicit EN fallback', () => {
    for (const [kind, route] of Object.entries(PUSH_ROUTES)) {
      if (!route) continue;
      expect(route.copy.en, `${kind} English copy`).toBeDefined();
    }
  });

  it('every locale has an endonym for a language picker', () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('keeps the requested product ordering when cycling the compact GPU picker', () => {
    expect(SUPPORTED_LOCALES).toEqual([
      'en', 'zh', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'id', 'ur', 'ru', 'de', 'ja',
    ]);
    expect(SUPPORTED_LOCALES.map(nextLocale)).toEqual([
      'zh', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'id', 'ur', 'ru', 'de', 'ja', 'en',
    ]);
  });

  it('reads a locale totally, and narrows partially', () => {
    expect(asLocale('fr')).toBe('fr');
    // No next source to try: anything unknown resolves to the default.
    expect(asLocale('xx')).toBe(DEFAULT_LOCALE);
    expect(asLocale(null)).toBe(DEFAULT_LOCALE);
    expect(asLocale(7)).toBe(DEFAULT_LOCALE);
    // A narrowing read reports the miss instead of hiding it behind a default.
    expect(isLocale('xx')).toBe(false);
    expect(isLocale('de')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe('UI pluralisation', () => {
  it('selects natural singular and plural forms in the reviewed EN/FR catalogs', () => {
    expect(translate('en', 'projects.summary', { count: 1 }))
      .toBe('1 project in this organisation');
    expect(translate('en', 'projects.summary', { count: 4 }))
      .toBe('4 projects in this organisation');
    expect(translate('fr', 'admin.journalSummary', { count: 1 }))
      .toBe('1 événement chargé, du plus récent au plus ancien');
    expect(translate('fr', 'admin.journalSummary', { count: 4 }))
      .toBe('4 événements chargés, du plus récent au plus ancien');
    expect(translate('en', 'summary.lifecycle.recovery', { count: 2 }))
      .toBe('⟳ 2 mid-run recoveries');
    expect(translate('fr', 'summary.guards.withheld', { count: 2 }))
      .toBe('⊘ 2 crédits retenus');
  });

  it('contains no parenthetical pseudo-plurals', () => {
    for (const catalog of Object.values(I18N_CATALOGS)) {
      expect(Object.values(catalog).join('\n')).not.toMatch(/\((?:s|es|ies)\)/i);
    }
  });

  it('uses the catalog two-form contract even for richer CLDR locales', () => {
    const probe = createTranslator({
      ...I18N_CATALOGS,
      ar: {
        sample_one: 'واحد {{count}}',
        sample_other: 'متعدد {{count}}',
      },
      ru: {
        sample_one: 'один {{count}}',
        sample_other: 'много {{count}}',
      },
      en: {
        ...I18N_CATALOGS.en,
        sample_one: 'one {{count}}',
        sample_other: 'many {{count}}',
      },
    });
    expect(probe('ar', 'sample', { count: 3 })).toBe('متعدد 3');
    expect(probe('ru', 'sample', { count: 2 })).toBe('много 2');
  });
});

/**
 * THE LOCALE PIPELINE CONTRACT. The catalogs are JSON files
 * (`src/viz/client/locales/*.json`) maintained by scripts/i18n.mjs:
 * en.json is the source of truth, an EMPTY target value means "awaiting
 * translation" (blanked by the pre-commit hook when its EN source changed,
 * filled by the CI i18n workflow), and a NON-empty translation must carry
 * exactly the interpolations of its EN source or i18next renders literal
 * `{{count}}` to the user. These are the invariants that pipeline depends on,
 * so they are enforced where every other catalog rule is.
 */
describe('the locale pipeline invariants', () => {
  it('every non-blank translation keeps its EN placeholder signature', () => {
    const failures: string[] = [];
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      for (const [key, enValue] of Object.entries(I18N_CATALOGS.en)) {
        const value = I18N_CATALOGS[locale][key];
        if (value === undefined || value === '') continue; // awaiting translation
        const signature = (copy: string) =>
          (copy.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort().join('|');
        if (signature(enValue) !== signature(value)) {
          failures.push(`${locale}.${key}: "${signature(enValue)}" vs "${signature(value)}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('an empty target value falls back to EN through i18next, never to the key', () => {
    // Instantiate the same production translator with a genuinely blank
    // resource. Mutating I18N_CATALOGS after the singleton initializes would
    // only prove that i18next cloned its resources.
    const probe = 'lang.name';
    const translateBlank = createTranslator({
      ...I18N_CATALOGS,
      fr: { ...I18N_CATALOGS.fr, [probe]: '' },
    });
    expect(translateBlank('fr', probe)).toBe(I18N_CATALOGS.en[probe]);
  });
});
