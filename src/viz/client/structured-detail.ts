import { formatDateTime } from './date-format.js';

export type DetailTone = 'neutral' | 'success' | 'error' | 'warning' | 'info';
export type DetailPresentation = 'text' | 'code' | 'badge';

export interface StructuredDetailField {
  readonly kind: 'field';
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tone: DetailTone;
  readonly presentation: DetailPresentation;
}

export interface StructuredDetailSection {
  readonly kind: 'section';
  readonly key: string;
  readonly label: string;
  readonly count?: number;
  readonly children: readonly StructuredDetailNode[];
}

export type StructuredDetailNode = StructuredDetailField | StructuredDetailSection;

type Translator = (key: string, vars?: Record<string, unknown>) => string;

const BADGE_KEYS = new Set([
  'confidence',
  'kind',
  'mode',
  'op',
  'outcome',
  'scope',
  'strategy',
]);

const CODE_KEYS = new Set([
  'actualStdout',
  'cmd',
  'command',
  'expectedStdout',
  'recipe',
  'stderr',
  'stdout',
  'systemPrompt',
  'systemPromptAppend',
  'systemPromptReplace',
]);

const METADATA_TIMESTAMP_KEYS = new Set([
  'createdAt',
  'expiresAt',
  'modifiedAt',
  'updatedAt',
]);

function translatedOrNull(t: Translator, key: string): string | null {
  const translated = t(key);
  return translated === key ? null : translated;
}

function titleCaseIdentifier(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./-]+/g, ' ')
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function structuredDetailLabel(key: string, t: Translator): string {
  return translatedOrNull(t, `detail.field.${key}`) ?? titleCaseIdentifier(key);
}

export function eventRoleLabel(role: string | undefined, t: Translator): string {
  if (!role) return 'LLM';
  return translatedOrNull(t, `detail.role.${role}`) ?? titleCaseIdentifier(role);
}

function enumValue(key: string, value: string, t: Translator): string {
  return (
    translatedOrNull(t, `detail.enum.${key}.${value}`) ??
    translatedOrNull(t, `detail.enum.${value}`) ??
    titleCaseIdentifier(value)
  );
}

function booleanField(
  key: string,
  value: boolean,
  t: Translator
): Pick<StructuredDetailField, 'label' | 'value' | 'tone' | 'presentation'> {
  if (key === 'approved') {
    return {
      label: t('detail.field.decision'),
      value: t(value ? 'detail.value.approved' : 'detail.value.rejected'),
      tone: value ? 'success' : 'error',
      presentation: 'badge',
    };
  }
  if (key === 'ok') {
    return {
      label: t('detail.field.status'),
      value: t(value ? 'detail.value.success' : 'detail.value.failure'),
      tone: value ? 'success' : 'error',
      presentation: 'badge',
    };
  }
  if (key === 'match') {
    return {
      label: t('detail.field.comparison'),
      value: t(value ? 'detail.value.match' : 'detail.value.mismatch'),
      tone: value ? 'success' : 'error',
      presentation: 'badge',
    };
  }
  if (key === 'activeSkillFollowed') {
    return {
      label: t('detail.field.recipeAdherence'),
      value: t(value ? 'detail.value.followed' : 'detail.value.ignored'),
      tone: value ? 'success' : 'warning',
      presentation: 'badge',
    };
  }
  if (key === 'viaFallback') {
    return {
      label: t('detail.field.executionPath'),
      value: t(value ? 'detail.value.fallback' : 'detail.value.standard'),
      tone: value ? 'warning' : 'success',
      presentation: 'badge',
    };
  }
  return {
    label: structuredDetailLabel(key, t),
    value: t(value ? 'detail.value.yes' : 'detail.value.no'),
    tone: value ? 'success' : 'neutral',
    presentation: 'badge',
  };
}

