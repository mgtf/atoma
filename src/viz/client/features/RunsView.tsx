import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../data-api.js';
import { useI18n } from '../i18n.js';
import {
  buildAtomMap,
  coerceEventFilters,
  fmtCost,
  fmtMs,
  fmtTime,
  isAbandoned,
  isRunLive,
  toolArgSummary,
  tryParseJson,
  visibleEventKindFilters,
  type AtomView,
  type EventFilters,
} from '../run-utils.js';
import { CodeBlock, EmptyPane, ErrorPane, LoadingPane, StatCard, TierChip } from '../shared.js';
import { tierColors } from '../theme.js';
import type { SkillSummary, VizEvent, VizRun } from '../types.js';
import { useRunTrace } from '../use-runs.js';
import { elementForTool } from '../../../contracts/toolTaxonomy.js';
import { taxonomyForTier } from '../../../core/taxonomy.js';
import { currentDisplayName } from '../../../registry/taxonomyNames.js';
import {
  buildTimelineLayout,
  timelineBranchHeading,
  type TimelineBranch,
  type TimelineItem,
} from '../timeline-layout.js';
import {
  buildSkillEventDetail,
  buildStructuredDetail,
  eventRoleLabel,
  filePathFromArgs,
  skillEventSubtitle,
  skillEventTitle,
  type DetailTone,
  type StructuredDetailNode,
} from '../structured-detail.js';

const DETAIL_TONE_COLORS: Record<
  DetailTone,
  'default' | 'success' | 'error' | 'warning' | 'info'
