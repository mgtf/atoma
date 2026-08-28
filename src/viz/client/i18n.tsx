import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { type Locale } from '../../contracts/locales.js';
import { STORAGE_KEY, applyDocumentLocale, detectLocale, translate } from './i18n-catalog.js';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(detectLocale);
  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale: (next) => {
      updateLocale(next);
      // Eagerly as well as through the effect: the document must not lag one
      // paint behind the switch the user just made.
      applyDocumentLocale(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* optional */ }
    },
    t: (key, vars) => translate(locale, key, vars),
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
