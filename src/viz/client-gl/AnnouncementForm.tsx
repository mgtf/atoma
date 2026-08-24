import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_SEGMENTS,
  ANNOUNCEMENT_TITLE_MAX,
  type AnnouncementSegment,
} from '../../contracts/announcements.js';
import { LOCALE_NAMES, SUPPORTED_LOCALES, type Locale } from '../../contracts/locales.js';
import { api } from '../client/data-api.js';
import type { VizAnnouncementTexts } from '../client/types.js';

/**
 * THE ONLY PUSH A HUMAN WRITES, and the form is shaped by that.
 *
 * TWO STEPS, not one. Translating sends nothing; sending carries only text the
 * admin has read in every language. That is what keeps model prose out of the
 * audit row and out of subscribers' pockets — and the confirm step exists
 * because a notification cannot be recalled, so the last click must be about
 * nothing except "yes, send it".
 *
 * The form owns its own state rather than the shared store: nothing else in
 * the app reads a half-written announcement, and a global slice for it would
 * be one more thing to reset on navigation.
 */

type Phase = 'compose' | 'drafting' | 'review' | 'confirm' | 'sending' | 'sent';

const EMPTY = { title: '', body: '' };

export function AnnouncementForm({
  t,
  locale,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: Locale;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('compose');
  const [segment, setSegment] = useState<AnnouncementSegment>('all');
  const [texts, setTexts] = useState<VizAnnouncementTexts>({ [locale]: { ...EMPTY } });
  // `null` while a draft is expected; otherwise WHY there is none, because
  // "no service is configured" and "the service refused" are two different
  // things to do about it.
  const [untranslated, setUntranslated] = useState<'unavailable' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<number | null>(null);

  const source = texts[locale] ?? EMPTY;
  const composed = source.title.trim().length > 0 && source.body.trim().length > 0;
  const complete = SUPPORTED_LOCALES.every(
    (entry) => (texts[entry]?.title.trim().length ?? 0) > 0 && (texts[entry]?.body.trim().length ?? 0) > 0
  );

  function edit(entry: string, field: 'title' | 'body', value: string): void {
    setTexts((current) => ({
      ...current,
      [entry]: { ...(current[entry] ?? EMPTY), [field]: value },
    }));
  }

  async function draft(): Promise<void> {
    setPhase('drafting');
    setError(null);
    try {
      const result = await api.draftAnnouncement({ source: locale, ...source });
      // An unavailable translator is not a failure: the admin fills the other
      // languages in the same fields, and the send is unchanged.
      setUntranslated(result.translated ? null : (result.reason ?? 'failed'));
      if (result.texts) setTexts(result.texts);
      setPhase('review');
    } catch {
      // The request itself never arrived, which is neither of the two answers
      // the server gives — read it as the service being out of reach.
      setUntranslated('failed');
      setPhase('review');
    }
  }

  async function send(): Promise<void> {
    setPhase('sending');
    setError(null);
    try {
      const result = await api.sendAnnouncement({ segment, texts });
      setSentTo(result.orgCount);
      setPhase('sent');
      // The announcement is a journaled event: the platform journal should
      // show it without a manual refresh.
      void queryClient.invalidateQueries({ queryKey: ['viz', 'admin', 'events'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('announce.error'));
      setPhase('review');
    }
  }

  if (phase === 'sent') {
    return (
      <div className="gpu-panel-skin gpu-announce-form">
        <p role="status">
          {sentTo === null ? t('announce.sentAll') : t('announce.sent', { count: sentTo })}
        </p>
      </div>
    );
  }

  return (
    <form
      className="gpu-panel-skin gpu-announce-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (phase === 'compose') void draft();
        else if (phase === 'review') setPhase('confirm');
        else if (phase === 'confirm') void send();
      }}
    >
      <p className="gpu-announce-hint">{t('announce.hint')}</p>
      <input
        className="gpu-dom-input"
        aria-label={`${t('announce.fieldTitle')} — ${LOCALE_NAMES[locale]}`}
        placeholder={t('announce.fieldTitle')}
        maxLength={ANNOUNCEMENT_TITLE_MAX}
        value={source.title}
        onChange={(event) => edit(locale, 'title', event.target.value)}
      />
      <textarea
        className="gpu-dom-input"
        aria-label={`${t('announce.fieldBody')} — ${LOCALE_NAMES[locale]}`}
        placeholder={t('announce.fieldBody')}
        maxLength={ANNOUNCEMENT_BODY_MAX}
        value={source.body}
        onChange={(event) => edit(locale, 'body', event.target.value)}
      />
      {phase !== 'compose' ? (
        <div className="gpu-announce-languages">
          <p>{untranslated ? t(`announce.${untranslated}`) : t('announce.review')}</p>
          {SUPPORTED_LOCALES.filter((entry) => entry !== locale).map((entry) => (
            <div key={entry} className="gpu-announce-language">
              <span>{LOCALE_NAMES[entry]}</span>
              <input
                className="gpu-dom-input"
                aria-label={`${t('announce.fieldTitle')} — ${LOCALE_NAMES[entry]}`}
                maxLength={ANNOUNCEMENT_TITLE_MAX}
                value={texts[entry]?.title ?? ''}
                onChange={(event) => edit(entry, 'title', event.target.value)}
              />
              <textarea
                className="gpu-dom-input"
                aria-label={`${t('announce.fieldBody')} — ${LOCALE_NAMES[entry]}`}
                maxLength={ANNOUNCEMENT_BODY_MAX}
                value={texts[entry]?.body ?? ''}
                onChange={(event) => edit(entry, 'body', event.target.value)}
              />
            </div>
          ))}
        </div>
      ) : null}
      <label className="gpu-announce-segment">
        <span>{t('announce.segment')}</span>
        <select
          className="gpu-dom-input gpu-dom-select"
          value={segment}
          onChange={(event) => setSegment(event.target.value as AnnouncementSegment)}
        >
          {ANNOUNCEMENT_SEGMENTS.map((entry) => (
            <option key={entry} value={entry}>
              {t(`announce.segment.${entry}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="gpu-announce-actions">
        {phase === 'compose' || phase === 'drafting' ? (
          <button type="submit" disabled={!composed || phase === 'drafting'}>
            {t(phase === 'drafting' ? 'announce.drafting' : 'announce.draft')}
          </button>
        ) : (
          <button type="submit" disabled={!complete || phase === 'sending'}>
            {t(
              phase === 'sending'
                ? 'announce.sending'
                : phase === 'confirm'
                  ? 'announce.confirm'
                  : 'announce.send'
            )}
          </button>
        )}
        {error ? <span role="alert">{error}</span> : null}
      </div>
    </form>
  );
}
