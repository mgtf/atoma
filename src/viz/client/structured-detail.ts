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
  'stderr',
  'stdout',
  'systemPrompt',
  'systemPromptAppend',
  'systemPromptReplace',
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
  t: Translator
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
    return {
      kind: 'field',
      key,
      label: structuredDetailLabel(key, t),
      value: BADGE_KEYS.has(key) ? enumValue(key, value, t) : value,
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

export function buildStructuredDetail(
  value: unknown,
  t: Translator,
  options: { maxDepth?: number; maxNodes?: number } = {}
): readonly StructuredDetailNode[] {
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 240;
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
        t
      );
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
                  ...scalarField(itemKey, entry, t),
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
    return scalarField(key, current, t);
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
  return [scalarField('value', value, t)];
}