> = {
  neutral: 'default',
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

function OutcomeChips({ event }: { event: VizEvent }) {
  const { t } = useI18n();
  const parsed = tryParseJson(event.response) as Record<string, unknown> | undefined;
  if (!parsed || Array.isArray(parsed)) return null;
  if (event.role === 'prefilter') {
    const outcome = typeof parsed['outcome'] === 'string' ? parsed['outcome'] : undefined;
    const rawTarget = typeof parsed['target'] === 'string' ? parsed['target'] : '?';
    const isSkillPrefilter = event.systemPrompt?.includes(
      'You match a subtask against a catalog of learned skills'
    );
    const childTier =
      !isSkillPrefilter && (event.actor?.tier === 2 || event.actor?.tier === 3)
        ? event.actor.tier - 1
        : undefined;
    const target = currentDisplayName(childTier, rawTarget) ?? rawTarget;
    const confidence = typeof parsed['confidence'] === 'string' ? parsed['confidence'] : undefined;
    return (
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip
          size="small"
          color={outcome === 'reuse' ? 'success' : 'warning'}
          label={outcome === 'reuse' ? t('outcome.reuse', { target }) : t('outcome.escalate')}
        />
        {confidence ? <Chip size="small" label={t('outcome.confidence', { level: confidence })} variant="outlined" /> : null}
      </Stack>
    );
  }
  if (event.role === 'validate-plan' || event.role === 'validate-result') {
    const approved = parsed['approved'] === true;
    return (
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip size="small" color={approved ? 'success' : 'error'} label={t(approved ? 'outcome.approved' : 'outcome.rejected')} />
        {typeof parsed['scope'] === 'string' ? <Chip size="small" label={t('outcome.scope', { scope: parsed['scope'] })} variant="outlined" /> : null}
        {parsed['activeSkillFollowed'] === false ? <Chip size="small" color="warning" label={t('outcome.recipeIgnored')} /> : null}
        {parsed['activeSkillFollowed'] === true ? <Chip size="small" color="success" variant="outlined" label={t('outcome.recipeFollowed')} /> : null}
      </Stack>
    );
  }
  return null;
}

function eventAccent(event: VizEvent) {
  if (event.kind === 'tool') return '#38bdf8';
  if (event.kind === 'trust') return '#fbbf24';
  if (event.kind === 'cache') return '#22d3ee';
  if (event.kind === 'skill') {
    if (event.op === 'direct') return '#fbbf24';
    if (event.op === 'quarantine') return '#f87171';
    return '#e879f9';
  }
  if (event.kind === 'registry') return '#a78bfa';
  if (event.kind === 'llm-start') return '#f87171';
  return tierColors[(event.actor?.tier ?? 0) as 1 | 2 | 3] ?? '#6ea8ff';
}

function eventTitle(event: VizEvent, t: (key: string, vars?: Record<string, unknown>) => string) {
  if (event.kind === 'llm' || event.kind === 'llm-start') return eventRoleLabel(event.role, t);
  if (event.kind === 'tool') {
    const element = event.name ? elementForTool(event.name) : undefined;
    return element ? `${element.symbol} · ${event.name}` : event.name ?? 'tool';
  }
  if (event.kind === 'trust') return `${event.subject ?? 'RESULT'} · ${t('event.trust.fastPath')}`;
  if (event.kind === 'cache') return t('event.cache.label');
  if (event.kind === 'skill') return skillEventTitle(event, t);
  if (event.kind === 'registry') return `${event.op ?? 'registry'} · ${event.snapshot?.name ?? ''}`;
  return event.kind;
}

const EventCard = memo(function EventCard({
  event,
  selected,
  onSelect,
  timelineItem,
  branch,
}: {
  event: VizEvent;
  selected: boolean;
  onSelect: () => void;
  timelineItem?: TimelineItem;
  branch?: TimelineBranch;
}) {
  const { t } = useI18n();
  const interrupted = event.kind === 'llm-start';
  return (
    <Paper
      component={interrupted ? 'div' : 'button'}
      data-event-id={event.id}
      onClick={interrupted ? undefined : onSelect}
      aria-pressed={interrupted ? undefined : selected}
      sx={{
        p: 1,
        width: 'min(520px, 100%)',
        textAlign: 'left',
        color: 'text.primary',
        bgcolor: selected ? 'rgba(110,168,255,.12)' : 'background.paper',
        borderColor: selected ? 'primary.main' : 'divider',
        borderLeft: `3px solid ${eventAccent(event)}`,
        cursor: interrupted ? 'default' : 'pointer',
        contentVisibility: 'auto',
        containIntrinsicSize: '72px',
        ml: timelineItem ? Math.min(6, timelineItem.lane * 1.5) : 0,
        boxShadow: timelineItem && timelineItem.lane > 0
          ? `${Math.min(10, timelineItem.lane * 3)}px ${Math.min(8, timelineItem.lane * 2)}px 0 rgba(2,5,11,.28)`
          : undefined,
        '&:hover': interrupted ? undefined : { borderColor: 'primary.main' },
      }}
    >
      <Stack spacing={0.35}>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{eventTitle(event, t)}</Typography>
          {event.actor?.tier ? <TierChip tier={event.actor.tier} label={event.actor.name} /> : null}
          {event.child?.name ? <Chip size="small" variant="outlined" label={`→ ${event.child.name}`} /> : null}
          {branch ? (
            <Chip
              size="small"
              variant="outlined"
              label={`${branch.parallel ? 'B' : 'P'}${branch.path.join('.')}`}
            />
          ) : null}
          {timelineItem?.branchStart && branch ? (
            <Chip
              size="small"
              color={branch.parallel ? 'info' : 'default'}
              variant="outlined"
              label={`${t(branch.parallel ? 'timeline.parallelBranch' : 'timeline.phase', {
                n: branch.path.join('.'),
              })}${branch.label ? ` · ${branch.label.slice(0, 42)}` : ''}`}
            />
          ) : null}
          {interrupted ? <Chip size="small" color="error" label={t('event.interrupted')} /> : null}
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            {fmtTime(event.ts)}
          </Typography>
        </Stack>
        <OutcomeChips event={event} />
        <Typography variant="caption" color={event.error ? 'error.main' : 'text.secondary'}>
          {event.error ??
            (event.kind === 'tool'
              ? `${toolArgSummary(event.args)} · ${fmtMs(event.durationMs)}`
              : event.kind === 'llm'
                ? `${event.model ?? ''} · ${fmtMs(event.durationMs)} · ${fmtCost(event.costUsd)}`
                : event.reasoning ?? '')}
        </Typography>
      </Stack>
    </Paper>
  );
});

function RunSummary({ run }: { run: VizRun }) {
  const { t } = useI18n();
  const totals = run.totals ?? {};
  const skillEvents = run.events.filter((event) => event.kind === 'skill');
  const direct = skillEvents.filter((event) => event.op === 'direct').length;
  const cache = run.events.filter((event) => event.kind === 'cache').length;
  const lifecycle = {
    learned: skillEvents.filter((event) => event.op === 'learn').length,
    promoted: skillEvents.filter((event) => event.op === 'promote').length,
    demoted: skillEvents.filter((event) => event.op === 'demote').length,
    revised: skillEvents.filter((event) => event.op === 'update').length,
    recovery: skillEvents.filter(
      (event) => event.op === 'inject' && /^event-trigger/i.test(event.reasoning ?? '')
    ).length,
    quarantined: skillEvents.filter((event) => event.op === 'quarantine').length,
    withheld: skillEvents.filter((event) => event.op === 'credit-withheld').length,
  };
  const live = isRunLive(run);
  return (
    <Stack spacing={1}>
      <Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h6">{live ? '● ' : ''}{run.label}</Typography>
          {live ? <Chip size="small" color="success" label={t('runs.flag.live')} /> : null}
          {run.cancelled ? <Chip size="small" color="error" label={t('runs.flag.cancelled')} /> : null}
        </Stack>
        <Typography color="text.secondary">{run.task?.description}</Typography>
      </Box>
      {live ? <Alert severity="success">{t('summary.live', { seconds: 1 })}</Alert> : null}
      {run.degraded ? <Alert severity="warning">{t('summary.degraded')}</Alert> : null}
      {run.error ? <Alert severity="error">{t('summary.error', { message: run.error })}</Alert> : null}
      {isAbandoned(run) ? <Alert severity="error">{t('summary.abandoned.value')}</Alert> : null}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', lg: 'repeat(6, 1fr)' }, gap: 0.75 }}>
        <StatCard label={t('summary.duration')} value={fmtMs(run.durationMs)} />
        <StatCard label={t('summary.llmCalls')} value={totals.calls ?? 0} />
        <StatCard label={t('summary.tokens')} value={`${totals.inputTokens ?? 0} / ${totals.outputTokens ?? 0}`} />
        <StatCard label={t('summary.cacheHit')} value={totals.cacheReadInputTokens ?? 0} accent={cache ? '#22d3ee' : undefined} />
        <StatCard label={t('summary.cost')} value={fmtCost(totals.costUsd)} />
        <StatCard label={t('summary.fallback')} value={run.result?.producedBy?.viaFallback ? t('summary.yes') : t('summary.no')} accent={direct ? '#fbbf24' : undefined} />
      </Box>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {(totals.perModel ?? []).map((value) => (
          <Chip key={value.model} size="small" variant="outlined" label={`${value.model.replace(/^claude-/, '')} · ${value.calls} · ${fmtCost(value.costUsd)}`} />
        ))}
        {direct ? <Chip size="small" color="warning" label={t('summary.freePhases.value', { count: direct })} /> : null}
        {cache ? <Chip size="small" color="info" label={t('summary.cachedRouting.value', { count: cache })} /> : null}
        {lifecycle.learned ? <Chip size="small" color="secondary" label={t('summary.lifecycle.learned', { count: lifecycle.learned })} /> : null}
        {lifecycle.promoted ? <Chip size="small" color="secondary" label={t('summary.lifecycle.promoted', { count: lifecycle.promoted })} /> : null}
        {lifecycle.demoted ? <Chip size="small" color="secondary" label={t('summary.lifecycle.demoted', { count: lifecycle.demoted })} /> : null}
        {lifecycle.revised ? <Chip size="small" color="secondary" label={t('summary.lifecycle.revised', { count: lifecycle.revised })} /> : null}
        {lifecycle.recovery ? <Chip size="small" color="info" label={t('summary.lifecycle.recovery', { count: lifecycle.recovery })} /> : null}
        {lifecycle.quarantined ? <Chip size="small" color="error" label={t('summary.guards.quarantined', { count: lifecycle.quarantined })} /> : null}
        {lifecycle.withheld ? <Chip size="small" color="warning" label={t('summary.guards.withheld', { count: lifecycle.withheld })} /> : null}
      </Stack>
      {run.result?.summary ? (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle2">{t('result.title')}</Typography>
          </AccordionSummary>
          <AccordionDetails><CodeBlock>{run.result.summary}</CodeBlock></AccordionDetails>
        </Accordion>
      ) : null}
    </Stack>
  );
}

function AtomLanes({
  atoms,
  selected,
  onSelect,
}: {
  atoms: Map<string, AtomView>;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
    >
      {[3, 2, 1].map((tier) => {
        const entries = [...atoms.values()]
          .filter((entry) => entry.snapshot.tier === tier)
          .sort((a, b) => a.snapshot.ordinal - b.snapshot.ordinal);
        if (!entries.length) return null;
        return (
          <Box
            key={tier}
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              px: 0.75,
              py: 0.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              flexWrap: 'wrap',
            }}
          >
            <Typography variant="subtitle2" sx={{ color: tierColors[tier as 1 | 2 | 3], mb: 0 }}>
              {t(`lanes.l${tier}`)}
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {entries.map((entry) => (
                <Tooltip
                  key={entry.snapshot.name}
                  title={`${t(`registry.origin.${entry.origin}`)} · v${entry.snapshot.version} · ✓${entry.snapshot.successes}/✗${entry.snapshot.failures}`}
                >
                  <Chip
                    size="small"
                    label={entry.snapshot.name}
                    color={selected === entry.snapshot.name ? 'primary' : 'default'}
                    variant={selected === entry.snapshot.name ? 'filled' : 'outlined'}
                    onClick={() => onSelect(entry.snapshot.name)}
                  />
                </Tooltip>
              ))}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

function FilterBar({
  events,
  value,
  onChange,
}: {
  events: VizEvent[];
  value: EventFilters;
  onChange: (next: EventFilters) => void;
}) {
  const { t } = useI18n();
  const kinds = visibleEventKindFilters(events);
  const filters = coerceEventFilters(events, value);
  const roles = [...new Set(events.flatMap((event) => event.role ? [event.role] : []))];
  const branches = useMemo(
    () => buildTimelineLayout(events, { ...filters, branchId: 'all' }).branches,
    [events, filters]
  );
  return (
    <Stack spacing={0.75}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
      >
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            px: 0.25,
            py: 0.25,
          }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={filters.kind}
            onChange={(_event, next) => next && onChange({ ...value, kind: next })}
            sx={{ flexWrap: 'wrap' }}
          >
            {kinds.map((kind) => (
              <ToggleButton key={kind} value={kind}>{t(kind === 'all' ? 'filters.all' : `filters.${kind === 'tool' ? 'tools' : kind === 'skill' ? 'skills' : kind}`)}</ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
        {(filters.kind === 'all' || filters.kind === 'llm') && roles.length ? (
          <Box
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              px: 0.25,
              py: 0.25,
            }}
          >
            <ToggleButtonGroup
              size="small"
              exclusive
              value={value.role}
              onChange={(_event, next) => next && onChange({ ...value, role: next })}
              sx={{ flexWrap: 'wrap' }}
            >
              <ToggleButton value="all">{t('filters.allRoles')}</ToggleButton>
              {roles.map((role) => <ToggleButton key={role} value={role}>{role}</ToggleButton>)}
            </ToggleButtonGroup>
          </Box>
        ) : null}
      </Stack>
      {branches.length ? (
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            px: 0.25,
            py: 0.25,
            alignSelf: 'flex-start',
          }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={value.branchId}
            onChange={(_event, next) => next && onChange({ ...value, branchId: next })}
            sx={{ flexWrap: 'wrap' }}
          >
            <ToggleButton value="all">{t('filters.allBranches')}</ToggleButton>
            {branches.slice(0, 8).map((branch) => {
              const heading = timelineBranchHeading(branch, t);
              return (
                <ToggleButton key={branch.id} value={branch.id}>
                  {heading.title === heading.eyebrow
                    ? heading.eyebrow
                    : `${heading.eyebrow} · ${heading.title.slice(0, 32)}`}
                </ToggleButton>
              );
            })}
          </ToggleButtonGroup>
        </Box>
      ) : null}
    </Stack>
  );
}

function NowBanner({ run, completed }: { run: VizRun; completed: Set<string> }) {
  const { t } = useI18n();
  const starts = run.events.filter(
    (event) => event.kind === 'llm-start' && typeof event.llmEventId === 'string' && !completed.has(event.llmEventId)
  );
  if (!isRunLive(run) || !starts.length) return null;
  return (
    <Alert severity="info" icon={false}>
      <Typography variant="subtitle2">{t('now.title')}</Typography>
      <Stack spacing={0.75} sx={{ mt: 0.5 }}>
        {starts.map((event) => {
          const tools = run.events.filter((candidate) => candidate.kind === 'tool' && candidate.llmEventId === event.llmEventId);
          const last = tools.at(-1);
          const lastElement = last?.name ? elementForTool(last.name) : undefined;
          return (
            <Stack key={event.id} direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip size="small" color="info" label={event.role ?? 'LLM'} />
              <Typography variant="body2">{event.actor?.name ?? '?'} · {event.model ?? ''}</Typography>
              <Typography variant="caption" color="text.secondary">
                {tools.length
                  ? t(tools.length === 1 ? 'now.activity.one' : 'now.activity', {
                    count: tools.length,
                    tool: `${lastElement ? `${lastElement.symbol} · ` : ''}${last?.name ?? '?'} ${toolArgSummary(last?.args)}`,
                    ago: Math.max(0, Math.round((Date.now() - (last?.ts ?? Date.now())) / 1000)),
                  })
                  : t('now.activity.none')}
              </Typography>
            </Stack>
          );
        })}
      </Stack>
    </Alert>
  );
}

function AtomDetail({ atom }: { atom: AtomView }) {
  const { t } = useI18n();
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="h6">{atom.snapshot.name}</Typography>
        <TierChip tier={atom.snapshot.tier} />
        <Chip
          size="small"
          label={t(
            `rank.${taxonomyForTier(atom.snapshot.tier as 1 | 2 | 3).rank}`
          )}
          variant="outlined"
        />
        <Chip size="small" label={t(`registry.origin.${atom.origin}`)} variant="outlined" />
      </Stack>
      <Typography color="text.secondary">{atom.snapshot.description}</Typography>
      <Stack direction="row" spacing={1}>
        <StatCard label={t('registry.successes')} value={atom.snapshot.successes} accent="#4ade80" />
        <StatCard label={t('registry.failures')} value={atom.snapshot.failures} accent="#f87171" />
      </Stack>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('common.tools')}</Typography>
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {atom.snapshot.tools.map((tool) => {
            const element = elementForTool(tool);
            return (
              <Chip
                key={tool}
                size="small"
                label={element ? `${element.symbol} · ${tool}` : tool}
                title={element?.name}
                variant="outlined"
              />
            );
          })}
        </Stack>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('common.systemPrompt')}</Typography>
        <CodeBlock maxHeight={620}>{atom.snapshot.systemPrompt}</CodeBlock>
      </Box>
    </Stack>
  );
}

function StructuredNodeView({
  node,
  path,
  depth = 0,
}: {
  node: StructuredDetailNode;
  path: string;
  depth?: number;
}) {
  if (node.kind === 'field') {
    return (
      <Paper
        variant="outlined"
        sx={{
          px: 1.25,
          py: 1,
          bgcolor: depth > 0 ? 'rgba(255,255,255,0.018)' : 'transparent',
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.45, letterSpacing: '0.04em' }}
        >
          {node.label}
        </Typography>
        {node.presentation === 'badge' ? (
          <Chip
            size="small"
            color={DETAIL_TONE_COLORS[node.tone]}
            variant={node.tone === 'neutral' ? 'outlined' : 'filled'}
            label={node.value}
          />
        ) : (
          <Typography
            variant="body2"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              lineHeight: 1.55,
              fontFamily:
                node.presentation === 'code'
                  ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
                  : undefined,
              color: node.tone === 'info' ? 'info.light' : 'text.primary',
            }}
          >
            {node.value}
          </Typography>
        )}
      </Paper>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.15,
        borderLeftWidth: depth > 0 ? 3 : 1,
        borderLeftColor: depth > 0 ? 'primary.main' : 'divider',
        bgcolor: depth > 0 ? 'rgba(110,168,255,0.025)' : 'transparent',
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.85 }}>
        <Typography variant="subtitle2">{node.label}</Typography>
        {node.count !== undefined ? (
          <Chip size="small" variant="outlined" label={node.count} />
        ) : null}
      </Stack>
      <Stack spacing={0.75}>
        {node.children.map((child, index) => (
          <StructuredNodeView
            key={`${path}.${child.key}.${index}`}
            node={child}
            path={`${path}.${child.key}.${index}`}
            depth={depth + 1}
          />
        ))}
      </Stack>
    </Paper>
  );
}

