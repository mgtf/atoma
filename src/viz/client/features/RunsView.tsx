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
import { useI18n } from '../i18n.js';
import {
  buildAtomMap,
  filterEvents,
  fmtCost,
  fmtMs,
  fmtTime,
  isAbandoned,
  isRunLive,
  toolArgSummary,
  tryParseJson,
  type AtomView,
  type EventFilters,
} from '../run-utils.js';
import { CodeBlock, EmptyPane, ErrorPane, LoadingPane, StatCard, TierChip } from '../shared.js';
import { tierColors } from '../theme.js';
import type { VizEvent, VizRun } from '../types.js';
import { useRunTrace } from '../use-runs.js';

const KIND_FILTERS = ['all', 'llm', 'tool', 'trust', 'skill', 'cache', 'registry'];

function displayValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value !== undefined) return JSON.stringify(value) ?? fallback;
  return fallback;
}

function OutcomeChips({ event }: { event: VizEvent }) {
  const { t } = useI18n();
  const parsed = tryParseJson(event.response) as Record<string, unknown> | undefined;
  if (!parsed || Array.isArray(parsed)) return null;
  if (event.role === 'prefilter') {
    const outcome = typeof parsed['outcome'] === 'string' ? parsed['outcome'] : undefined;
    const target = typeof parsed['target'] === 'string' ? parsed['target'] : '?';
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
  if (event.kind === 'llm' || event.kind === 'llm-start') return event.role ?? 'LLM';
  if (event.kind === 'tool') return event.name ?? 'tool';
  if (event.kind === 'trust') return `${event.subject ?? 'RESULT'} · ${t('event.trust.fastPath')}`;
  if (event.kind === 'cache') return t('event.cache.label');
  if (event.kind === 'skill') {
    const key = event.op === 'credit-withheld' ? 'skillOp.creditWithheld' : `skillOp.${event.op}`;
    return t(key);
  }
  if (event.kind === 'registry') return `${event.op ?? 'registry'} · ${event.snapshot?.name ?? ''}`;
  return event.kind;
}

const EventCard = memo(function EventCard({
  event,
  selected,
  onSelect,
}: {
  event: VizEvent;
  selected: boolean;
  onSelect: () => void;
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
        p: 1.25,
        width: '100%',
        textAlign: 'left',
        color: 'text.primary',
        bgcolor: selected ? 'rgba(110,168,255,.12)' : 'background.paper',
        borderColor: selected ? 'primary.main' : 'divider',
        borderLeft: `3px solid ${eventAccent(event)}`,
        cursor: interrupted ? 'default' : 'pointer',
        contentVisibility: 'auto',
        containIntrinsicSize: '72px',
        '&:hover': interrupted ? undefined : { borderColor: 'primary.main' },
      }}
    >
      <Stack spacing={0.65}>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{eventTitle(event, t)}</Typography>
          {event.actor?.tier ? <TierChip tier={event.actor.tier} label={event.actor.name} /> : null}
          {event.child?.name ? <Chip size="small" variant="outlined" label={`→ ${event.child.name}`} /> : null}
          {event.branchId ? <Chip size="small" variant="outlined" label={`⑂ ${event.branchId.slice(0, 6)}`} /> : null}
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
    <Stack spacing={0.75}>
      {[3, 2, 1].map((tier) => {
        const entries = [...atoms.values()]
          .filter((entry) => entry.snapshot.tier === tier)
          .sort((a, b) => a.snapshot.ordinal - b.snapshot.ordinal);
        return (
          <Paper key={tier} sx={{ p: 1, borderLeft: `3px solid ${tierColors[tier as 1 | 2 | 3]}` }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t(`lanes.l${tier}`)}</Typography>
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
              {!entries.length ? <Typography variant="caption" color="text.secondary">{t('common.none')}</Typography> : null}
            </Stack>
          </Paper>
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
  const roles = [...new Set(events.flatMap((event) => event.role ? [event.role] : []))];
  const branches = [...new Set(events.flatMap((event) => event.branchId ? [event.branchId] : []))];
  return (
    <Stack spacing={0.75}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={value.kind}
        onChange={(_event, next) => next && onChange({ ...value, kind: next })}
        sx={{ flexWrap: 'wrap' }}
      >
        {KIND_FILTERS.map((kind) => (
          <ToggleButton key={kind} value={kind}>{t(kind === 'all' ? 'filters.all' : `filters.${kind === 'tool' ? 'tools' : kind === 'skill' ? 'skills' : kind}`)}</ToggleButton>
        ))}
      </ToggleButtonGroup>
      {(value.kind === 'all' || value.kind === 'llm') && roles.length ? (
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
      ) : null}
      {branches.length ? (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={value.branchId}
          onChange={(_event, next) => next && onChange({ ...value, branchId: next })}
          sx={{ flexWrap: 'wrap' }}
        >
          <ToggleButton value="all">{t('filters.allBranches')}</ToggleButton>
          {branches.map((branch) => <ToggleButton key={branch} value={branch}>⑂ {branch.slice(0, 6)}</ToggleButton>)}
        </ToggleButtonGroup>
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
          return (
            <Stack key={event.id} direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip size="small" color="info" label={event.role ?? 'LLM'} />
              <Typography variant="body2">{event.actor?.name ?? '?'} · {event.model ?? ''}</Typography>
              <Typography variant="caption" color="text.secondary">
                {tools.length
                  ? t(tools.length === 1 ? 'now.activity.one' : 'now.activity', {
                    count: tools.length,
                    tool: `${last?.name ?? '?'} ${toolArgSummary(last?.args)}`,
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
          {atom.snapshot.tools.map((tool) => <Chip key={tool} size="small" label={tool} variant="outlined" />)}
        </Stack>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('common.systemPrompt')}</Typography>
        <CodeBlock maxHeight={620}>{atom.snapshot.systemPrompt}</CodeBlock>
      </Box>
    </Stack>
  );
}

function StructuredResponse({ text }: { text: string }) {
  const { t } = useI18n();
  const parsed = tryParseJson(text);
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return <CodeBlock maxHeight={720}>{parsed === undefined ? text : JSON.stringify(parsed, null, 2)}</CodeBlock>;
  }
  const strategy = parsed[0] && typeof parsed[0] === 'object'
    ? parsed[0] as Record<string, unknown>
    : {};
  const plan = parsed[1] && typeof parsed[1] === 'object'
    ? parsed[1] as Record<string, unknown>
    : {};
  const subtasks = Array.isArray(plan['subtasks']) ? plan['subtasks'] : [];
  return (
    <Stack spacing={1}>
      <Paper sx={{ p: 1.25 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('detail.strategy')}</Typography>
        <CodeBlock>{JSON.stringify(strategy, null, 2)}</CodeBlock>
      </Paper>
      <Paper sx={{ p: 1.25 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('detail.plan')}</Typography>
        <Stack spacing={0.75}>
          {subtasks.map((subtask, index) => {
            const value: Record<string, unknown> = subtask && typeof subtask === 'object'
              ? subtask as Record<string, unknown>
              : { value: subtask };
            return (
              <Paper key={index} variant="outlined" sx={{ p: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  {t('detail.subtasks')} {index + 1}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {displayValue(value['description'] ?? value['task'], `#${index + 1}`)}
                </Typography>
                {value['preferredChild'] ? (
                  <Chip size="small" variant="outlined" label={displayValue(value['preferredChild'])} sx={{ mt: 0.5 }} />
                ) : null}
              </Paper>
            );
          })}
          {!subtasks.length ? <CodeBlock>{JSON.stringify(plan, null, 2)}</CodeBlock> : null}
        </Stack>
      </Paper>
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
          <Typography variant="h6">{event.role ?? 'LLM'}</Typography>
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
    return (
      <Stack spacing={1.5}>
        <Typography variant="h6">{event.name}</Typography>
        <CodeBlock>{JSON.stringify(event.args ?? {}, null, 2)}</CodeBlock>
        <CodeBlock maxHeight={650}>{event.error ?? JSON.stringify(event.result, null, 2)}</CodeBlock>
      </Stack>
    );
  }
  if (event.kind === 'skill') {
    return (
      <Stack spacing={1.5}>
        <Typography variant="h6">{eventTitle(event, t)}</Typography>
        <Typography>{event.reasoning}</Typography>
        {event.l1Name && event.skillId ? (
          <Button variant="outlined" onClick={() => onOpenSkill(event.l1Name!, event.skillId!)}>
            {t('registry.openSkill')}
          </Button>
        ) : null}
      </Stack>
    );
  }
  if (event.kind === 'registry' && event.snapshot) {
    return <AtomDetail atom={{ snapshot: event.snapshot, origin: event.op === 'create' ? 'created' : event.op === 'branch' ? 'branched' : 'patched', events: [event] }} />;
  }
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">{eventTitle(event, t)}</Typography>
      {event.reasoning ? <Typography>{event.reasoning}</Typography> : null}
      <CodeBlock maxHeight={680}>{JSON.stringify(event, null, 2)}</CodeBlock>
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
  const visibleEvents = useMemo(() => {
    if (!run) return [];
    const live = isRunLive(run);
    return filterEvents(run.events, filters)
      .filter((event) => event.kind !== 'llm-start' || (!completed.has(String(event.llmEventId)) && !live))
      .reverse();
  }, [completed, filters, run]);
  const selectedEvent = run?.events.find((event) => event.id === selectedEventId) ?? null;
  const selectedAtom = selectedAtomName ? atoms.get(selectedAtomName) ?? null : null;

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
        {!isRunLive(run) ? (
          <Paper sx={{ p: 1, textAlign: 'center', borderColor: run.error ? 'error.main' : run.degraded ? 'warning.main' : 'success.main' }}>
            {run.cancelled ? t('marker.cancelled') : run.error ? t('marker.error') : run.degraded ? t('marker.degraded') : t('marker.end')}
          </Paper>
        ) : null}
        <Stack spacing={0.75}>
          {visibleEvents.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              selected={selectedEventId === event.id}
              onSelect={() => {
                setSelectedEventId(event.id);
                setSelectedAtomName(null);
              }}
            />
          ))}
          {!visibleEvents.length ? <EmptyPane>{t('filters.noMatch')}</EmptyPane> : null}
          <Paper sx={{ p: 1, textAlign: 'center' }}>{t('marker.start')} · {fmtTime(run.startedAt)}</Paper>
        </Stack>
      </Stack>
      <Box sx={{ p: 2, minWidth: 0, position: { lg: 'sticky' }, top: { lg: 49 }, alignSelf: 'start', maxHeight: { lg: 'calc(100vh - 49px)' }, overflow: 'auto' }}>
        {selectedEvent ? (
          <EventDetail event={selectedEvent} tab={detailTab} onTab={setDetailTab} onOpenSkill={onOpenSkill} />
        ) : selectedAtom ? (
          <AtomDetail atom={selectedAtom} />
        ) : (
          <EmptyPane>{t('pane.selectEvent')}</EmptyPane>
        )}
      </Box>
    </Box>
  );
}
