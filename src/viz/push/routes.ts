import { DEFAULT_LOCALE, SUPPORTED_LOCALES, asLocale, type Locale }
  from '../../contracts/locales.js';
import type { PlatformEvent, PlatformEventKind } from '../../contracts/platformEvents.js';

/**
 * WHO GETS PUSHED, AND WHAT THEY READ — one declarative table.
 * ============================================================
 *
 * `PUSH_ROUTES` is `Record<PlatformEventKind, PushRoute | null>`, so a kind
 * added to the vocabulary does not COMPILE until someone decides whether it
 * notifies anybody. `null` means "journal it, never push it" and is the
 * default answer for most kinds: the admin push list stays short so it stays
 * credible (decision 1 in docs/platform-events-design.md).
 *
 * Audience and copy live in the SAME entry on purpose. Two parallel tables
 * keyed by kind would be one refactor away from disagreeing — an event with
 * an audience and no copy, or copy nobody receives.
 *
 * COPY IS LOCALISED HERE, not from the client i18n catalog: that module is a
 * `.tsx` carrying a React provider and must never be imported into the
 * server. Same shape and rationale as the frozen `AUTH_COPY` / `GITHUB_COPY`
 * maps. Summaries on the event rows stay English (they are operator-facing
 * audit text); a push is product UI and follows the subscriber's language.
 *
 * TEMPLATES read from `detail`, never from `summary`. `detail` is the
 * machine-readable payload of an event; `summary` is one English human line.
 * Rendering a French notification out of an English sentence would defeat the
 * whole decision, so every notifying emitter puts what the copy needs into
 * `detail`.
 */

/**
 * A push speaks the languages the PLATFORM speaks — there is no separate
 * push vocabulary, and these aliases exist only so call sites here read as
 * push code. `src/contracts/locales.ts` is the list.
 */
export type PushLocale = Locale;
export const PUSH_LOCALES: readonly PushLocale[] = SUPPORTED_LOCALES;
export const DEFAULT_PUSH_LOCALE: PushLocale = DEFAULT_LOCALE;
export const asPushLocale = asLocale;

/**
 * Recipients, resolved per event.
 * - `requester`: the event's own actor. The ONLY rule that may notify the
 *   person who caused the event, because "your run finished" is the whole
 *   point of the feature.
 * - `orgOwners`: every `org:owner` of the event's organisation.
 * - `platformAdmins`: every instance operator.
 *
 * When `requester` is false the actor is REMOVED from the resolved set, so
 * nobody is told about their own administrative action.
 */
export interface AudienceRule {
  readonly requester?: boolean;
  readonly orgOwners?: boolean;
  readonly platformAdmins?: boolean;
}

export interface PushTemplate {
  readonly title: string;
  readonly body: string;
}

export interface PushRoute {
  readonly audience: AudienceRule;
  /** Values for the `{{placeholders}}` below, read out of `detail`. */
  readonly vars?: (event: PlatformEvent, locale: PushLocale) => Record<string, string>;
  readonly copy: Record<PushLocale, PushTemplate>;
}

