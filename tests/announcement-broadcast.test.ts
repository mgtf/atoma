import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_SEGMENTS,
  ANNOUNCEMENT_TITLE_MAX,
  announcementDetailFits,
  announcementRequestSchema,
  type AnnouncementDetail,
} from '../src/contracts/announcements.js';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../src/contracts/locales.js';
import { PLATFORM_EVENT_DETAIL_MAX_CHARS } from '../src/contracts/platformEvents.js';
import { organisationsForSegment } from '../src/viz/push/segments.js';
import { draftAnnouncementTranslations } from '../src/viz/push/translate.js';
import { PUSH_ROUTES, renderPush } from '../src/viz/push/routes.js';
import { resolveAudience } from '../src/viz/push/router.js';
import type { PlatformEvent } from '../src/contracts/platformEvents.js';

const TEXTS = {
  en: { title: 'Scheduled maintenance', body: 'Tonight at 00:00, about 30 minutes.' },
  fr: { title: 'Maintenance prévue', body: 'Ce soir à 00h, environ 30 minutes.' },
};

function announcement(detail: Partial<AnnouncementDetail>): PlatformEvent {
  return {
    seq: 7,
    at: '2026-08-23T12:00:00.000Z',
    kind: 'platform.announcement',
    severity: 'security',
    actorType: 'principal',
    actorId: 'admin-1',
    orgId: null,
    projectId: null,
    runId: null,
    summary: 'Announcement',
    detail: { segment: 'all', orgCount: null, texts: TEXTS, ...detail },
  };
}

const directory = {
  ownersOf: () => ['owner-1'],
  platformAdmins: () => ['admin-1'],
  allPrincipals: () => ['admin-1', 'member-1', 'member-2', 'loner-1'],
  membersOf: (orgIds: readonly string[]) =>
    orgIds.flatMap((orgId) => (orgId === 'org-a' ? ['admin-1', 'member-1'] : ['member-2'])),
};

describe('an operator announcement reaches exactly its segment', () => {
  const route = PUSH_ROUTES['platform.announcement']!;

  it('the widest segment names no organisation, and reaches every principal', () => {
    expect(organisationsForSegment('all', [{ orgId: 'org-a', status: 'published' }])).toBeNull();
    expect(resolveAudience(announcement({}), route.audience, directory).sort()).toEqual([
      'admin-1',
      'loner-1',
      'member-1',
      'member-2',
    ]);
  });

  it('a narrower segment reaches only those organisations, never everyone', () => {
    const projects = [
      { orgId: 'org-a', status: 'published' },
      { orgId: 'org-b', status: 'pending' },
      { orgId: 'org-b', status: 'failed' },
    ];
    expect(organisationsForSegment('with-project', projects)).toEqual(['org-a', 'org-b']);
    expect(organisationsForSegment('with-published-project', projects)).toEqual(['org-a']);
    // `loner-1` belongs to no organisation and must NOT be swept in.
    expect(
      resolveAudience(
        announcement({ segment: 'with-published-project', orgIds: ['org-a'], orgCount: 1 }),
        route.audience,
        directory
      ).sort()
    ).toEqual(['admin-1', 'member-1']);
  });

  it('the sender receives their own announcement — an unseen broadcast is unverifiable', () => {
    const recipients = resolveAudience(
      announcement({ segment: 'with-project', orgIds: ['org-b'], orgCount: 1 }),
      route.audience,
      directory
    );
    expect(recipients).toContain('admin-1');
  });

  it('renders the approved text in the subscriber language, falling back to the default', () => {
    expect(renderPush(announcement({}), 'fr', route)).toEqual({
      title: TEXTS.fr.title,
      body: TEXTS.fr.body,
    });
    expect(renderPush(announcement({}), 'en', route)).toEqual({
      title: TEXTS.en.title,
      body: TEXTS.en.body,
    });
    // A row from a build that knew more languages still renders.
    const partial = announcement({ texts: { en: TEXTS.en } as typeof TEXTS });
    expect(renderPush(partial, 'fr', route).title).toBe(TEXTS.en.title);
  });
});