function scalarField(
  key: string,
  value: unknown,
  t: Translator,
  locale?: string
): StructuredDetailField {
  if (typeof value === 'boolean') {
    return { kind: 'field', key, ...booleanField(key, value, t) };
  }
  if (value === null || value === undefined) {
    return {
      kind: 'field',
      key,
      label: structuredDetailLabel(key, t),
      value: t('detail.value.none'),
      tone: 'neutral',
      presentation: 'badge',
    };
  }
  if (typeof value === 'string') {
    const displayValue = locale && METADATA_TIMESTAMP_KEYS.has(key)
      ? formatDateTime(value, locale)
      : value;
    return {
      kind: 'field',
      key,
      label: structuredDetailLabel(key, t),
      value: BADGE_KEYS.has(key) ? enumValue(key, value, t) : displayValue,
      tone: 'neutral',
      presentation: BADGE_KEYS.has(key)
        ? 'badge'
        : CODE_KEYS.has(key)
          ? 'code'
          : 'text',
    };
  }
  return {
    kind: 'field',
    key,
    label: structuredDetailLabel(key, t),
    value:
      typeof value === 'number' || typeof value === 'bigint'
        ? `${value}`
        : JSON.stringify(value) ?? t('detail.value.none'),
    tone: 'info',
    presentation: 'code',
  };
}

function singularItemKey(parentKey: string): string {
  if (parentKey === 'subtasks') return 'subtask';
  if (parentKey === 'probes') return 'probe';
  if (parentKey === 'tools') return 'tool';
  if (parentKey === 'files') return 'file';
  return 'item';
}

const MARKDOWN_CONTENT_KEYS = new Set([
  'content',
  'text',
  'body',
  'output',
  'markdown',
  'readme',
]);

export function filePathFromArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  for (const key of ['path', 'file', 'filename']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
}

