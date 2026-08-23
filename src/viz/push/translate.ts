import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  type AnnouncementDraft,
  type AnnouncementText,
} from '../../contracts/announcements.js';
import { LOCALE_NAMES, SUPPORTED_LOCALES, type Locale } from '../../contracts/locales.js';
import { modelForTier } from '../../core/models.js';
import type { LlmClient } from '../../core/types.js';

/**
 * DRAFT TRANSLATIONS FOR AN OPERATOR ANNOUNCEMENT.
 * ================================================
 *
 * The only LLM call site in the viz server, and it is deliberately shaped so
 * that being one changes nothing else:
 *
 * - It produces a DRAFT. The admin reads every language and confirms before
 *   anything is sent, which is what keeps model prose out of the audit row
 *   (`src/platform/AGENTS.md`) and out of subscribers' pockets. Nothing here
 *   decides; it proposes.
 * - It rides the TIER 1 model. A bounded translation between two known
 *   languages is the cheapest kind of work there is — the same reasoning that
 *   puts validators and the prefilter on that tier.
 * - The client is built ON DEMAND, so a viz server that never sends an
 *   announcement never constructs a provider and never demands a credential.
 * - It NEVER round-trips the source language: the operator's own words are
 *   passed through untouched. A translator that rewrote the input would be
 *   editing text a human already approved.
 *
 * Unavailability is a normal outcome, not an error to block on: no provider, a
 * refused credential, unparseable output — all resolve to `null`, and the
 * caller tells the admin to write the other languages by hand. A broadcast
 * must never be blocked by a translation service. It is not swallowed
 * though: every `null` says WHY on stderr first. Five causes reaching the
 * operator as one sentence left nothing anywhere to tell them apart.
 */

/** One line per giving-up, so the cause is somewhere rather than nowhere. */
function giveUp(reason: string): null {
  process.stderr.write(`[atoma announce] no translation draft: ${reason}\n`);
  return null;
}

export type AnnouncementTranslations = Record<Locale, AnnouncementText>;

/** Trim to the contract bound: a draft is edited before it is sent. */
function clamp(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const SYSTEM_PROMPT = [
  'You translate short product notifications for a software platform.',
  'Return ONLY a JSON object, no prose and no code fence.',
  'Preserve meaning, tone and any time, date or number exactly as given.',
  'Do not add, remove or explain anything. Do not translate product names.',
].join(' ');

function userContent(draft: AnnouncementDraft, targets: readonly Locale[]): string {
  const wanted = targets.map((locale) => `"${locale}" (${LOCALE_NAMES[locale]})`).join(', ');
  return [
    `Source language: ${LOCALE_NAMES[draft.source]} ("${draft.source}").`,
    `Title: ${draft.title}`,
    `Body: ${draft.body}`,
    '',
    `Translate into ${wanted}.`,
    `Keep every title at or under ${ANNOUNCEMENT_TITLE_MAX} characters and every body at or under ${ANNOUNCEMENT_BODY_MAX}.`,
    'Answer with exactly this shape:',
    '{"<locale>": {"title": "...", "body": "..."}}',
  ].join('\n');
}

/** Pull the JSON object out of a reply that may still carry a fence or prose. */
function parseObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface TranslateOptions {
  /** Injected in tests and by the route; absent means "no provider here". */
  readonly llm: LlmClient | null;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Returns every supported language, or `null` when no usable draft could be
 * produced. A PARTIAL result is never returned: the admin form fills all
 * languages at once, and half a translation is harder to notice than none.
 */
export async function draftAnnouncementTranslations(
  draft: AnnouncementDraft,
  options: TranslateOptions
): Promise<AnnouncementTranslations | null> {
  const source: AnnouncementText = { title: draft.title, body: draft.body };
  const targets = SUPPORTED_LOCALES.filter((locale) => locale !== draft.source);
  // A single-language instance needs no provider at all.
  if (targets.length === 0) return { [draft.source]: source } as AnnouncementTranslations;
  if (!options.llm) return giveUp('no provider is configured on this server');

  let reply: string;
  try {
    const response = await options.llm.complete({
      model: modelForTier(1, options.env ?? process.env),
      systemPrompt: SYSTEM_PROMPT,
      userContent: userContent(draft, targets),
      // No `role`: the trace vocabulary describes the supervision loop, and
      // this call is not part of one. An absent role reads as `unknown`,
      // which is the honest answer — inventing a role to fill the field
      // would put a control-plane call into the loop's accounting.
      params: { maxTokens: 600, temperature: 0 },
    });
    reply = response.text ?? '';
  } catch (error) {
    return giveUp(error instanceof Error ? error.message : String(error));
  }

  const parsed = parseObject(reply);
  if (!parsed) return giveUp('the reply carried no JSON object');

  const translations: Partial<Record<Locale, AnnouncementText>> = { [draft.source]: source };
  for (const locale of targets) {
    const entry = parsed[locale];
    if (typeof entry !== 'object' || entry === null) return giveUp(`the reply has no "${locale}"`);
    const record = entry as Record<string, unknown>;
    const title = clamp(record['title'], ANNOUNCEMENT_TITLE_MAX);
    const body = clamp(record['body'], ANNOUNCEMENT_BODY_MAX);
    // An empty field is a failed translation, not a draft worth showing.
    if (!title || !body) return giveUp(`the "${locale}" entry is missing a title or a body`);
    translations[locale] = { title, body };
  }
  return translations as AnnouncementTranslations;
}
