import { describe, expect, it, vi } from 'vitest';
import {
  platformEventKindSchema,
  severityForKind,
  type PlatformEvent,
  type PlatformEventKind,
} from '../src/contracts/platformEvents.js';
import type { PushNotifier, PushRenderer } from '../src/viz/push/notifier.js';
import {
  NotificationRouter,
  cachedAudienceDirectory,
  resolveAudience,
  type AudienceDirectory,
} from '../src/viz/push/router.js';
import {
  PUSH_LOCALES,
  PUSH_ROUTES,
  fillTemplate,
  renderPush,
  asPushLocale,
} from '../src/viz/push/routes.js';

function event(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  const kind: PlatformEventKind = overrides.kind ?? 'run.finished';
  return {
    seq: 7,
    at: '2026-08-21T10:00:00.000Z',
    severity: severityForKind(kind),
    kind,
    actorType: 'principal',
    actorId: 'requester',
    orgId: 'org-1',
    projectId: 'proj-1',
    runId: 'run-1',
    summary: 'summary',
    ...overrides,
  };
}

const directory: AudienceDirectory = {
  ownersOf: (orgId) => (orgId === 'org-1' ? ['owner-a', 'owner-b'] : []),
  platformAdmins: () => ['admin-1'],
  // Reached only by an announcement; every other kind must leave these
  // untouched, which is itself worth being able to observe.
  allPrincipals: () => ['owner-a', 'owner-b', 'admin-1', 'member-a'],
  membersOf: (orgIds) => orgIds.flatMap((orgId) => (orgId === 'org-1' ? ['owner-a'] : [])),
};

function routerWith() {
  const calls: Array<{ recipients: readonly string[]; render: PushRenderer; tag: string }> = [];
  const notifier = {
    notifyPrincipals: vi.fn(
      async (
        recipients: readonly string[],
        render: PushRenderer,
        meta: { tag: string; url?: string }
      ) => {
        calls.push({ recipients, render, tag: meta.tag });
      }
    ),
  } as unknown as PushNotifier;
  return { router: new NotificationRouter({ notifier, directory }), calls, notifier };
}

