import { describe, expect, it } from 'vitest';
import { translate } from '../src/viz/client/i18n.js';
import {
  buildStructuredDetail,
  eventRoleLabel,
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
});
