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

/**
 * Importance bands for ONE sibling list, LOWEST FIRST. The panel used to show
 * a payload in whatever order the model — or a hand-built payload literal —
 * happened to declare its keys, so a tool step opened on its Arguments and a
 * skill step on four cards repeating its own title and subtitle, while the
 * verdict, the reasoning and the Result sat below the fold (2026-09-21).
 *
 * This is a PROJECTION at the typed viz boundary: the rank is never written
 * back to a trace, and no field is ever dropped for being unranked. Bands are
 * spaced by 10 so one can be inserted without renumbering.
 */
const DETAIL_RANK = {
  /** The answer and the failure — what the reader came for. */
  verdict: 10,
  /** The prose that explains that answer. */
  prose: 20,
  /** The container holding what came back. */
  answer: 30,
  /** What was acted on: a short scalar, and every unranked value. */
  locator: 40,
  /** A count or a measure. */
  quantity: 50,
  /** An ordinary nested container. */
  nested: 60,
  /** Identity and bookkeeping: ids, actors, timestamps, branch keys. */
  identity: 70,
  /** The bulky payload itself: prompts, bodies, stdout, recipes, snapshots. */
  bulk: 80,
} as const;

type DetailRank = (typeof DETAIL_RANK)[keyof typeof DETAIL_RANK];

/**
 * An OVERRIDE LIST over a type-derived default, keyed on the UNTRANSLATED key
 * — `booleanField` rewrites labels but never keys, so the table is
 * locale-independent. A key absent here still lands in a defined band; it can
 * never disappear for being new.
 */
