import { z } from 'zod';
import { SUPPORTED_LOCALES, type Locale } from './locales.js';

/**
 * The zod face of the one locale list. Derived from it, never retyped:
 * `src/contracts/locales.ts` stays dependency-free for the browser bundle,
 * so the schema is built HERE from that same tuple rather than beside it.
 */
const localeKeySchema = z.enum(SUPPORTED_LOCALES);

/**
 * AN OPERATOR ANNOUNCEMENT — the one push whose words a human writes.
 * ===================================================================
 *
 * Every other notification renders from copy frozen in `PUSH_ROUTES`. This
 * one carries its own text, in every supported language, approved by the
 * admin who sends it. That is what keeps it inside the platform contract:
 * `detail` may not hold model-authored prose, and a translation the operator
 * read and accepted is the operator's text.
 *
 * The bounds are not cosmetic. A notification body is truncated by the
 * operating system long before it is truncated by us, and the whole payload
 * must still fit `PLATFORM_EVENT_DETAIL_MAX_CHARS` once multiplied by the
 * number of languages — see `announcementDetailFits`, which is the check that
 * fails a send LOUDLY rather than letting a fail-open journal drop the row and
 * take the push down with it.
 */

export const ANNOUNCEMENT_TITLE_MAX = 60;
export const ANNOUNCEMENT_BODY_MAX = 180;

/**
 * WHO HEARS IT. Ordered from widest to narrowest, which is the order the
 * dropdown shows and the order a reader of the journal expects.
 */
export const announcementSegmentSchema = z.enum([
  'all',
  'with-project',
  'with-published-project',
]);
export type AnnouncementSegment = z.infer<typeof announcementSegmentSchema>;
export const ANNOUNCEMENT_SEGMENTS = announcementSegmentSchema.options;

export const announcementTextSchema = z
  .object({
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
  })
  .strict();
export type AnnouncementText = z.infer<typeof announcementTextSchema>;

/**
 * Every supported language or none: a partial set would silently deliver the
 * default language to subscribers who asked for another one, which is the
 * failure this feature exists to avoid.
 */
export const announcementTextsSchema = z
  .record(localeKeySchema, announcementTextSchema)
  .refine((texts) => SUPPORTED_LOCALES.every((locale) => texts[locale] !== undefined), {
    message: 'every supported language needs a title and a body',
  })
  .transform((texts) => texts as Record<Locale, AnnouncementText>);

export const announcementRequestSchema = z
  .object({
    segment: announcementSegmentSchema,
    texts: announcementTextsSchema,
  })
  .strict();
export type AnnouncementRequest = z.infer<typeof announcementRequestSchema>;

/** What the admin typed, before any language but their own exists. */
export const announcementDraftSchema = z
  .object({
    source: localeKeySchema,
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
  })
  .strict();
export type AnnouncementDraft = z.infer<typeof announcementDraftSchema>;

/**
 * The journaled shape.
 *
 * `orgCount` rather than the resolved id list: `detail` is capped at 2,000
 * serialised characters, and a segment matching a few dozen organisations
 * would blow that budget — the journal being fail-open, the row would be
 * lost AND the push with it, since the router only ever sees journaled
 * events. The segment records the RULE, `orgCount` its breadth at that
 * instant, and `orgIds` carries the actual scope for the router to resolve.
 *
 * No recipient count: how many devices a push reached is a DELIVERY fact,
 * and an emitter that computed it would be holding a second copy of the
 * router's audience rules — the one duplication this table exists to avoid.
 */
export interface AnnouncementDetail {
  readonly segment: AnnouncementSegment;
  /** Absent for the widest segment: "everyone" names no organisations. */
  readonly orgIds?: readonly string[];
  readonly orgCount: number | null;
  readonly texts: Record<Locale, AnnouncementText>;
}

/** Does this announcement still fit the audit row? Checked BEFORE emitting. */
export function announcementDetailFits(detail: AnnouncementDetail, maxChars: number): boolean {
  return JSON.stringify(detail).length <= maxChars;
}