function StructuredValue({
  value,
  markdownPath,
}: {
  value: unknown;
  markdownPath?: string;
}) {
  const { t } = useI18n();
  const nodes = buildStructuredDetail(value, t, { markdownPath });
  return (
    <Stack spacing={0.85}>
      {nodes.map((node, index) => (
        <StructuredNodeView
          key={`root.${node.key}.${index}`}
          node={node}
          path={`root.${node.key}.${index}`}
        />
      ))}
    </Stack>
  );
}

function StructuredResponse({ text }: { text: string }) {
  const parsed = tryParseJson(text);
  return parsed === undefined
    ? <CodeBlock maxHeight={720}>{text}</CodeBlock>
    : <StructuredValue value={parsed} />;
}

function SkillEventDetail({
  event,
  onOpenSkill,
}: {
  event: VizEvent;
  onOpenSkill: (l1Name: string, id: string) => void;
}) {
  const { t } = useI18n();
  const [skill, setSkill] = useState<SkillSummary | null>(null);
  useEffect(() => {
    setSkill(null);
    if (!event.l1Name || !event.skillId) return;
    let cancelled = false;
    void api.skill(event.l1Name, event.skillId)
      .then((detail) => {
        if (!cancelled) setSkill(detail);
      })
      .catch(() => {
        if (!cancelled) setSkill(null);
      });
    return () => {
      cancelled = true;
    };
  }, [event.l1Name, event.skillId]);
  const nodes = buildSkillEventDetail(event, skill, t);
  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="h6">{skillEventTitle(event, t)}</Typography>
        <Typography color="text.secondary">{skillEventSubtitle(event)}</Typography>
      </Box>
      <Stack spacing={0.85}>
        {nodes.map((node, index) => (
          <StructuredNodeView
            key={`skill.${node.key}.${index}`}
            node={node}
            path={`skill.${node.key}.${index}`}
          />
        ))}
      </Stack>
      {event.l1Name && event.skillId ? (
        <Button variant="outlined" onClick={() => onOpenSkill(event.l1Name!, event.skillId!)}>
          {t('registry.openSkill')}
        </Button>
      ) : null}
    </Stack>
  );
}