/** A `detail` string, defensively: foreign rows may omit or mistype it. */
function text(event: PlatformEvent, key: string, fallback = ''): string {
  const value = event.detail?.[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

const RUN_STATUS_WORDS: Record<PushLocale, Record<string, string>> = {
  en: { delivered: 'delivered', failed: 'failed', cancelled: 'cancelled' },
  fr: { delivered: 'livré', failed: 'échoué', cancelled: 'annulé' },
};

const INSTALLATION_STATUS_WORDS: Record<PushLocale, Record<string, string>> = {
  en: { active: 'active', suspended: 'suspended', deleted: 'deleted' },
  fr: { active: 'active', suspended: 'suspendue', deleted: 'supprimée' },
};

export const PUSH_ROUTES: Record<PlatformEventKind, PushRoute | null> = {
  // --- Client-facing.
  'run.started': null,
  // Journaled for audit, never pushed: on a single-operator instance every
  // admin run would fire one.
  'run.host_subscription': null,
  // Not pushed while the rule table is uncalibrated: an alert nobody trusts
  // trains the operator to dismiss the channel. Revisit once the rules have
  // run against real batches.
  'run.anomaly': null,
  'run.finished': {
    audience: { requester: true },
    vars: (event, locale) => ({
      status:
        RUN_STATUS_WORDS[locale][text(event, 'status')] ?? text(event, 'status', 'finished'),
      goal: text(event, 'goal'),
    }),
    copy: {
      en: { title: 'Atoma — run {{status}}', body: '{{goal}}' },
      fr: { title: 'Atoma — run {{status}}', body: '{{goal}}' },
    },
  },
  // A cancellation REQUEST is not news to the person who just clicked it; the
  // run's actual end arrives as `run.finished`.
  'run.cancelled': null,
  'publication.published': {
    audience: { requester: true },
    vars: (event) => ({ repository: text(event, 'repository') }),
    copy: {
      en: { title: 'Atoma — repository ready', body: 'Published to {{repository}}' },
      fr: { title: 'Atoma — dépôt prêt', body: 'Publié sur {{repository}}' },
    },
  },
  'publication.failed': {
    // The owners too: a delivered run whose artifacts never reached GitHub is
    // the organisation's problem, not only the requester's.
    audience: { requester: true, orgOwners: true },
    vars: (event) => ({ project: text(event, 'project') }),
    copy: {
      en: {
        title: 'Atoma — publication failed',
        body: 'The run delivered but could not be published ({{project}}). A retry is available.',
      },
      fr: {
        title: 'Atoma — publication échouée',
        body: 'Le run a livré mais la publication a échoué ({{project}}). Une reprise est possible.',
      },
    },
  },
  // --- Organisation lifecycle.
  'org.created': {
    audience: { platformAdmins: true },
    vars: (event) => ({ orgName: text(event, 'orgName') }),
    copy: {
      en: { title: 'Atoma — new organisation', body: '{{orgName}} just signed up' },
      fr: { title: 'Atoma — nouvelle organisation', body: '{{orgName}} vient de s’inscrire' },
    },
  },
  'org.member_joined': {
    audience: { orgOwners: true, platformAdmins: true },
    vars: (event) => ({
      member: text(event, 'member'),
      orgName: text(event, 'orgName'),
      role: text(event, 'role'),
    }),
    copy: {
      en: { title: 'Atoma — member joined', body: '{{member}} joined {{orgName}} as {{role}}' },
      fr: { title: 'Atoma — nouveau membre', body: '{{member}} a rejoint {{orgName}} ({{role}})' },
    },
  },
  // A member renaming themselves is journaled (the org sees the new name in
  // its member list) but is nobody's notification.
  'principal.renamed': null,
  'project.created': null,
  'github.installation_linked': null,
  'github.installation_status': {
    // The publication pipeline just changed state under the organisation.
    audience: { orgOwners: true },
    vars: (event, locale) => ({
      status:
        INSTALLATION_STATUS_WORDS[locale][text(event, 'status')] ?? text(event, 'status'),
    }),
    copy: {
      en: {
        title: 'Atoma — GitHub installation',
        body: 'Your GitHub installation is now {{status}}',
      },
      fr: {
        title: 'Atoma — installation GitHub',
        body: 'Votre installation GitHub est maintenant {{status}}',
      },
    },
  },
  // --- Platform and security.
  /**
   * NOT PUSHED, and this line is a retraction.
   *
   * It shipped with `audience: { platformAdmins: true }` and an argument for
   * it — an injection signature is rare, it is a security fact, and the
   * operator wants it before the run that produced it is forgotten. The
   * argument was fine and the route never fired once: `PlatformEventLog`
   * notifies only subscribers in ITS OWN process, and the only watch was a
   * separate CLI, so nothing was ever delivered.
   *
   * Hosting the watch inside this server would have turned that dead route on
   * silently, as a side effect of "start the watch with the visualizer" — and
   * the rule behind it is an uncalibrated lexical screen whose FALSE-POSITIVE
   * rate nobody has measured. An element result is where the system's own
   * output comes back too: a molecule that writes an install script and reads
   * it back matches. Notifying an admin on that trains them to dismiss the
   * channel, which is exactly why `run.anomaly` is null.
   *
   * So it lands null and stays null until a burn-in batch gives the rule a
   * noise floor. The row is still journaled, the Sentinel screen still shows
   * it, and re-arming is one line — with a measurement behind it. The copy
   * that was drafted for it is in this file's history.
   */
  'security.flagged': null,
  'admin.granted': {
    audience: { platformAdmins: true },
    vars: (event) => ({ name: text(event, 'displayName') }),
    copy: {
      en: { title: 'Atoma — platform admin granted', body: '{{name}} is now a platform admin' },
      fr: { title: 'Atoma — admin plateforme accordé', body: '{{name}} est désormais admin' },
    },
  },
  'admin.revoked': {
    audience: { platformAdmins: true },
    vars: (event) => ({ name: text(event, 'displayName') }),
    copy: {
      en: { title: 'Atoma — platform admin revoked', body: '{{name}} is no longer an admin' },
      fr: { title: 'Atoma — admin plateforme retiré', body: '{{name}} n’est plus admin' },
    },
  },
  // The minter already knows; the journal keeps the record.
  'invitation.created': null,
  'auth.rate_limited': null,
  'auth.state_flood': {
    audience: { platformAdmins: true },
    copy: {
      en: {
        title: 'Atoma — login pressure',
        body: 'The pending-login ceiling was reached and logins are being refused',
      },
      fr: {
        title: 'Atoma — pression sur le login',
        body: 'Le plafond de connexions en attente est atteint ; des logins sont refusés',
      },
    },
  },
  'webhook.rejected': null,
  'server.recovered': {
    audience: { platformAdmins: true },
    vars: (event) => ({
      runs: text(event, 'runs', '0'),
      publications: text(event, 'publications', '0'),
    }),
    copy: {
      en: {
        title: 'Atoma — restarted after a crash',
        body: 'Recovered {{runs}} run(s) and {{publications}} publication(s)',
      },
      fr: {
        title: 'Atoma — redémarrage après incident',
        body: '{{runs}} run(s) et {{publications}} publication(s) récupérés',
      },
    },
  },
  'push.subscribed': null,
  'push.unsubscribed': null,
};

/** `{{name}}` substitution, the same convention as the client i18n catalogs. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}

export interface RenderedPush {
  readonly title: string;
  readonly body: string;
}

/** Render one event's copy for one subscriber's language. */
export function renderPush(
  event: PlatformEvent,
  locale: PushLocale,
  route: PushRoute
): RenderedPush {
  const vars = route.vars ? route.vars(event, locale) : {};
  const copy = route.copy[locale];
  return {
    title: fillTemplate(copy.title, vars).trim(),
    // An empty body is legitimate (a title-only notification); the browser
    // renders the title alone rather than an empty line.
    body: fillTemplate(copy.body, vars).trim(),
  };
}