describe('PUSH_ROUTES', () => {
  it('states a routing decision for every kind in the vocabulary', () => {
    // The Record is exhaustive by type, but a kind added to the enum with no
    // entry would only surface as `undefined` at runtime under a cast.
    for (const kind of platformEventKindSchema.options) {
      expect(kind in PUSH_ROUTES, kind).toBe(true);
    }
    expect(Object.keys(PUSH_ROUTES).sort()).toEqual([...platformEventKindSchema.options].sort());
  });

  it('gives every notifying kind complete copy in every locale', () => {
    for (const kind of platformEventKindSchema.options) {
      const route = PUSH_ROUTES[kind];
      if (!route) continue;
      const audience = route.audience;
      // An audience with nobody in it is a route that can never fire.
      expect(
        Boolean(audience.requester || audience.orgOwners || audience.platformAdmins),
        kind
      ).toBe(true);
      for (const locale of PUSH_LOCALES) {
        const copy = route.copy[locale];
        expect(copy?.title.trim(), `${kind}/${locale} title`).toBeTruthy();
        expect(copy?.body, `${kind}/${locale} body`).toBeDefined();
      }
    }
  });

  it('never leaves a placeholder unfilled in a rendered push', () => {
    // Every `{{var}}` a template names must be produced by that route's vars.
    for (const kind of platformEventKindSchema.options) {
      const route = PUSH_ROUTES[kind];
      if (!route) continue;
      for (const locale of PUSH_LOCALES) {
        const rendered = renderPush(
          event({
            kind,
            detail: {
              status: 'delivered',
              goal: 'Build a clock',
              repository: 'owner/clock',
              project: 'clock',
              orgName: 'Acme',
              member: 'Ada',
              role: 'org:member',
              displayName: 'Ada',
              runs: 2,
              publications: 1,
              // The one kind whose copy is not frozen: without its own
              // text there is nothing for the template to fill, which is
              // a malformed row rather than a missing template.
              texts: {
                en: { title: 'Maintenance', body: 'Tonight at 00:00.' },
                fr: { title: 'Maintenance', body: 'Ce soir à 00h.' },
              },
            },
          }),
          locale,
          route
        );
        expect(rendered.title, `${kind}/${locale}`).not.toMatch(/\{\{/);
        expect(rendered.body, `${kind}/${locale}`).not.toMatch(/\{\{/);
        expect(rendered.title.length, `${kind}/${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it('audit-only kinds carry no route (decision 1)', () => {
    for (const kind of [
      'run.started',
      'run.cancelled',
      'project.created',
      'invitation.created',
      'auth.rate_limited',
      'webhook.rejected',
      'push.subscribed',
      'push.unsubscribed',
      'token.created',
      'token.revoked',
      'github.installation_linked',
      // The two SENTINEL kinds. `run.anomaly` was never pushed: an alert
      // nobody trusts trains the operator to dismiss the channel.
      // `security.flagged` shipped with a platform-admin audience and never
      // fired once — the journal notifies only its own process and the only
      // watch was a separate CLI. Hosting the watch in the viz server would
      // have turned it on silently, so it is null until the injection screen
      // has a measured noise floor. See src/viz/push/routes.ts.
      'run.anomaly',
      'security.flagged',
      // The supervisor's bookkeeping: only the PR waiting for review and a
      // failure that left a worktree behind reach a person.
      'supervisor.verdict',
      'mender.dispatched',
      'mender.started',
      'mender.declined',
      'mender.refused',
    ] as const) {
      expect(PUSH_ROUTES[kind], kind).toBeNull();
    }
  });

  it('renders a missing detail value as an empty placeholder, not "undefined"', () => {
    const route = PUSH_ROUTES['publication.published']!;
    const rendered = renderPush(event({ kind: 'publication.published' }), 'en', route);
    expect(rendered.body).not.toContain('undefined');
    expect(fillTemplate('a {{missing}} b', {})).toBe('a  b');
  });

  it('pluralises each recovery counter independently in the subscriber locale', () => {
    const route = PUSH_ROUTES['server.recovered']!;
    const recovered = event({
      kind: 'server.recovered',
      detail: { runs: 1, publications: 2 },
    });
    expect(renderPush(recovered, 'en', route).body)
      .toBe('1 run recovered; 2 publications recovered');
    expect(renderPush(recovered, 'fr', route).body)
      .toBe('1 run récupéré ; 2 publications récupérées');
  });

  it('maps an unknown locale to English', () => {
    expect(asPushLocale('fr')).toBe('fr');
    expect(asPushLocale('en')).toBe('en');
    expect(asPushLocale('de')).toBe('de');
    expect(asPushLocale('xx')).toBe('en');
    expect(asPushLocale(null)).toBe('en');
    expect(asPushLocale(undefined)).toBe('en');
  });
});

describe('resolveAudience', () => {
  it('notifies the requester when the rule names them', () => {
    expect(resolveAudience(event(), { requester: true }, directory)).toEqual(['requester']);
  });

  it('excludes the actor from every audience that is not the requester', () => {
    // An owner who invites someone does not need telling what they just did.
    const asOwner = event({ kind: 'org.member_joined', actorId: 'owner-a' });
    const recipients = resolveAudience(
      asOwner,
      { orgOwners: true, platformAdmins: true },
      directory
    );
    expect(recipients).not.toContain('owner-a');
    expect(recipients).toEqual(expect.arrayContaining(['owner-b', 'admin-1']));
  });

  it('keeps the actor when the rule names them as requester too', () => {
    const asOwner = event({ kind: 'publication.failed', actorId: 'owner-a' });
    const recipients = resolveAudience(
      asOwner,
      { requester: true, orgOwners: true },
      directory
    );
    expect(recipients).toContain('owner-a');
    expect(recipients).toContain('owner-b');
  });

  it('deduplicates a principal reachable through two rules', () => {
    const recipients = resolveAudience(
      event({ actorId: 'admin-1' }),
      { requester: true, platformAdmins: true },
      directory
    );
    expect(recipients).toEqual(['admin-1']);
  });

  it('resolves nothing without an organisation or an actor', () => {
    expect(
      resolveAudience(event({ orgId: null }), { orgOwners: true }, directory)
    ).toEqual([]);
    expect(
      resolveAudience(
        event({ actorType: 'system', actorId: null }),
        { requester: true },
        directory
      )
    ).toEqual([]);
  });
});

describe('cachedAudienceDirectory', () => {
  it('answers each distinct read once and keys membersOf on the org set', () => {
    const counts = { owners: 0, admins: 0, everyone: 0, members: 0 };
    const cached = cachedAudienceDirectory({
      ownersOf: (orgId) => {
        counts.owners += 1;
        return [`owner-of-${orgId}`];
      },
      platformAdmins: () => {
        counts.admins += 1;
        return ['admin-1'];
      },
      allPrincipals: () => {
        counts.everyone += 1;
        return ['everyone-1'];
      },
      membersOf: (orgIds) => {
        counts.members += 1;
        return orgIds.map((orgId) => `member-of-${orgId}`);
      },
    });
    // The tray read replays resolveAudience over a page of rows: every repeat
    // must come from the cache, and distinct arguments must stay distinct.
    expect(cached.ownersOf('org-1')).toEqual(['owner-of-org-1']);
    expect(cached.ownersOf('org-1')).toEqual(['owner-of-org-1']);
    expect(cached.ownersOf('org-2')).toEqual(['owner-of-org-2']);
    expect(cached.platformAdmins()).toEqual(['admin-1']);
    expect(cached.platformAdmins()).toEqual(['admin-1']);
    expect(cached.allPrincipals()).toEqual(['everyone-1']);
    expect(cached.allPrincipals()).toEqual(['everyone-1']);
    expect(cached.membersOf(['org-1', 'org-2'])).toEqual(['member-of-org-1', 'member-of-org-2']);
    // Same set, either spelling and either order: one underlying read.
    expect(cached.membersOf(['org-2', 'org-1'])).toEqual(['member-of-org-1', 'member-of-org-2']);
    expect(cached.membersOf(['org-3'])).toEqual(['member-of-org-3']);
    expect(counts).toEqual({ owners: 2, admins: 1, everyone: 1, members: 2 });
  });
});

describe('NotificationRouter.handle', () => {
  it('pushes a finished run to its requester alone', async () => {
    const { router, calls } = routerWith();
    await router.handle(event({ detail: { status: 'delivered', goal: 'Build a clock' } }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipients).toEqual(['requester']);
    expect(calls[0]?.tag).toBe('atoma-run.finished-7');
    expect(calls[0]?.render('en')).toEqual({
      title: 'Atoma — run delivered',
      body: 'Build a clock',
    });
    expect(calls[0]?.render('fr').title).toBe('Atoma — run livré');
  });

  it('pushes a publication failure to the requester AND the org owners', async () => {
    const { router, calls } = routerWith();
    await router.handle(event({ kind: 'publication.failed', detail: { project: 'clock' } }));
    expect(calls[0]?.recipients).toEqual(
      expect.arrayContaining(['requester', 'owner-a', 'owner-b'])
    );
    expect(calls[0]?.recipients).not.toContain('admin-1');
  });

  it('pushes a new organisation to the platform admin only', async () => {
    const { router, calls } = routerWith();
    await router.handle(
      event({ kind: 'org.created', actorId: 'founder', detail: { orgName: 'Acme' } })
    );
    expect(calls[0]?.recipients).toEqual(['admin-1']);
    expect(calls[0]?.render('fr').body).toBe('Acme vient de s’inscrire');
  });

  it('pushes an admission to the owners and the admin, never the joiner', async () => {
    const { router, calls } = routerWith();
    await router.handle(
      event({
        kind: 'org.member_joined',
        actorId: 'joiner',
        detail: { member: 'Ada', orgName: 'Acme', role: 'org:member' },
      })
    );
    expect(calls[0]?.recipients).toEqual(
      expect.arrayContaining(['owner-a', 'owner-b', 'admin-1'])
    );
    expect(calls[0]?.recipients).not.toContain('joiner');
  });

  it('stays silent for audit-only kinds and for unknown ones', async () => {
    const { router, notifier } = routerWith();
    await router.handle(event({ kind: 'run.started' }));
    await router.handle(event({ kind: 'invitation.created' }));
    // A row written by a newer build: a no-op, never a crash inside the bus.
    await router.handle(event({ kind: 'quota.exceeded' as PlatformEventKind }));
    expect(notifier.notifyPrincipals).not.toHaveBeenCalled();
  });

  it('contains a directory failure instead of failing the emit', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const notifier = { notifyPrincipals: vi.fn() } as unknown as PushNotifier;
    const router = new NotificationRouter({
      notifier,
      directory: {
        ownersOf: () => {
          throw new Error('store closed');
        },
        platformAdmins: () => [],
        allPrincipals: () => [],
        membersOf: () => [],
      },
    });
    await expect(
      router.handle(event({ kind: 'publication.failed' }))
    ).resolves.toBeUndefined();
    expect(notifier.notifyPrincipals).not.toHaveBeenCalled();
    stderr.mockRestore();
  });
});