function EventDetail({
  event,
  tab,
  onTab,
  onOpenSkill,
}: {
  event: VizEvent;
  tab: number;
  onTab: (value: number) => void;
  onOpenSkill: (l1Name: string, id: string) => void;
}) {
  const { t } = useI18n();
  if (event.kind === 'llm') {
    const blocks = [
      event.systemPrompt ?? '',
      event.userContent ?? '',
      event.response ?? t('detail.noResponse'),
    ];
    return (
      <Box>
        <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
          <Typography variant="h6">{eventRoleLabel(event.role, t)}</Typography>
          <TierChip tier={event.actor?.tier} label={event.actor?.name} />
          <Chip size="small" label={event.model ?? '?'} variant="outlined" />
        </Stack>
        <Tabs value={tab} onChange={(_event, value) => onTab(value)} variant="scrollable">
          <Tab label={t('detail.system')} />
          <Tab label={t('detail.user')} />
          <Tab label={t('detail.response')} />
        </Tabs>
        {tab === 2
          ? <StructuredResponse text={blocks[tab] ?? ''} />
          : <CodeBlock maxHeight={720}>{blocks[tab] ?? ''}</CodeBlock>}
      </Box>
    );
  }
  if (event.kind === 'tool') {
    const element = event.name ? elementForTool(event.name) : undefined;
    return (
      <Stack spacing={1.5}>
        <Typography variant="h6">
          {element ? `${element.name} (${element.symbol}) · ${event.name}` : event.name}
        </Typography>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('detail.arguments')}</Typography>
          <StructuredValue value={event.args ?? {}} />
        </Box>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('detail.result')}</Typography>
          {event.error
            ? <Alert severity="error">{event.error}</Alert>
            : <StructuredValue value={event.result} markdownPath={filePathFromArgs(event.args)} />}
        </Box>
      </Stack>
    );
  }
  if (event.kind === 'skill') {
    return <SkillEventDetail event={event} onOpenSkill={onOpenSkill} />;
  }
  if (event.kind === 'registry' && event.snapshot) {
    return <AtomDetail atom={{ snapshot: event.snapshot, origin: event.op === 'create' ? 'created' : event.op === 'branch' ? 'branched' : 'patched', events: [event] }} />;
  }
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">{eventTitle(event, t)}</Typography>
      {event.reasoning ? <Typography>{event.reasoning}</Typography> : null}
      <StructuredValue value={event} />
    </Stack>
  );
}