const DETAIL_RANKS: ReadonlyMap<string, DetailRank> = new Map<string, DetailRank>([
  ['error', DETAIL_RANK.verdict],
  ['errors', DETAIL_RANK.verdict],
  ['approved', DETAIL_RANK.verdict],
  ['ok', DETAIL_RANK.verdict],
  ['match', DETAIL_RANK.verdict],
  ['outcome', DETAIL_RANK.verdict],
  ['status', DETAIL_RANK.verdict],
  ['exitCode', DETAIL_RANK.verdict],
  ['stopReason', DETAIL_RANK.verdict],
  ['decision', DETAIL_RANK.verdict],
  ['disposition', DETAIL_RANK.verdict],
  ['strategy', DETAIL_RANK.verdict],
  ['confidence', DETAIL_RANK.verdict],
  ['scope', DETAIL_RANK.verdict],
  ['op', DETAIL_RANK.verdict],
  ['covered', DETAIL_RANK.verdict],
  ['decomposable', DETAIL_RANK.verdict],
  ['timeout', DETAIL_RANK.verdict],
  ['contradiction', DETAIL_RANK.verdict],
  ['requiresReview', DETAIL_RANK.verdict],
  ['promotable', DETAIL_RANK.verdict],
  ['recorded', DETAIL_RANK.verdict],
  ['activeSkillFollowed', DETAIL_RANK.verdict],
  ['viaFallback', DETAIL_RANK.verdict],
  ['viaPrefilter', DETAIL_RANK.verdict],
  ['smokeResult', DETAIL_RANK.verdict],

  ['reasoning', DETAIL_RANK.prose],
  ['description', DETAIL_RANK.prose],
  ['whenToUse', DETAIL_RANK.prose],
  ['when_to_use', DETAIL_RANK.prose],
  ['trigger', DETAIL_RANK.prose],
  ['summary', DETAIL_RANK.prose],
  ['instruction', DETAIL_RANK.prose],
  ['proposedAction', DETAIL_RANK.prose],
  ['expectedOutput', DETAIL_RANK.prose],
  ['reason', DETAIL_RANK.prose],
  ['note', DETAIL_RANK.prose],
  ['message', DETAIL_RANK.prose],
  ['hint', DETAIL_RANK.prose],
  ['task', DETAIL_RANK.prose],
  ['query', DETAIL_RANK.prose],
  ['constraints', DETAIL_RANK.prose],
  ['additionalContext', DETAIL_RANK.prose],
  ['descriptionReplace', DETAIL_RANK.prose],
  ['paragraph', DETAIL_RANK.prose],
  ['preview', DETAIL_RANK.prose],

  ['result', DETAIL_RANK.answer],
  ['probe', DETAIL_RANK.answer],
  ['probes', DETAIL_RANK.answer],
  ['verifications', DETAIL_RANK.answer],
  ['gates', DETAIL_RANK.answer],
  ['checks', DETAIL_RANK.answer],
  ['checklist', DETAIL_RANK.answer],
  ['checklistSource', DETAIL_RANK.answer],

  ['name', DETAIL_RANK.locator],
  ['path', DETAIL_RANK.locator],
  ['file', DETAIL_RANK.locator],
  ['filename', DETAIL_RANK.locator],
  ['url', DETAIL_RANK.locator],
  ['entry', DETAIL_RANK.locator],
  ['method', DETAIL_RANK.locator],
  ['language', DETAIL_RANK.locator],
  ['title', DETAIL_RANK.locator],
  ['selector', DETAIL_RANK.locator],
  ['type', DETAIL_RANK.locator],
  ['kind', DETAIL_RANK.locator],
  ['source', DETAIL_RANK.locator],
  ['target', DETAIL_RANK.locator],
  ['preferredChild', DETAIL_RANK.locator],
  ['branchName', DETAIL_RANK.locator],
  ['label', DETAIL_RANK.locator],
  ['mode', DETAIL_RANK.locator],
  ['toolNames', DETAIL_RANK.locator],
  ['tool', DETAIL_RANK.locator],
  ['tools', DETAIL_RANK.locator],
  ['addTools', DETAIL_RANK.locator],
  ['removeTools', DETAIL_RANK.locator],
  ['model', DETAIL_RANK.locator],
  ['servedModel', DETAIL_RANK.locator],
  ['deliverable', DETAIL_RANK.locator],
  ['shareability', DETAIL_RANK.locator],
  ['writes', DETAIL_RANK.locator],
  ['files', DETAIL_RANK.locator],
  ['manifest', DETAIL_RANK.locator],
  ['servedFrom', DETAIL_RANK.locator],
  // `cmd`/`command` are CODE_KEYS, yet for a shell step the command that ran
  // is the second thing a reader wants, not part of the payload tail.
  ['cmd', DETAIL_RANK.locator],
  ['command', DETAIL_RANK.locator],

  ['successes', DETAIL_RANK.quantity],
  ['failures', DETAIL_RANK.quantity],
  ['chars', DETAIL_RANK.quantity],
  ['bytes', DETAIL_RANK.quantity],
  ['size', DETAIL_RANK.quantity],
  ['durationMs', DETAIL_RANK.quantity],
  ['costUsd', DETAIL_RANK.quantity],
  ['usage', DETAIL_RANK.quantity],
  ['index', DETAIL_RANK.quantity],
  ['total', DETAIL_RANK.quantity],
  ['attempt', DETAIL_RANK.quantity],
  ['version', DETAIL_RANK.quantity],
  ['replacements', DETAIL_RANK.quantity],
  ['matches', DETAIL_RANK.quantity],
  ['port', DETAIL_RANK.quantity],
  ['limit', DETAIL_RANK.quantity],
  ['score', DETAIL_RANK.quantity],
  ['consoleErrors', DETAIL_RANK.quantity],
  ['failedRequests', DETAIL_RANK.quantity],
  ['params', DETAIL_RANK.quantity],

  ['args', DETAIL_RANK.nested],
  ['inputs', DETAIL_RANK.nested],
  ['subtask', DETAIL_RANK.nested],
  ['subtasks', DETAIL_RANK.nested],
  ['toolCalls', DETAIL_RANK.nested],
  ['aggregation', DETAIL_RANK.nested],
  ['context', DETAIL_RANK.nested],
  ['contextBlock', DETAIL_RANK.nested],
  ['item', DETAIL_RANK.nested],
  ['items', DETAIL_RANK.nested],
  ['list', DETAIL_RANK.nested],
  ['entries', DETAIL_RANK.nested],
  ['interactions', DETAIL_RANK.nested],
  ['filters', DETAIL_RANK.nested],
  ['heading', DETAIL_RANK.nested],
  ['strategyDetails', DETAIL_RANK.nested],
  ['planDetails', DETAIL_RANK.nested],

  ['id', DETAIL_RANK.identity],
  ['ts', DETAIL_RANK.identity],
  ['role', DETAIL_RANK.identity],
  ['actor', DETAIL_RANK.identity],
  ['child', DETAIL_RANK.identity],
  ['tier', DETAIL_RANK.identity],
  ['ordinal', DETAIL_RANK.identity],
  ['branchId', DETAIL_RANK.identity],
  ['parentBranchId', DETAIL_RANK.identity],
  ['llmEventId', DETAIL_RANK.identity],
  ['l1Name', DETAIL_RANK.identity],
  ['l1AtomId', DETAIL_RANK.identity],
  ['executorName', DETAIL_RANK.identity],
  ['skillId', DETAIL_RANK.identity],
  ['by', DETAIL_RANK.identity],
  ['from', DETAIL_RANK.identity],
  ['createdBy', DETAIL_RANK.identity],
  ['createdAt', DETAIL_RANK.identity],
  ['updatedAt', DETAIL_RANK.identity],
  ['modifiedAt', DETAIL_RANK.identity],
  ['expiresAt', DETAIL_RANK.identity],
  ['sha256', DETAIL_RANK.identity],
  ['checklistDigest', DETAIL_RANK.identity],
  ['citation', DETAIL_RANK.identity],
  ['headers', DETAIL_RANK.identity],

  ['response', DETAIL_RANK.bulk],
  ['systemPrompt', DETAIL_RANK.bulk],
  ['systemPromptAppend', DETAIL_RANK.bulk],
  ['systemPromptReplace', DETAIL_RANK.bulk],
  ['userContent', DETAIL_RANK.bulk],
  ['recipe', DETAIL_RANK.bulk],
  ['body', DETAIL_RANK.bulk],
  ['content', DETAIL_RANK.bulk],
  ['text', DETAIL_RANK.bulk],
  ['markdown', DETAIL_RANK.bulk],
  ['readme', DETAIL_RANK.bulk],
  ['output', DETAIL_RANK.bulk],
  ['stdout', DETAIL_RANK.bulk],
  ['stderr', DETAIL_RANK.bulk],
  ['actual', DETAIL_RANK.bulk],
  ['actualStdout', DETAIL_RANK.bulk],
  ['expected', DETAIL_RANK.bulk],
  ['expectedStdout', DETAIL_RANK.bulk],
  ['old_string', DETAIL_RANK.bulk],
  ['new_string', DETAIL_RANK.bulk],
  ['smoke', DETAIL_RANK.bulk],
  ['inputSchema', DETAIL_RANK.bulk],
  ['snapshot', DETAIL_RANK.bulk],
  ['modifications', DETAIL_RANK.bulk],
  ['excerpt', DETAIL_RANK.bulk],
  ['quote', DETAIL_RANK.bulk],
  ['code', DETAIL_RANK.bulk],
]);

