// The catalogs and the i18next-backed lookup. Kept out of `i18n.tsx` so that file
// exports components only: vite's Fast Refresh gives up on a module that
// mixes a component with anything else, and would reload the whole app.
import { createInstance } from 'i18next';
import {
  DEFAULT_LOCALE,
  isLocale,
  twoFormPluralKey,
  type Locale,
} from '../../contracts/locales.js';
import ar from './locales/ar.json' with { type: 'json' };
import bn from './locales/bn.json' with { type: 'json' };
import de from './locales/de.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import hi from './locales/hi.json' with { type: 'json' };
import id from './locales/id.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import pt from './locales/pt.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import ur from './locales/ur.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };

export type { Locale };

// The catalogs live as JSON beside this module. `en.json` is the source of
// truth: a key is added there first, and every target catalog carries either a
// translation or a missing/EMPTY value meaning "awaiting translation". The pipeline
// that keeps them following `en.json` is `npm run i18n` (scripts/i18n.mjs):
// the pre-commit hook blanks target values whose English source changed, and
// CI on main translates what is blank and commits it back.
export const I18N_CATALOGS: Record<Locale, Record<string, string>> = {
  en, zh, hi, es, ar, fr, bn, pt, id, ur, ru, de, ja,
};

export const STORAGE_KEY = 'atoma.viz.lang';

export function detectLocale(): Locale {
  // `isLocale`, not `asLocale`: a miss here must fall through to the NEXT
  // source, and a total read would stop at the query string every time.
  const query = new URLSearchParams(location.search).get('lang');
  if (isLocale(query)) return query;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch { /* storage is optional */ }
  return DEFAULT_LOCALE;
}

export function createTranslator(catalogs: Record<Locale, Record<string, string>>) {
  const i18n = createInstance();
  void i18n.init({
    fallbackLng: DEFAULT_LOCALE,
    initAsync: false,
    interpolation: { escapeValue: false },
    keySeparator: false,
    nsSeparator: false,
    resources: Object.fromEntries(
      Object.entries(catalogs).map(([locale, translation]) => [
        locale,
        { translation },
      ])
    ),
    // A blank target value is the pipeline's explicit "awaiting translation"
    // marker. i18next accepts empty strings by default, which would render no
    // copy at all instead of consulting fallbackLng.
    returnEmptyString: false,
    returnNull: false,
    showSupportNotice: false,
  });

  return (locale: Locale, key: string, vars?: Record<string, unknown>): string => {
    const pluralKey = twoFormPluralKey(key, vars?.['count']);
    const resolvedKey = pluralKey in catalogs.en ? pluralKey : key;
    return i18n.t(resolvedKey, {
      ...vars,
      defaultValue: key,
      lng: locale,
    });
  };
}

export const translate = createTranslator(I18N_CATALOGS);
