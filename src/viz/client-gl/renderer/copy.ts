import { elementForTool } from '../../../contracts/toolTaxonomy.js';
import { fmtCost, fmtMs, toolArgSummary, tryParseJson } from '../../client/run-utils.js';
import { timelineBranchHeading, type TimelineBranch } from '../../client/timeline-layout.js';
import type { VizEvent } from '../../client/types.js';
import type { DetailTone } from '../../client/structured-detail.js';
import { GPU_COLORS } from '../theme.js';
import { eventKindColor, llmRoleColor } from './event-palette.js';

/** The snapshot's translate function — the only copy channel to the screen. */
export type GpuTranslate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * Event copy for the GPU client: card titles, decisions, footers, branch
 * labels and accent colors. Every user-facing string goes through the
 * caller's `t` — hardcoded English here bypasses the i18n catalogs (the
 * 2026-08-14 review caught `eventDecision` doing exactly that).
 *
 * Extracted from gpu-renderer.ts (2026-08-15 decomposition).
 */
export function scalar(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === undefined || value === null) return fallback;
  return JSON.stringify(value) ?? fallback;
}

export function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}


export function quantile(values: number[], percentile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))]!;
}

/**
 * A card's accent, from the SAME table its filter chip uses — see
 * `renderer/event-palette.ts`.
 *
 * LLM cards used to take the TIER colour (teal/amber/violet). They now take a
 * position on the yellow→orange role ramp, so every model call reads as one
 * family and its shade says which phase it was. The tier has not been lost: it
 * is written on the card ("L1 Ammonia") and it still colours the atom lanes,
 * which is where the L3→L1 gradient is actually being shown.
 */
export function eventAccent(event: VizEvent): number {
  if (event.kind === 'llm' || event.kind === 'llm-start') return llmRoleColor(event.role);
  // A quarantined skill is the one case where the OUTCOME outranks the family.
  if (event.kind === 'skill' && event.op === 'quarantine') return GPU_COLORS.error;
  return eventKindColor(event.kind);
}

export function detailToneColor(tone: DetailTone): number {
  if (tone === 'success') return GPU_COLORS.success;
  if (tone === 'error') return GPU_COLORS.error;
  if (tone === 'warning') return GPU_COLORS.warning;
  if (tone === 'info') return GPU_COLORS.cyan;
  return GPU_COLORS.muted;
}

const BRANCH_COLORS = [
  0x22d3ee,
  0xe879f9,
  0x4ade80,
  0xfbbf24,
  0x6ea8ff,
  0xfb7185,
  0xa78bfa,
  0x2dd4bf,
] as const;

export function timelineBranchColor(branch: TimelineBranch): number {
  return BRANCH_COLORS[branch.colorIndex % BRANCH_COLORS.length]!;
}

export function timelineBranchLabel(
  branch: TimelineBranch,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  const heading = timelineBranchHeading(branch, t);
  if (heading.title === heading.eyebrow) return heading.eyebrow;
  return `${heading.eyebrow} · ${truncate(heading.title, 28)}`;
}


export function eventDecision(event: VizEvent, t: GpuTranslate): string {
  if (event.kind !== 'llm') return '';
  const parsed = tryParseJson(event.response) as Record<string, unknown> | undefined;
  if (!parsed || Array.isArray(parsed)) return '';
  if (event.role === 'prefilter') {
    const target = scalar(parsed['target'], 'reuse');
    return parsed['outcome'] === 'reuse'
      ? `→ ${target}`
      : parsed['outcome'] === 'escalate'
        ? t('outcome.escalate')
        : '';
  }
  if (event.role === 'validate-plan' || event.role === 'validate-result') {
    return parsed['approved'] === true
      ? t('outcome.approved')
      : parsed['approved'] === false
        ? t('outcome.rejected')
        : '';
  }
  return '';
}

export interface GpuEventCardCopy {
  title: string;
  meta: string;
  body: string;
  footer: string;
  decision: string;
}

export function resultFacts(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const value = result as Record<string, unknown>;
  const facts = [
    typeof value['ok'] === 'boolean' ? `ok=${value['ok']}` : '',
    typeof value['exitCode'] === 'number' ? `exit=${value['exitCode']}` : '',
    typeof value['status'] === 'number' ? `status=${value['status']}` : '',
    value['recorded'] === true ? 'recorded' : '',
  ];
  return facts.filter(Boolean).join(' · ');
}


/**
 * Model ids carry a release date the card has no room for and the reader has
 * no use for: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`.
 */
export function compactModelName(model: string | undefined): string {
  if (!model) return '';
  return model.replace(/-\d{8}$/, '');
}

/**
 * What was PINNED and what was actually SERVED.
 *
 * Under claude-cli, codex and ollama the transport rewrites the model, and
 * this repository's accounting rule is explicit that cost follows the served
 * model rather than the tier pin. The card showed the pin alone, so a run
 * priced as `haiku` could display a Sonnet id. When they agree — the direct
 * API — there is nothing to disambiguate and one name is shown.
 */