/**
 * The band an object entry belongs to. The default is derived from the JSON
 * TYPE, never from model-authored prose: a payload cannot talk its way to the
 * top of the pane, and an unranked key sorts MID-list rather than first or
 * last.
 */
function entryRank(key: string, value: unknown): DetailRank {
  const explicit = DETAIL_RANKS.get(key);
  if (explicit !== undefined) return explicit;
  if (value !== null && typeof value === 'object') return DETAIL_RANK.nested;
  if (typeof value === 'number' || typeof value === 'bigint') return DETAIL_RANK.quantity;
  if (typeof value === 'string' && (CODE_KEYS.has(key) || MARKDOWN_CONTENT_KEYS.has(key))) {
    return DETAIL_RANK.bulk;
  }
  // Derived, not whitelisted: a key the table has never seen but which ENDS in
  // `Id` or `At` is a handle or a stamp — `snapshotId`, `corpusId`, `startedAt`
  // — and belongs with the rest of the bookkeeping. Case-sensitive on purpose,
  // so an ordinary word ending in "at" or "id" is not swept up.
  if (/(?:Id|At)$/.test(key)) return DETAIL_RANK.identity;
  return DETAIL_RANK.locator;
}

/**
 * An entry with NOTHING to show. A shell step records `stderr: ''` on every
 * success, and the pane drew it as a labelled card with an empty body — an
 * `Error output` heading over blank space, on the one result where the
 * absence of an error is already stated by `Exit code 0` (2026-09-21).
 *
 * Only the EMPTY STRING qualifies. `null` and `undefined` still render as
 * their "None" badge, because a key explicitly set to null is a fact about
 * the payload; a key whose value is whitespace is not.
 */
function nothingToShow(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

/**
 * One object's entries, most interesting first. STABLE: equal ranks keep
 * declaration order, which is what preserves the hand-composed
 * `[strategyDetails, planDetails]` pair and every other curated payload whose
 * keys all share one band.
 *
 * Only OBJECT entries are ordered. Array items, `parseMarkdownDetail` output
 * and the LLM envelope keep the order they were given, because there position
 * IS the meaning: a reordered document, or a reordered tool-call sequence,
 * would describe a run that never happened.
 *
 * Ordering before the `maxNodes` slice also means truncation now sheds the
 * LEAST interesting entries rather than the last-declared ones. Nothing is
 * dropped for being UNIMPORTANT; an entry with no content at all is dropped
 * here, which is also why it never consumes a `maxNodes` slot.
 */
function orderedEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value)
    .filter(([, entry]) => !nothingToShow(entry))
    .map(([key, entry], index) => ({
      entry: [key, entry] as [string, unknown],
      index,
      rank: entryRank(key, entry),
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((ranked) => ranked.entry);
}

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
                    : orderedEntries(entry as Record<string, unknown>).map(([childKey, child]) =>
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
      const entries = orderedEntries(current as Record<string, unknown>);
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
    const entries = orderedEntries(value as Record<string, unknown>);
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
  executorName?: string;
  skillId?: string;
  actor?: { name?: string };
}): string {
  // owner / recipe → executor · initiator. The arrow is only drawn on a donor
  // match, where the recipe ran somewhere other than the namespace it lives
  // in; the emitter omits `executorName` when the two are one molecule.
  const path = [event.l1Name, event.skillId].filter(Boolean).join(' / ');
  const ran = event.executorName ? `${path} → ${event.executorName}` : path;
  const actor = event.actor?.name;
  const initiator = actor && actor !== event.l1Name && actor !== event.executorName ? actor : '';
  return [ran, initiator].filter(Boolean).join(' · ');
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function buildSkillEventDetail(
  event: {
    kind?: string;
    op?: string;
    l1Name?: string;
    executorName?: string;
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
    // No `decision` field: both clients already draw `skillEventTitle` as the
    // pane's own 15px title, and `skillEventSubtitle` the molecule, the skill
    // id and the initiator. Repeating all four as the first cards pushed the
    // description, the recipe adherence and the reasoning below the fold.
    skillId: event.skillId,
    l1Name: event.l1Name,
    executorName: event.executorName,
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