describe('the send is refused before it can be half-done', () => {
  it('requires every supported language', () => {
    const missing = announcementRequestSchema.safeParse({
      segment: 'all',
      texts: { [DEFAULT_LOCALE]: TEXTS.en },
    });
    // A single-language instance would accept it; with more than one, a
    // partial set is exactly the silent-fallback failure being prevented.
    expect(missing.success).toBe(false);
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(1);
    expect(announcementRequestSchema.safeParse({ segment: 'all', texts: TEXTS }).success).toBe(true);
  });

  it('rejects an unknown segment and an over-long body', () => {
    expect(announcementRequestSchema.safeParse({ segment: 'everybody', texts: TEXTS }).success)
      .toBe(false);
    expect(
      announcementRequestSchema.safeParse({
        segment: 'all',
        texts: { ...TEXTS, en: { title: 'ok', body: 'x'.repeat(ANNOUNCEMENT_BODY_MAX + 1) } },
      }).success
    ).toBe(false);
    expect(ANNOUNCEMENT_SEGMENTS).toContain('all');
  });

  /**
   * The journal is FAIL-OPEN, and the router only ever sees journaled events.
   * An oversized detail would therefore drop the audit row and the push with
   * it — silently. The size check exists to turn that into a refusal.
   */
  it('refuses an announcement that would not fit one audit row', () => {
    const fits: AnnouncementDetail = { segment: 'all', orgCount: null, texts: TEXTS };
    expect(announcementDetailFits(fits, PLATFORM_EVENT_DETAIL_MAX_CHARS)).toBe(true);
    const huge: AnnouncementDetail = {
      segment: 'with-project',
      orgIds: Array.from({ length: 200 }, (_, index) => `org-${index}`),
      orgCount: 200,
      texts: TEXTS,
    };
    expect(announcementDetailFits(huge, PLATFORM_EVENT_DETAIL_MAX_CHARS)).toBe(false);
  });
});

describe('translation drafts, and their absence', () => {
  const draft = { source: 'fr' as const, title: 'Maintenance prévue', body: 'Ce soir à 00h.' };

  it('is unavailable rather than fatal when no provider is configured', async () => {
    expect(await draftAnnouncementTranslations(draft, { llm: null })).toBeNull();
  });

  it('passes the operator language through untouched and fills the others', async () => {
    const llm = {
      complete: async () => ({
        text: 'Here you go:\n{"en": {"title": "Scheduled maintenance", "body": "Tonight at 00:00."}}',
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const result = await draftAnnouncementTranslations(draft, { llm });
    // The source language is never round-tripped through the model.
    expect(result?.fr).toEqual({ title: draft.title, body: draft.body });
    expect(result?.en.title).toBe('Scheduled maintenance');
  });

  it('returns nothing rather than a half-translated draft', async () => {
    const llm = {
      complete: async () => ({
        text: '{"en": {"title": "", "body": "Tonight."}}',
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    expect(await draftAnnouncementTranslations(draft, { llm })).toBeNull();
  });

  it('clamps a draft that ignores the length it was given', async () => {
    const llm = {
      complete: async () => ({
        text: JSON.stringify({ en: { title: 'T'.repeat(400), body: 'B'.repeat(900) } }),
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const result = await draftAnnouncementTranslations(draft, { llm });
    expect(result?.en.title.length).toBe(ANNOUNCEMENT_TITLE_MAX);
    expect(result?.en.body.length).toBe(ANNOUNCEMENT_BODY_MAX);
  });
});

describe('a malformed announcement is tolerated, never delivered blank', () => {
  it('does not push a row whose text this build cannot read', async () => {
    const { NotificationRouter } = await import('../src/viz/push/router.js');
    const sent: string[][] = [];
    const router = new NotificationRouter({
      notifier: {
        notifyPrincipals: async (recipients: readonly string[]) => {
          sent.push([...recipients]);
        },
      } as never,
      directory,
    });
    // A row from a build that wrote its text under a shape this one does not
    // know: readable as an event, unreadable as copy.
    await router.handle(announcement({ texts: undefined }));
    expect(sent).toEqual([]);
    // The well-formed one still goes out, to prove the guard is not a wall.
    await router.handle(announcement({}));
    expect(sent).toHaveLength(1);
  });
});

/**
 * The composer is DOM over a GL view, so its height is a contract in TWO
 * files. The settings form already taught this lesson: a `position: fixed`
 * overlay whose reserved space the renderer does not know about lets content
 * scroll underneath it, which reads as a rendering fault rather than a layout
 * one.
 */
describe('the composer and the organisation list agree on the space', () => {
  it('the list gives up exactly the height the stylesheet claims', async () => {
    const { ADMIN_DOM_FORM_HEIGHT, ADMIN_DOM_FORM_BOTTOM, adminPaneHeight } = await import(
      '../src/viz/client-gl/renderer/views/admin.js'
    );
    const css = readFileSync('src/viz/client-gl/styles.css', 'utf8');
    const form = css.slice(css.indexOf('.gpu-announce-form {'));
    expect(form).toContain(`height: ${ADMIN_DOM_FORM_HEIGHT}px`);
    expect(form).toContain(`bottom: ${ADMIN_DOM_FORM_BOTTOM}px`);
    // The pane must end above the composer, and never take a negative height
    // on a viewport too short to hold both.
    const contentTop = 120;
    expect(adminPaneHeight(900, contentTop)).toBeLessThan(900 - contentTop - ADMIN_DOM_FORM_HEIGHT);
    expect(adminPaneHeight(200, contentTop)).toBe(0);
  });
});
