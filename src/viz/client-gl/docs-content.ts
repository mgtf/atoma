/**
 * One structured source for the end-user guide rendered by both the Pixi
 * product surface and its semantic DOM bridge. Copy remains in en.json; this
 * file owns only information architecture and locale keys.
 */

export const DOC_THEME_KEYS = [
  'quick',
  'projects',
  'goals',
  'runs',
  'review',
  'playbooks',
  'trust',
] as const;

export type DocsThemeKey = (typeof DOC_THEME_KEYS)[number];

export type DocTone =
  | 'primary'
  | 'cyan'
  | 'success'
  | 'warning'
  | 'error'
  | 'muted'
  | 'tier1'
  | 'tier2'
  | 'tier3'
  | 'magenta';

export interface DocCardSpec {
  readonly tagKey?: string;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly tone: DocTone;
}

export interface DocSectionSpec {
  readonly titleKey: string;
  readonly introKey?: string;
  readonly cards: readonly DocCardSpec[];
  readonly maxColumns: number;
  readonly flow?: boolean;
}

export interface DocPageSpec {
  readonly eyebrowKey: string;
  readonly titleKey: string;
  readonly ledeKey: string;
  readonly sections: readonly DocSectionSpec[];
}

export const DOC_THEMES: readonly { key: DocsThemeKey; navKey: string }[] =
  DOC_THEME_KEYS.map((key) => ({ key, navKey: `docs.user.theme.${key}.nav` }));

/**
 * A new `docs.user.*` namespace is deliberate: missing target-locale keys fall
 * back to English immediately, whereas reusing the former operator-oriented
 * keys would show stale translations until the translation pipeline ran.
 */
