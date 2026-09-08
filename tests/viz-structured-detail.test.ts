import { describe, expect, it } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import {
  buildLlmEnvelopeDetail,
  buildSkillEventDetail,
  buildStructuredDetail,
  eventRoleLabel,
  looksLikeMarkdown,
  parseMarkdownDetail,
  skillEventSubtitle,
  skillEventTitle,
  structuredDetailLabel,
  type StructuredDetailField,
  type StructuredDetailSection,
} from '../src/viz/client/structured-detail.js';

const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const fr = (key: string, vars?: Record<string, unknown>) => translate('fr', key, vars);

describe('structured detail presentation', () => {
  it('keeps the tool filter discoverable in both locales', () => {
    expect(en('filters.tools')).toBe('Tools');
    expect(fr('filters.tools')).toBe('Outils');
    expect(en('filters.context')).toBe('Context');
    expect(fr('filters.context')).toBe('Contexte');
  });

  it('turns verdict booleans and prose into readable fields', () => {
    const nodes = buildStructuredDetail({
      approved: true,
      reasoning: 'Every requested document passed.',
      preferredChild: 'Ammonia',
    }, en) as StructuredDetailField[];

    expect(nodes).toEqual([
      expect.objectContaining({
        kind: 'field',
        label: 'Decision',
        value: '✓ Approved',
        tone: 'success',
        presentation: 'badge',
      }),
      expect.objectContaining({
        kind: 'field',
        label: 'Reasoning',
        value: 'Every requested document passed.',
        presentation: 'text',
      }),
      expect.objectContaining({
        kind: 'field',
        label: 'Preferred agent',
        value: 'Ammonia',
      }),
    ]);
  });

  it('recurses through plans, subtasks and nested modifications', () => {
    const nodes = buildStructuredDetail([
      { strategy: 'reuse', target: 'Ammonia', confidence: 'high' },
      {
        subtasks: [
          {
            description: 'Write the guide',
            preferredChild: 'Ammonia',
            inputs: { format: 'markdown' },
          },
        ],
        aggregation: { mode: 'sequential', instruction: 'Keep prior context' },
        modifications: { systemPromptAppend: 'Prefer concise sections.' },
      },
    ], en) as StructuredDetailSection[];

    expect(nodes.map((node) => node.label)).toEqual([
      'Routing strategy',
      'Execution plan',
    ]);
    const plan = nodes[1]!;
    const subtasks = plan.children.find((node) => node.key === 'subtasks') as StructuredDetailSection;
    expect(subtasks.label).toBe('Subtasks');
    expect(subtasks.count).toBe(1);
    const first = subtasks.children[0] as StructuredDetailSection;
    expect(first.label).toBe('Subtask 1');
    expect(first.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Preferred agent', value: 'Ammonia' }),
        expect.objectContaining({ kind: 'section', label: 'Inputs' }),
      ])
    );
    expect(plan.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'section', label: 'Requested changes' }),
      ])
    );
  });

  it('localizes labels, booleans and enum values in French', () => {
    const nodes = buildStructuredDetail({
      ok: true,
      activeSkillFollowed: false,
      mode: 'llm-synthesize',
      preferredChild: 'Water',
    }, fr) as StructuredDetailField[];

    expect(nodes).toEqual([
      expect.objectContaining({ label: 'Statut', value: '✓ Succès' }),
      expect.objectContaining({ label: 'Respect de la recette', value: '⚠ Ignorée' }),
      expect.objectContaining({ label: 'Mode', value: 'Synthèse LLM' }),
      expect.objectContaining({ label: 'Agent préféré', value: 'Water' }),
    ]);
    expect(eventRoleLabel('validate-result', fr)).toBe('Validation du résultat');
  });

  it('humanizes unknown camelCase and bounds large collections', () => {
    expect(structuredDetailLabel('customNestedValue', en)).toBe('Custom Nested Value');
    const section = buildStructuredDetail(
      { items: Array.from({ length: 20 }, (_, index) => ({ index })) },
      en,
      { maxNodes: 5 }
    )[0] as StructuredDetailSection;
    expect(section.count).toBe(20);
    expect(section.children.at(-1)).toMatchObject({
      key: 'truncated',
      value: '16 additional entries omitted',
    });
  });

  it('fills a skill event pane from the decision and catalog', () => {
    const event = {
      kind: 'skill',
      op: 'inject',
      l1Name: 'Idioblast',
      skillId: 'write-doc-and-config-files',
      actor: { name: 'Idioblast' },
    };
    expect(skillEventTitle(event, en)).toBe('Skill body injected into the molecule prompt');
    expect(skillEventSubtitle(event)).toBe('Idioblast / write-doc-and-config-files');
    // Target catalogs may be blank until CI translates changed English copy.
    // Verify the supplied translator and semantic key independently of that job.
    expect(skillEventTitle({ kind: 'skill', op: 'credit-withheld' }, (key) => `translated:${key}`))
      .toBe('translated:skillOp.creditWithheld');

    const withoutCatalog = buildSkillEventDetail(event, null, en) as StructuredDetailField[];
    expect(withoutCatalog.map((node) => node.label)).toEqual([
      'Decision',
      'Skill id',
      'Molecule',
    ]);

    const withCatalog = buildSkillEventDetail(event, {
      id: 'write-doc-and-config-files',
      kind: 'llm',
      description: 'Author paired docs and a config file.',
      whenToUse: 'Task asks for README plus config.json',
      successes: 3,
      failures: 0,
      updatedAt: '2026-08-14T00:21:19.000Z',
      body: '1. Read the workspace\n2. Write the files',
      shareability: { verdict: 'review-required' },
    }, en, 'en') as StructuredDetailField[];
    expect(withCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Description', value: 'Author paired docs and a config file.' }),
      expect.objectContaining({ label: 'When to use', value: 'Task asks for README plus config.json' }),
      expect.objectContaining({ label: 'Successes', value: '3' }),
      expect.objectContaining({
        label: 'Updated at',
        value: new Date('2026-08-14T00:21:19.000Z').toLocaleString('en', {
          dateStyle: 'long',
          timeStyle: 'short',
        }),
      }),
      expect.objectContaining({ label: 'Recipe', presentation: 'code' }),
      expect.objectContaining({
        label: 'Sharing review',
        value: '○ Nothing mechanical found — a human must still read it',
      }),
    ]));
  });

  it('parses markdown file contents instead of dumping raw text', () => {
    const markdown = [
      '# Usage',
      '',
      'Run the CLI against a fixture.',
      '',
      '- happy path',
      '- missing file',
      '',
      '```js',
      'node cli.js input.txt',
      '```',
    ].join('\n');
    expect(looksLikeMarkdown(markdown, 'README.md')).toBe(true);
    const parsed = parseMarkdownDetail(markdown, en);
    expect(parsed[0]).toMatchObject({ kind: 'section', label: 'Usage' });
    const usage = parsed[0] as StructuredDetailSection;
    expect(usage.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Paragraph', value: 'Run the CLI against a fixture.' }),
      expect.objectContaining({ kind: 'section', label: 'List', count: 2 }),
      expect.objectContaining({ label: 'js', presentation: 'code', value: 'node cli.js input.txt' }),
    ]));
    const nodes = buildStructuredDetail(
      { content: markdown },
      en,
      { markdownPath: 'README.md' }
    );
    expect(nodes[0]).toMatchObject({ kind: 'section', key: 'content', label: 'Content' });
  });
});

describe('LLM envelope detail', () => {
  it('lists tools and inject sources before the response body', () => {
    const nodes = buildLlmEnvelopeDetail(
      {
        toolNames: ['write_file', 'run_shell'],
        context: [
          {
            id: 'c1',
            source: 'skill',
            skillId: 'web-build',
            chars: 24,
            preview: 'STEP 1: write_file',
          },
        ],
      },
      en
    );
    expect(nodes[0]).toMatchObject({
      kind: 'field',
      key: 'toolNames',
      value: 'write_file, run_shell',
    });
    expect(nodes[1]).toMatchObject({
      kind: 'section',
      key: 'context',
      count: 1,
      label: 'Model-visible context',
    });
  });
});