export function modelPairLabel(model?: string, servedModel?: string): string {
  const pin = compactModelName(model);
  const served = compactModelName(servedModel);
  if (!served || served === pin) return pin;
  if (!pin) return served;
  return `${pin} ⇢ ${served}`;
}

/** 5842 → `5.8k`, 827777 → `828k`. Cards have no room for seven digits. */
export function fmtTokenCount(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return String(Math.round(value));
  if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

/**
 * The economics of one call: what it read, what it wrote, and how much of the
 * input was served from cache. The cache figure is the load-bearing one — it
 * is routinely two orders of magnitude larger than the fresh input and is the
 * difference between a run that reuses its context and one that re-pays for
 * it — and it was not on the card at all.
 */
export function llmUsageLabel(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number } | undefined,
  t: GpuTranslate
): string {
  if (!usage) return '';
  const parts = [
    usage.inputTokens ? `${t('card.tokens.in')} ${fmtTokenCount(usage.inputTokens)}` : '',
    usage.outputTokens ? `${t('card.tokens.out')} ${fmtTokenCount(usage.outputTokens)}` : '',
    usage.cacheReadInputTokens
      ? `${t('card.tokens.cache')} ${fmtTokenCount(usage.cacheReadInputTokens)}`
      : '',
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Only an ABNORMAL stop is worth a card's width. `end_turn` is the model
 * finishing its sentence; `max_tokens` is a truncated answer that looks
 * identical on the card unless it is named, and it is the failure the
 * validators then have to reason about.
 */
export function stopReasonLabel(stopReason: string | undefined, t: GpuTranslate): string {
  if (!stopReason || stopReason === 'end_turn' || stopReason === 'stop') return '';
  return `⚠ ${t('card.stopReason', { reason: stopReason })}`;
}

export function gpuEventCardCopy(event: VizEvent, t: GpuTranslate): GpuEventCardCopy {
  const toolElement = event.kind === 'tool' && event.name
    ? elementForTool(event.name)
    : undefined;
  const title =
    event.kind === 'llm'
      ? event.role ?? 'llm'
      : event.kind === 'tool'
        ? toolElement
          ? `${toolElement.symbol} · ${event.name}`
          : event.name ?? 'tool'
        : event.kind === 'skill'
          ? event.op ?? 'skill'
          : `${event.kind}${event.op ? ` · ${event.op}` : ''}`;
  const meta = [
    event.actor?.name ? `L${event.actor.tier ?? '?'} ${event.actor.name}` : '',
    event.child?.name ? `→ ${event.child.name}` : '',
    event.subject ?? '',
    event.branchId ? `⑂ ${event.branchId.slice(0, 6)}` : '',
  ].filter(Boolean).join(' · ');
  let body = event.error ?? event.reasoning ?? '';
  if (event.kind === 'tool' && !event.error) {
    body = [toolArgSummary(event.args), resultFacts(event.result)].filter(Boolean).join(' · ');
  } else if (event.kind === 'cache') {
    body = [scalar(event.outcome), event.reasoning].filter(Boolean).join(' · ');
  } else if (event.kind === 'registry' && !body) {
    body = [
      event.snapshot?.name ?? event.name,
      event.snapshot?.description,
    ].filter(Boolean).join(' · ');
  }
  const time = Number.isFinite(event.ts)
    ? new Date(event.ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    : '';
  const footer =
    event.kind === 'llm'
      ? [
        modelPairLabel(event.model, event.servedModel),
        llmUsageLabel(event.usage, t),
        fmtMs(event.durationMs),
        fmtCost(event.costUsd),
        stopReasonLabel(event.stopReason, t),
        time,
      ].filter(Boolean).join(' · ')
      : event.kind === 'tool'
        ? [fmtMs(event.durationMs), time].filter(Boolean).join(' · ')
        : event.kind === 'trust'
          ? [`✓${scalar(event['successes'], '0')}/✗${scalar(event['failures'], '0')}`, time].filter(Boolean).join(' · ')
          : event.kind === 'skill'
            ? [`${event.l1Name ?? '?'}/${event.skillId ?? '?'}`, time].filter(Boolean).join(' · ')
            : event.kind === 'registry'
              ? [`v${event.snapshot?.version ?? scalar(event.version, '?')}`, time].filter(Boolean).join(' · ')
              : [event.model, time].filter(Boolean).join(' · ');
  return { title, meta, body, footer, decision: eventDecision(event, t) };
}

export function nowDescription(t: GpuTranslate, event: VizEvent): string {
  const vars = { actor: event.actor?.name ?? '?', child: event.child?.name ?? '?' };
  switch (event.role) {
    case 'plan':
      return t('now.doing.plan', vars);
    case 'execute':
      return t('now.doing.execute', vars);
    case 'prefilter':
      return t('now.doing.prefilter', vars);
    case 'validate-plan':
      return t('now.doing.validatePlan', vars);
    case 'validate-result':
      return t('now.doing.validateResult', vars);
    case 'fallback-plan':
    case 'fallback-execute':
      return t('now.doing.fallback', vars);
    case 'skill':
      return t('now.doing.skill', vars);
    default:
      return t('now.doing.unknown', vars);
  }
}