export function looksLikeMarkdown(value: string, path?: string): boolean {
  if (path && /\.(md|markdown)$/i.test(path)) return value.trim().length > 0;
  return (
    /^(?:#{1,6}\s+\S|```|(?:[-*+]|\d+\.)\s+\S)/m.test(value) ||
    /\n#{1,6}\s+\S/.test(value) ||
    /\n```/.test(value)
  );
}

export function parseMarkdownDetail(
  markdown: string,
  t: Translator
): StructuredDetailNode[] {
  const nodes: StructuredDetailNode[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let section: StructuredDetailSection | null = null;

  const pushNode = (node: StructuredDetailNode) => {
    if (section) {
      (section.children as StructuredDetailNode[]).push(node);
      return;
    }
    nodes.push(node);
  };
  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (!text) return;
    pushNode({
      kind: 'field',
      key: 'paragraph',
      label: t('detail.field.paragraph'),
      value: text,
      tone: 'neutral',
      presentation: 'text',
    });
  };
  const flushList = () => {
    if (!listItems.length) return;
    pushNode({
      kind: 'section',
      key: 'list',
      label: t('detail.field.list'),
      count: listItems.length,
      children: listItems.map((item, itemIndex) => ({
        kind: 'field' as const,
        key: `item-${itemIndex}`,
        label: t('detail.field.item'),
        value: item,
        tone: 'neutral' as const,
        presentation: 'text' as const,
      })),
    });
    listItems = [];
  };
  const closeSection = () => {
    if (!section) return;
    nodes.push(section);
    section = null;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      const lang = line.slice(3).trim();
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        buffer.push(lines[index] ?? '');
        index += 1;
      }
      pushNode({
        kind: 'field',
        key: 'code',
        label: lang || t('detail.field.code'),
        value: buffer.join('\n'),
        tone: 'neutral',
        presentation: 'code',
      });
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading?.[2]) {
      flushParagraph();
      flushList();
      closeSection();
      section = {
        kind: 'section',
        key: 'heading',
        label: heading[2].trim(),
        children: [],
      };
      index += 1;
      continue;
    }
    const list = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (list?.[1]) {
      flushParagraph();
      listItems.push(list[1].trim());
      index += 1;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      index += 1;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  flushList();
  closeSection();
  return nodes.length
    ? nodes
    : [{
        kind: 'field',
        key: 'content',
        label: t('detail.field.content'),
        value: markdown,
        tone: 'neutral',
        presentation: 'text',
      }];
}

export function buildStructuredDetail(
  value: unknown,
  t: Translator,
  options: { maxDepth?: number; maxNodes?: number; markdownPath?: string; locale?: string } = {}
): readonly StructuredDetailNode[] {
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 240;
  const markdownPath = options.markdownPath;
  let nodes = 0;
  const omittedField = (count: number): StructuredDetailField => ({
    kind: 'field',
    key: 'truncated',
    label: t('detail.field.truncated'),
    value: t('detail.value.omitted', { count }),
    tone: 'warning',
    presentation: 'badge',
  });

  const walk = (current: unknown, key: string, depth: number): StructuredDetailNode => {
    nodes++;
    if (nodes > maxNodes || depth >= maxDepth) {
      return scalarField(
        key,
        JSON.stringify(current)?.slice(0, 2000) ?? String(current),
        t,
        options.locale
      );
    }
    if (typeof current === 'string') {
      const treatAsMarkdown =
        looksLikeMarkdown(current, markdownPath) &&
        (MARKDOWN_CONTENT_KEYS.has(key) || Boolean(markdownPath && /\.(md|markdown)$/i.test(markdownPath)));
      if (treatAsMarkdown) {
        return {
          kind: 'section',
          key,
          label: structuredDetailLabel(key, t),
          children: parseMarkdownDetail(current, t),
        };
      }
    }
    if (Array.isArray(current)) {
      const itemKey = singularItemKey(key);
      const visible = current.slice(0, Math.max(0, maxNodes - nodes));
      const omitted = current.length - visible.length;
      return {
        kind: 'section',
        key,
        label: structuredDetailLabel(key, t),
        count: current.length,
        children: [
          ...visible.map((entry, index): StructuredDetailNode => {
            nodes++;
            return entry !== null && typeof entry === 'object'
              ? {
                  kind: 'section',
                  key: itemKey,
                  label: `${structuredDetailLabel(itemKey, t)} ${index + 1}`,
                  children: Array.isArray(entry)
                    ? [walk(entry, itemKey, depth + 2)]
                    : Object.entries(entry as Record<string, unknown>).map(([childKey, child]) =>
                        walk(child, childKey, depth + 2)
                      ),
                }
              : {
                  ...scalarField(itemKey, entry, t, options.locale),
                  key: `${itemKey} ${index + 1}`,
                  label: `${structuredDetailLabel(itemKey, t)} ${index + 1}`,
                };
          }),
          ...(omitted > 0 ? [omittedField(omitted)] : []),
        ],
      };
    }
    if (current !== null && typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      const visible = entries.slice(0, Math.max(0, maxNodes - nodes));
      const omitted = entries.length - visible.length;
      return {
        kind: 'section',
        key,
        label: structuredDetailLabel(key, t),
        children: [
          ...visible.map(([childKey, child]) => walk(child, childKey, depth + 1)),
          ...(omitted > 0 ? [omittedField(omitted)] : []),
        ],
      };
    }
    return scalarField(key, current, t, options.locale);
  };

  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((entry) => entry && typeof entry === 'object')) {
      return [walk(value[0], 'strategyDetails', 0), walk(value[1], 'planDetails', 0)];
    }
    return [walk(value, 'items', 0)];
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return [{
        kind: 'field',
        key: 'value',
        label: t('detail.field.value'),
        value: t('detail.value.empty'),
        tone: 'neutral',
        presentation: 'badge',
      }];
    }
    const visible = entries.slice(0, maxNodes);
    return [
      ...visible.map(([key, entry]) => walk(entry, key, 0)),
      ...(entries.length > visible.length
        ? [omittedField(entries.length - visible.length)]
        : []),
    ];
  }
  if (typeof value === 'string' && looksLikeMarkdown(value, markdownPath)) {
    return parseMarkdownDetail(value, t);
  }
  return [scalarField('value', value, t)];
}

export function skillEventTitle(
  event: { kind?: string; op?: string },
  t: Translator
): string {
  if (event.kind !== 'skill') return event.kind ?? 'skill';
  const op = event.op === 'credit-withheld' ? 'creditWithheld' : event.op;
  if (!op) return t('skill.title');
  const key = `skillOp.${op}`;
  const translated = t(key);
  return translated === key ? op : translated;
}

/** Localize known runtime messages without rewriting trace evidence or model prose. */
export function skillEventReasoning(event: { kind?: string; op?: string; reasoning?: string }, t: Translator): string | undefined {
  if (event.kind !== 'skill' || event.op !== 'credit-withheld') return event.reasoning;
  const messages: Record<string, string> = {
    "succès NON crédité — le validateur a observé que le run n'a pas suivi la recette": 'skillReason.successNotFollowed',
    "échec NON imputé — le validateur a observé que le run n'a pas suivi la recette": 'skillReason.failureNotFollowed',
    'success NOT credited — the validator observed that the run did not follow the recipe': 'skillReason.successNotFollowed',
    'failure NOT attributed — the validator observed that the run did not follow the recipe': 'skillReason.failureNotFollowed',
  };
  const key = event.reasoning && Object.hasOwn(messages, event.reasoning) ? messages[event.reasoning] : undefined;
  return key ? t(key) : event.reasoning;
}

export function skillEventSubtitle(event: {
  l1Name?: string;
  skillId?: string;
  actor?: { name?: string };
}): string {
  const path = [event.l1Name, event.skillId].filter(Boolean).join(' / ');
  const actor = event.actor?.name;
  return [path, actor && actor !== event.l1Name ? actor : ''].filter(Boolean).join(' · ');
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function buildSkillEventDetail(
  event: {
    kind?: string;
    op?: string;
    l1Name?: string;
    skillId?: string;
    reasoning?: string;
    actor?: { name?: string };
  },
  skill: {
    id: string;
    description?: string;
    whenToUse?: string;
    kind?: string;
    language?: string;
    successes?: number;
    failures?: number;
    updatedAt?: string;
    body?: string;
    shareability?: { verdict: string };
  } | null | undefined,
  t: Translator,
  locale?: string
): readonly StructuredDetailNode[] {
  const catalog = skill && skill.id === event.skillId ? skill : null;
  const payload: Record<string, unknown> = {
    decision: skillEventTitle(event, t),
    skillId: event.skillId,
    l1Name: event.l1Name,
    actor: event.actor?.name && event.actor.name !== event.l1Name
      ? event.actor.name
      : undefined,
    kind: catalog?.language ? `${catalog.kind}:${catalog.language}` : catalog?.kind,
    description: catalog?.description,
    whenToUse: catalog?.whenToUse,
    successes: catalog?.successes,
    failures: catalog?.failures,
    updatedAt: catalog?.updatedAt,
    shareability: catalog?.shareability
      ? t(`skill.share.${catalog.shareability.verdict}`)
      : undefined,
    reasoning: skillEventReasoning(event, t),
    recipe: catalog?.body ? catalog.body.slice(0, 4000) : undefined,
  };
  return buildStructuredDetail(
    Object.fromEntries(Object.entries(payload).filter(([, value]) => present(value))),
    t,
    { locale }
  );
}

export function buildLlmEnvelopeDetail(
  event: {
    toolNames?: string[];
    context?: Array<{
      id?: string;
      source?: string;
      chars?: number;
      preview?: string;
      skillId?: string;
    }>;
  },
  t: Translator
): readonly StructuredDetailNode[] {
  const nodes: StructuredDetailNode[] = [];
  if (event.toolNames && event.toolNames.length > 0) {
    nodes.push({
      kind: 'field',
      key: 'toolNames',
      label: t('detail.field.toolNames'),
      value: event.toolNames.join(', '),
      tone: 'info',
      presentation: 'badge',
    });
  }
  if (event.context && event.context.length > 0) {
    nodes.push({
      kind: 'section',
      key: 'context',
      label: t('detail.field.context'),
      count: event.context.length,
      children: event.context.map((block, index) => {
        const sourceKey = block.source
          ? `detail.enum.contextSource.${block.source}`
          : '';
        const sourceLabel = sourceKey ? t(sourceKey) : t('detail.field.source');
        return {
          kind: 'section' as const,
          key: 'contextBlock',
          label: `${sourceLabel === sourceKey ? block.source : sourceLabel} ${index + 1}`,
          children: [
            ...(block.skillId
              ? [
                  {
                    kind: 'field' as const,
                    key: 'skillId',
                    label: t('detail.field.skillId'),
                    value: block.skillId,
                    tone: 'info' as const,
                    presentation: 'badge' as const,
                  },
                ]
              : []),
            {
              kind: 'field' as const,
              key: 'chars',
              label: t('detail.field.chars'),
              value: String(block.chars ?? 0),
              tone: 'neutral' as const,
              presentation: 'badge' as const,
            },
            {
              kind: 'field' as const,
              key: 'preview',
              label: t('detail.field.preview'),
              value: block.preview ?? '',
              tone: 'neutral' as const,
              presentation: 'text' as const,
            },
          ],
        };
      }),
    });
  }
  return nodes;
}