export const DOC_PAGES: Readonly<Record<DocsThemeKey, DocPageSpec>> = {
  quick: {
    eyebrowKey: 'docs.user.quick.eyebrow',
    titleKey: 'docs.user.quick.title',
    ledeKey: 'docs.user.quick.lede',
    sections: [
      {
        titleKey: 'docs.user.quick.flow.title',
        introKey: 'docs.user.quick.flow.intro',
        maxColumns: 5,
        flow: true,
        cards: [
          { tagKey: 'docs.user.step.01', titleKey: 'docs.user.quick.flow.scope.title', bodyKey: 'docs.user.quick.flow.scope.body', tone: 'primary' },
          { tagKey: 'docs.user.step.02', titleKey: 'docs.user.quick.flow.brief.title', bodyKey: 'docs.user.quick.flow.brief.body', tone: 'cyan' },
          { tagKey: 'docs.user.step.03', titleKey: 'docs.user.quick.flow.run.title', bodyKey: 'docs.user.quick.flow.run.body', tone: 'tier2' },
          { tagKey: 'docs.user.step.04', titleKey: 'docs.user.quick.flow.evidence.title', bodyKey: 'docs.user.quick.flow.evidence.body', tone: 'tier3' },
          { tagKey: 'docs.user.step.05', titleKey: 'docs.user.quick.flow.handoff.title', bodyKey: 'docs.user.quick.flow.handoff.body', tone: 'success' },
        ],
      },
      {
        titleKey: 'docs.user.quick.fit.title',
        maxColumns: 2,
        cards: [
          { tagKey: 'docs.user.quick.fit.good.tag', titleKey: 'docs.user.quick.fit.good.title', bodyKey: 'docs.user.quick.fit.good.body', tone: 'success' },
          { tagKey: 'docs.user.quick.fit.split.tag', titleKey: 'docs.user.quick.fit.split.title', bodyKey: 'docs.user.quick.fit.split.body', tone: 'warning' },
        ],
      },
      {
        titleKey: 'docs.user.quick.rule.section',
        maxColumns: 1,
        cards: [
          { tagKey: 'docs.user.quick.rule.tag', titleKey: 'docs.user.quick.rule.title', bodyKey: 'docs.user.quick.rule.body', tone: 'primary' },
        ],
      },
    ],
  },
  projects: {
    eyebrowKey: 'docs.user.projects.eyebrow',
    titleKey: 'docs.user.projects.title',
    ledeKey: 'docs.user.projects.lede',
    sections: [
      {
        titleKey: 'docs.user.projects.anatomy.title',
        maxColumns: 3,
        cards: [
          { tagKey: 'docs.user.projects.anatomy.stream.tag', titleKey: 'docs.user.projects.anatomy.stream.title', bodyKey: 'docs.user.projects.anatomy.stream.body', tone: 'primary' },
          { tagKey: 'docs.user.projects.anatomy.repo.tag', titleKey: 'docs.user.projects.anatomy.repo.title', bodyKey: 'docs.user.projects.anatomy.repo.body', tone: 'cyan' },
          { tagKey: 'docs.user.projects.anatomy.history.tag', titleKey: 'docs.user.projects.anatomy.history.title', bodyKey: 'docs.user.projects.anatomy.history.body', tone: 'success' },
        ],
      },
      {
        titleKey: 'docs.user.projects.patterns.title',
        introKey: 'docs.user.projects.patterns.intro',
        maxColumns: 3,
        cards: [
          { tagKey: 'docs.user.projects.patterns.consulting.tag', titleKey: 'docs.user.projects.patterns.consulting.title', bodyKey: 'docs.user.projects.patterns.consulting.body', tone: 'magenta' },
          { tagKey: 'docs.user.projects.patterns.product.tag', titleKey: 'docs.user.projects.patterns.product.title', bodyKey: 'docs.user.projects.patterns.product.body', tone: 'primary' },
          { tagKey: 'docs.user.projects.patterns.operations.tag', titleKey: 'docs.user.projects.patterns.operations.title', bodyKey: 'docs.user.projects.patterns.operations.body', tone: 'warning' },
        ],
      },
      {
        titleKey: 'docs.user.projects.visibility.section',
        maxColumns: 2,
        cards: [
          { tagKey: 'docs.user.projects.visibility.tag', titleKey: 'docs.user.projects.visibility.title', bodyKey: 'docs.user.projects.visibility.body', tone: 'warning' },
          { tagKey: 'docs.user.projects.access.tag', titleKey: 'docs.user.projects.access.title', bodyKey: 'docs.user.projects.access.body', tone: 'primary' },
        ],
      },
    ],
  },
  goals: {
    eyebrowKey: 'docs.user.goals.eyebrow',
    titleKey: 'docs.user.goals.title',
    ledeKey: 'docs.user.goals.lede',
    sections: [
      {
        titleKey: 'docs.user.goals.formula.title',
        introKey: 'docs.user.goals.formula.intro',
        maxColumns: 4,
        flow: true,
        cards: [
          { tagKey: 'docs.user.step.01', titleKey: 'docs.user.goals.formula.artifact.title', bodyKey: 'docs.user.goals.formula.artifact.body', tone: 'primary' },
          { tagKey: 'docs.user.step.02', titleKey: 'docs.user.goals.formula.behaviour.title', bodyKey: 'docs.user.goals.formula.behaviour.body', tone: 'cyan' },
          { tagKey: 'docs.user.step.03', titleKey: 'docs.user.goals.formula.acceptance.title', bodyKey: 'docs.user.goals.formula.acceptance.body', tone: 'success' },
          { tagKey: 'docs.user.step.04', titleKey: 'docs.user.goals.formula.constraints.title', bodyKey: 'docs.user.goals.formula.constraints.body', tone: 'warning' },
        ],
      },
      {
        titleKey: 'docs.user.goals.example.section',
        maxColumns: 1,
        cards: [
          { tagKey: 'docs.user.goals.example.tag', titleKey: 'docs.user.goals.example.title', bodyKey: 'docs.user.goals.example.body', tone: 'primary' },
        ],
      },
      {
        titleKey: 'docs.user.goals.quality.title',
        maxColumns: 2,
        cards: [
          { tagKey: 'docs.user.goals.quality.do.tag', titleKey: 'docs.user.goals.quality.do.title', bodyKey: 'docs.user.goals.quality.do.body', tone: 'success' },
          { tagKey: 'docs.user.goals.quality.avoid.tag', titleKey: 'docs.user.goals.quality.avoid.title', bodyKey: 'docs.user.goals.quality.avoid.body', tone: 'error' },
        ],
      },
    ],
  },
  runs: {
    eyebrowKey: 'docs.user.runs.eyebrow',
    titleKey: 'docs.user.runs.title',
    ledeKey: 'docs.user.runs.lede',
    sections: [
      {
        titleKey: 'docs.user.runs.status.title',
        maxColumns: 4,
        cards: [
          { tagKey: 'docs.user.runs.status.live.tag', titleKey: 'docs.user.runs.status.live.title', bodyKey: 'docs.user.runs.status.live.body', tone: 'warning' },
          { tagKey: 'docs.user.runs.status.delivered.tag', titleKey: 'docs.user.runs.status.delivered.title', bodyKey: 'docs.user.runs.status.delivered.body', tone: 'success' },
          { tagKey: 'docs.user.runs.status.failed.tag', titleKey: 'docs.user.runs.status.failed.title', bodyKey: 'docs.user.runs.status.failed.body', tone: 'error' },
          { tagKey: 'docs.user.runs.status.cancelled.tag', titleKey: 'docs.user.runs.status.cancelled.title', bodyKey: 'docs.user.runs.status.cancelled.body', tone: 'muted' },
        ],
      },
      {
        titleKey: 'docs.user.runs.read.title',
        introKey: 'docs.user.runs.read.intro',
        maxColumns: 4,
        flow: true,
        cards: [
          { tagKey: 'docs.user.step.01', titleKey: 'docs.user.runs.read.result.title', bodyKey: 'docs.user.runs.read.result.body', tone: 'primary' },
          { tagKey: 'docs.user.step.02', titleKey: 'docs.user.runs.read.proof.title', bodyKey: 'docs.user.runs.read.proof.body', tone: 'success' },
          { tagKey: 'docs.user.step.03', titleKey: 'docs.user.runs.read.summary.title', bodyKey: 'docs.user.runs.read.summary.body', tone: 'cyan' },
          { tagKey: 'docs.user.step.04', titleKey: 'docs.user.runs.read.timeline.title', bodyKey: 'docs.user.runs.read.timeline.body', tone: 'tier3' },
        ],
      },
      {
        titleKey: 'docs.user.runs.layers.title',
        introKey: 'docs.user.runs.layers.intro',
        maxColumns: 3,
        cards: [
          { tagKey: 'docs.user.runs.layers.tissue.tag', titleKey: 'docs.user.runs.layers.tissue.title', bodyKey: 'docs.user.runs.layers.tissue.body', tone: 'tier3' },
          { tagKey: 'docs.user.runs.layers.cell.tag', titleKey: 'docs.user.runs.layers.cell.title', bodyKey: 'docs.user.runs.layers.cell.body', tone: 'tier2' },
          { tagKey: 'docs.user.runs.layers.molecule.tag', titleKey: 'docs.user.runs.layers.molecule.title', bodyKey: 'docs.user.runs.layers.molecule.body', tone: 'tier1' },
        ],
      },
      {
        titleKey: 'docs.user.runs.notifications.section',
        maxColumns: 1,
        cards: [
          { tagKey: 'docs.user.runs.notifications.tag', titleKey: 'docs.user.runs.notifications.title', bodyKey: 'docs.user.runs.notifications.body', tone: 'primary' },
        ],
      },
    ],
  },
  review: {
    eyebrowKey: 'docs.user.review.eyebrow',
    titleKey: 'docs.user.review.title',
    ledeKey: 'docs.user.review.lede',
    sections: [
      {
        titleKey: 'docs.user.review.gate.title',
        maxColumns: 3,
        flow: true,
        cards: [
          { tagKey: 'docs.user.step.01', titleKey: 'docs.user.review.gate.evidence.title', bodyKey: 'docs.user.review.gate.evidence.body', tone: 'primary' },
          { tagKey: 'docs.user.step.02', titleKey: 'docs.user.review.gate.repository.title', bodyKey: 'docs.user.review.gate.repository.body', tone: 'cyan' },
          { tagKey: 'docs.user.step.03', titleKey: 'docs.user.review.gate.signoff.title', bodyKey: 'docs.user.review.gate.signoff.body', tone: 'success' },
        ],
      },
      {
        titleKey: 'docs.user.review.checklist.section',
        maxColumns: 1,
        cards: [
          { tagKey: 'docs.user.review.checklist.tag', titleKey: 'docs.user.review.checklist.title', bodyKey: 'docs.user.review.checklist.body', tone: 'success' },
        ],
      },
      {
        titleKey: 'docs.user.review.boundary.section',
        maxColumns: 1,
        cards: [
          { tagKey: 'docs.user.review.boundary.tag', titleKey: 'docs.user.review.boundary.title', bodyKey: 'docs.user.review.boundary.body', tone: 'warning' },
        ],
      },
    ],
  },
  playbooks: {
    eyebrowKey: 'docs.user.playbooks.eyebrow',
    titleKey: 'docs.user.playbooks.title',
    ledeKey: 'docs.user.playbooks.lede',
    sections: [
      {
        titleKey: 'docs.user.playbooks.patterns.title',
        introKey: 'docs.user.playbooks.patterns.intro',
        maxColumns: 3,
        cards: [
          { tagKey: 'docs.user.playbooks.consulting.tag', titleKey: 'docs.user.playbooks.consulting.title', bodyKey: 'docs.user.playbooks.consulting.body', tone: 'magenta' },
          { tagKey: 'docs.user.playbooks.product.tag', titleKey: 'docs.user.playbooks.product.title', bodyKey: 'docs.user.playbooks.product.body', tone: 'primary' },
          { tagKey: 'docs.user.playbooks.industry.tag', titleKey: 'docs.user.playbooks.industry.title', bodyKey: 'docs.user.playbooks.industry.body', tone: 'warning' },
        ],
      },
      {
        titleKey: 'docs.user.playbooks.cadence.title',
        maxColumns: 4,
        flow: true,
        cards: [
          { tagKey: 'docs.user.step.01', titleKey: 'docs.user.playbooks.cadence.frame.title', bodyKey: 'docs.user.playbooks.cadence.frame.body', tone: 'primary' },
          { tagKey: 'docs.user.step.02', titleKey: 'docs.user.playbooks.cadence.deliver.title', bodyKey: 'docs.user.playbooks.cadence.deliver.body', tone: 'cyan' },
          { tagKey: 'docs.user.step.03', titleKey: 'docs.user.playbooks.cadence.review.title', bodyKey: 'docs.user.playbooks.cadence.review.body', tone: 'success' },
          { tagKey: 'docs.user.step.04', titleKey: 'docs.user.playbooks.cadence.iterate.title', bodyKey: 'docs.user.playbooks.cadence.iterate.body', tone: 'tier3' },
        ],
      },
    ],
  },
  trust: {
    eyebrowKey: 'docs.user.trust.eyebrow',
    titleKey: 'docs.user.trust.title',
    ledeKey: 'docs.user.trust.lede',
    sections: [
      {
        titleKey: 'docs.user.trust.boundary.title',
        introKey: 'docs.user.trust.boundary.intro',
        maxColumns: 2,
        cards: [
          { tagKey: 'docs.user.trust.boundary.atoma.tag', titleKey: 'docs.user.trust.boundary.atoma.title', bodyKey: 'docs.user.trust.boundary.atoma.body', tone: 'primary' },
          { tagKey: 'docs.user.trust.boundary.team.tag', titleKey: 'docs.user.trust.boundary.team.title', bodyKey: 'docs.user.trust.boundary.team.body', tone: 'success' },
        ],
      },
      {
        titleKey: 'docs.user.trust.data.title',
        maxColumns: 3,
        cards: [
          { tagKey: 'docs.user.trust.data.secrets.tag', titleKey: 'docs.user.trust.data.secrets.title', bodyKey: 'docs.user.trust.data.secrets.body', tone: 'error' },
          { tagKey: 'docs.user.trust.data.trace.tag', titleKey: 'docs.user.trust.data.trace.title', bodyKey: 'docs.user.trust.data.trace.body', tone: 'warning' },
          { tagKey: 'docs.user.trust.data.container.tag', titleKey: 'docs.user.trust.data.container.title', bodyKey: 'docs.user.trust.data.container.body', tone: 'cyan' },
        ],
      },
      {
        titleKey: 'docs.user.trust.limits.section',
        maxColumns: 1,
        cards: [
          { tagKey: 'docs.user.trust.limits.tag', titleKey: 'docs.user.trust.limits.title', bodyKey: 'docs.user.trust.limits.body', tone: 'warning' },
        ],
      },
    ],
  },
};

/** Every key both renderers must be able to resolve, useful to contract tests. */
export function docsCatalogKeys(): string[] {
  const keys = new Set<string>(['docs.user.audience', 'docs.user.intro', 'docs.user.topics']);
  for (const theme of DOC_THEMES) keys.add(theme.navKey);
  for (const page of Object.values(DOC_PAGES)) {
    keys.add(page.eyebrowKey);
    keys.add(page.titleKey);
    keys.add(page.ledeKey);
    for (const section of page.sections) {
      keys.add(section.titleKey);
      if (section.introKey) keys.add(section.introKey);
      for (const card of section.cards) {
        if (card.tagKey) keys.add(card.tagKey);
        keys.add(card.titleKey);
        keys.add(card.bodyKey);
      }
    }
  }
  return [...keys];
}