export function RunsView({
  runId,
  active,
  refreshKey,
  onOpenSkill,
}: {
  runId: string | null;
  active: boolean;
  refreshKey: number;
  onOpenSkill: (l1Name: string, id: string) => void;
}) {
  const { t } = useI18n();
  const { run, loading, error, refresh } = useRunTrace(runId, active);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedAtomName, setSelectedAtomName] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState(1);
  const [filters, setFilters] = useState<EventFilters>({ kind: 'all', role: 'all', branchId: 'all' });
  const [runSummaryOpen, setRunSummaryOpen] = useState(true);
  const [, setClock] = useState(0);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef(0);
  const previousEventCountRef = useRef(0);
  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    setSelectedEventId(null);
    setSelectedAtomName(null);
    setRunSummaryOpen(true);
    setFilters({ kind: 'all', role: 'all', branchId: 'all' });
    previousHeightRef.current = 0;
    previousEventCountRef.current = 0;
  }, [runId]);
  useEffect(() => {
    if (!run || !isRunLive(run)) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [run]);
  useLayoutEffect(() => {
    const pane = leftPaneRef.current;
    if (!pane) return;
    if (
      run &&
      run.events.length > previousEventCountRef.current &&
      pane.scrollTop > 0 &&
      previousHeightRef.current > 0
    ) {
      pane.scrollTop += pane.scrollHeight - previousHeightRef.current;
    }
    previousEventCountRef.current = run?.events.length ?? 0;
    previousHeightRef.current = pane.scrollHeight;
  }, [run?.events.length]);

  const atoms = useMemo(() => run ? buildAtomMap(run) : new Map<string, AtomView>(), [run]);
  const completed = useMemo(
    () => new Set((run?.events ?? []).filter((event) => event.kind === 'llm').map((event) => event.id)),
    [run]
  );
  const appliedFilters = run ? coerceEventFilters(run.events, filters) : filters;
  const timeline = useMemo(
    () => run ? buildTimelineLayout(run.events, appliedFilters) : null,
    [appliedFilters, run]
  );
  const visibleItems = timeline?.items ?? [];
  const branchById = useMemo(
    () => new Map((timeline?.branches ?? []).map((branch) => [branch.id, branch])),
    [timeline]
  );
  const selectedBranchHeading = useMemo(() => {
    if (appliedFilters.branchId === 'all' || !run) return null;
    const overview = buildTimelineLayout(run.events, { ...appliedFilters, branchId: 'all' });
    const branch = overview.branches.find((item) => item.id === appliedFilters.branchId);
    return branch
      ? timelineBranchHeading(branch, t)
      : {
          eyebrow: t('filters.branch', { id: appliedFilters.branchId }),
          title: t('filters.branch', { id: appliedFilters.branchId }),
          lines: [],
        };
  }, [appliedFilters, run, t]);
  const selectedEvent = run?.events.find((event) => event.id === selectedEventId) ?? null;
  const selectedAtom = selectedAtomName ? atoms.get(selectedAtomName) ?? null : null;
  useEffect(() => {
    setRunSummaryOpen(!selectedEventId && !selectedAtomName);
  }, [selectedEventId, selectedAtomName]);

  if (!runId) return <EmptyPane>{t('runs.none')}</EmptyPane>;
  if (loading && !run) return <LoadingPane />;
  if (error && !run) return <Box sx={{ p: 2 }}><ErrorPane error={error} /></Box>;
  if (!run) return <EmptyPane>{t('runs.notFound')}</EmptyPane>;

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(520px, 1fr) minmax(400px, 520px)' }, minHeight: 'calc(100vh - 49px)' }}>
      <Stack
        ref={leftPaneRef}
        spacing={1}
        sx={{
          p: 1.5,
          minWidth: 0,
          borderRight: { lg: 1 },
          borderColor: 'divider',
          maxHeight: { lg: 'calc(100vh - 49px)' },
          overflow: { lg: 'auto' },
        }}
      >
        <RunSummary run={run} />
        <AtomLanes
          atoms={atoms}
          selected={selectedAtomName}
          onSelect={(name) => {
            setSelectedAtomName(name);
            setSelectedEventId(null);
          }}
        />
        <FilterBar events={run.events} value={filters} onChange={setFilters} />
        <NowBanner run={run} completed={completed} />
        {selectedBranchHeading ? (
          <Accordion defaultExpanded disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.8 }}>
                  {selectedBranchHeading.eyebrow}
                </Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, whiteSpace: 'normal' }}>
                  {selectedBranchHeading.title}
                </Typography>
              </Box>
            </AccordionSummary>
            {selectedBranchHeading.lines.length ? (
              <AccordionDetails>
                <Stack component="ul" spacing={0.4} sx={{ m: 0, pl: 2 }}>
                  {selectedBranchHeading.lines.map((line) => (
                    <Typography key={line} component="li" variant="body2" color="text.secondary">
                      {line}
                    </Typography>
                  ))}
                </Stack>
              </AccordionDetails>
            ) : null}
          </Accordion>
        ) : null}
        <Stack
          spacing={0.75}
          sx={{
            position: 'relative',
            pl: 2,
            '&::before': {
              content: '""',
              position: 'absolute',
              left: 7,
              top: 8,
              bottom: 8,
              width: 2,
              bgcolor: 'primary.main',
              opacity: 0.35,
            },
          }}
        >
          <Paper sx={{ p: 1, textAlign: 'center' }}>
            {t('marker.start')} · {fmtTime(run.startedAt)}
          </Paper>
          {visibleItems.map((item) => (
            <EventCard
              key={item.event.id}
              event={item.event}
              selected={selectedEventId === item.event.id}
              timelineItem={item}
              branch={item.branchId ? branchById.get(item.branchId) : undefined}
              onSelect={() => {
                setSelectedEventId(item.event.id);
                setSelectedAtomName(null);
              }}
            />
          ))}
          {!visibleItems.length ? <EmptyPane>{t('filters.noMatch')}</EmptyPane> : null}
          {!isRunLive(run) ? (
            <Paper sx={{ p: 1, textAlign: 'center', borderColor: run.error ? 'error.main' : run.degraded ? 'warning.main' : 'success.main' }}>
              {run.cancelled ? t('marker.cancelled') : run.error ? t('marker.error') : run.degraded ? t('marker.degraded') : t('marker.end')}
            </Paper>
          ) : null}
        </Stack>
      </Stack>
      <Box sx={{ p: 2, minWidth: 0, position: { lg: 'sticky' }, top: { lg: 49 }, alignSelf: 'start', maxHeight: { lg: 'calc(100vh - 49px)' }, overflow: 'auto' }}>
        <Accordion
          expanded={runSummaryOpen}
          onChange={(_event, next) => setRunSummaryOpen(next)}
          disableGutters
          sx={{ mb: 1.5 }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box>
              <Typography variant="overline" color="text.secondary">{t('run.summary')}</Typography>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{run.label}</Typography>
              <Typography variant="body2" color="text.secondary">
                {[fmtMs(run.durationMs), t('runs.calls', { count: run.totals?.calls ?? 0 }), fmtCost(run.totals?.costUsd)].join(' · ')}
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            {run.task?.description ? (
              <Box>
                <Typography variant="caption" color="text.secondary">{t('run.goal')}</Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{run.task.description}</Typography>
              </Box>
            ) : null}
          </AccordionDetails>
        </Accordion>
        {selectedEvent ? (
          <EventDetail event={selectedEvent} tab={detailTab} onTab={setDetailTab} onOpenSkill={onOpenSkill} />
        ) : selectedAtom ? (
          <AtomDetail atom={selectedAtom} />
        ) : !runSummaryOpen ? (
          <EmptyPane>{t('pane.selectEvent')}</EmptyPane>
        ) : null}
      </Box>
    </Box>
  );
}
