import {
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../data-api.js';
import { useI18n } from '../i18n.js';
import { EmptyPane, ErrorPane, HelpChip, LoadingPane, StatCard } from '../shared.js';
import type { BurninRow } from '../types.js';

const FAMILY_COLORS: Record<string, string> = {
  cli: '#34d399',
  web: '#60a5fa',
  http: '#c084fc',
  app: '#6ea8ff',
  files: '#f59e0b',
};
const PAGE_SIZE = 50;

function timestamp(row: BurninRow, index = 0) {
  const parsed = Date.parse(row.ts);
  return Number.isFinite(parsed) ? parsed : index;
}

function quantile(values: number[], percentile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))]!;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function BurninChart({
  rows,
  locale,
  onZoom,
}: {
  rows: BurninRow[];
  locale: string;
  onZoom: (start: number | null, end: number | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !rows.some((row) => row.costUsd != null)) return;
    let disposed = false;
    let chart: { dispose: () => void; resize: () => void } | undefined;
    void import('../burnin-chart.js').then(({ initBurninChart }) => {
      if (disposed || !host.current) return;
      const instance = initBurninChart(host.current);
      chart = instance;
      const plotted = rows.filter((row) => row.costUsd != null);
      const families = [...new Set(plotted.map((row) => row.family))].sort();
      instance.setOption({
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { color: '#8a96ae', fontFamily: 'system-ui, sans-serif' },
        legend: { top: 4, textStyle: { color: '#8a96ae' } },
        grid: { left: 58, right: 24, top: 42, bottom: 72 },
        toolbox: {
          right: 16,
          top: 4,
          iconStyle: { borderColor: '#8a96ae' },
          feature: { dataZoom: { yAxisIndex: 'none' }, restore: {} },
        },
        tooltip: {
          trigger: 'item',
          formatter: (params: unknown) => {
            const row = (params as { data?: { row?: BurninRow } }).data?.row;
            if (!row) return '';
            return `<strong>${escapeHtml(row.taskId)}</strong><br>${new Date(timestamp(row)).toLocaleString(locale)}<br>${escapeHtml(row.family)} · ${escapeHtml(row.outcome)}<br>$${row.costUsd} · ${row.durationS ?? '?'}s · ${row.llmCalls ?? '?'} LLM`;
          },
        },
        xAxis: {
          type: 'time',
          axisLabel: {
            color: '#8a96ae',
            formatter: (value: number) =>
              new Intl.DateTimeFormat(locale, {
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(value)),
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          name: 'USD',
          min: 0,
          axisLabel: { color: '#8a96ae', formatter: (value: number) => `$${value.toFixed(2)}` },
          splitLine: { lineStyle: { color: '#1f2a3d' } },
        },
        dataZoom: [
          { type: 'inside', filterMode: 'filter', throttle: 80 },
          {
            type: 'slider',
            filterMode: 'filter',
            height: 24,
            bottom: 20,
            borderColor: '#1f2a3d',
            backgroundColor: '#0f1523',
            fillerColor: 'rgba(110,168,255,.18)',
          },
        ],
        series: families.map((family) => ({
          name: family,
          type: 'scatter',
          large: plotted.length > 2000,
          largeThreshold: 2000,
          progressive: 3000,
          itemStyle: { color: FAMILY_COLORS[family] ?? '#f59e0b' },
          data: plotted.filter((row) => row.family === family).map((row, index) => ({
            value: [timestamp(row, index), row.costUsd],
            row,
            symbol: row.outcome === 'delivered' ? 'circle' : 'emptyCircle',
            symbolSize: row.outcome === 'delivered' ? 7 : 10,
          })),
        })),
      });
      instance.on('datazoom', (event: unknown) => {
        const typed = event as {
          batch?: Array<{ start?: number; end?: number }>;
          start?: number;
          end?: number;
        };
        const zoom = typed.batch?.[0] ?? typed;
        const start = Number(zoom.start ?? 0);
        const end = Number(zoom.end ?? 100);
        const times = plotted.map(timestamp).sort((a, b) => a - b);
        if (start <= 0 && end >= 100) onZoom(null, null);
        else {
          onZoom(
            times[Math.floor((start / 100) * (times.length - 1))] ?? null,
            times[Math.ceil((end / 100) * (times.length - 1))] ?? null
          );
        }
      });
    });
    const resize = () => chart?.resize();
    window.addEventListener('resize', resize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      chart?.dispose();
    };
  }, [locale, onZoom, rows]);
  return <Box ref={host} sx={{ width: '100%', height: 360 }} />;
}

function metrics(row: BurninRow, t: (key: string) => string) {
  const values: Array<[number, string, string]> = [
    [row.deterministicPhases, '⚡', 'burnin.metric.deterministic'],
    [row.learnedSkills, '📖+', 'burnin.metric.learned'],
    [row.learnedEventSkills, '⟳+', 'burnin.metric.recovery'],
    [row.promotions, '⚙️', 'burnin.metric.promotions'],
    [row.refusals, '⛔', 'burnin.metric.refusals'],
    [row.compileErrors, '⚠', 'burnin.metric.compileErrors'],
    [row.demotions, '🛡️', 'burnin.metric.demotions'],
    [row.dispatchFallbacks, '↩', 'burnin.metric.fallbacks'],
  ];
  return [
    <HelpChip
      key="models"
      label={`O${row.opusCalls}/S${row.sonnetCalls}/H${row.haikuCalls}${row.otherCalls ? `/+${row.otherCalls}` : ''}`}
      help={t('burnin.metric.models')}
    />,
    ...values
      .filter(([count]) => count > 0)
      .map(([count, icon, key]) => (
        <HelpChip key={key} label={`${icon}${count}`} help={t(key)} />
      )),
  ];
}

export function BurninView({
  refreshKey,
  onOpenRun,
}: {
  refreshKey: number;
  onOpenRun: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  const [rows, setRows] = useState<BurninRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [family, setFamily] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [preset, setPreset] = useState('all');
  const [zoom, setZoom] = useState<[number | null, number | null]>([null, null]);
  const [chartGeneration, setChartGeneration] = useState(0);
  const [page, setPage] = useState(1);
  const handleZoom = useCallback((start: number | null, end: number | null) => {
    setZoom([start, end]);
  }, []);

  useEffect(() => {
    setLoading(true);
    void api.burnin()
      .then((payload) => {
        setRows(payload.rows);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const baseRows = useMemo(() => {
    let result = rows.filter(
      (row) =>
        (family === 'all' || row.family === family) &&
        (outcome === 'all' ||
          (outcome === 'delivered' ? row.outcome === 'delivered' : row.outcome !== 'delivered'))
    );
    if (preset !== 'all' && result.length) {
      const max = Math.max(...result.map(timestamp));
      const threshold = max - Number(preset) * 86_400_000;
      result = result.filter((row) => timestamp(row) >= threshold);
    }
    return result;
  }, [family, outcome, preset, rows]);
  const selectedRows = useMemo(
    () => baseRows.filter((row) => (zoom[0] == null || timestamp(row) >= zoom[0]) && (zoom[1] == null || timestamp(row) <= zoom[1])),
    [baseRows, zoom]
  );
  useEffect(() => setPage(1), [family, outcome, preset, zoom]);

  if (loading) return <LoadingPane />;
  if (error) return <Box sx={{ p: 2 }}><ErrorPane error={error} /></Box>;
  if (!rows.length) return <EmptyPane>{t('burnin.empty', { path: 'burnin/results.csv' }).replace(/<\/?code>/g, '')}</EmptyPane>;

  const costs = selectedRows.flatMap((row) => row.costUsd == null ? [] : [row.costUsd]);
  const durations = selectedRows.flatMap((row) => row.durationS == null ? [] : [row.durationS]);
  const delivered = selectedRows.filter((row) => row.outcome === 'delivered').length;
  const families = [...new Set(rows.map((row) => row.family))].sort();
  const totalPages = Math.max(1, Math.ceil(selectedRows.length / PAGE_SIZE));
  const pageRows = selectedRows.slice().reverse().slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <Box sx={{ p: 2 }}>
      <Paper sx={{ p: 1.25, mb: 1 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>{t('burnin.family')}</InputLabel>
            <Select value={family} label={t('burnin.family')} onChange={(event) => setFamily(event.target.value)}>
              <MenuItem value="all">{t('burnin.all')}</MenuItem>
              {families.map((name) => <MenuItem key={name} value={name}>{name}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>{t('burnin.outcome')}</InputLabel>
            <Select value={outcome} label={t('burnin.outcome')} onChange={(event) => setOutcome(event.target.value)}>
              <MenuItem value="all">{t('burnin.all')}</MenuItem>
              <MenuItem value="delivered">{t('burnin.deliveredOnly')}</MenuItem>
              <MenuItem value="failed">{t('burnin.failedOnly')}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>{t('burnin.timeRange')}</InputLabel>
            <Select value={preset} label={t('burnin.timeRange')} onChange={(event) => setPreset(event.target.value)}>
              <MenuItem value="all">{t('burnin.allTime')}</MenuItem>
              <MenuItem value="1">{t('burnin.last24h')}</MenuItem>
              <MenuItem value="7">{t('burnin.last7d')}</MenuItem>
              <MenuItem value="30">{t('burnin.last30d')}</MenuItem>
            </Select>
          </FormControl>
          <Typography color="text.secondary" variant="caption" sx={{ ml: { sm: 'auto' } }}>
            {t('burnin.selected', { count: selectedRows.length })}
          </Typography>
          {zoom[0] != null || zoom[1] != null ? (
            <Button
              size="small"
              onClick={() => {
                setZoom([null, null]);
                setChartGeneration((value) => value + 1);
              }}
            >
              {t('burnin.resetZoom')}
            </Button>
          ) : null}
        </Stack>
      </Paper>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 1, mb: 1 }}>
        <StatCard label={t('burnin.runsSelected')} value={selectedRows.length} />
        <StatCard label={t('burnin.deliveryRate')} value={`${selectedRows.length ? Math.round(delivered / selectedRows.length * 100) : 0}%`} />
        <StatCard label={t('burnin.medianCost')} value={costs.length ? `$${quantile(costs, .5)!.toFixed(3)}` : '—'} />
        <StatCard label={t('burnin.p90Duration')} value={durations.length ? `${quantile(durations, .9)}s` : '—'} />
      </Box>

      <Paper sx={{ p: 1, mb: 1 }}>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">{t('burnin.familyBreakdown')}</Typography>
          {families.map((name) => {
            const familyRows = selectedRows.filter((row) => row.family === name);
            if (!familyRows.length) return null;
            const familyCosts = familyRows.flatMap((row) => row.costUsd == null ? [] : [row.costUsd]);
            const familyRefusals = familyRows.reduce((sum, row) => sum + row.refusals, 0);
            const familyCompileErrors = familyRows.reduce((sum, row) => sum + row.compileErrors, 0);
            const lifecycleHelp = [
              familyRefusals ? t('burnin.refusals', { count: familyRefusals }) : '',
              familyCompileErrors ? t('burnin.compileErrors', { count: familyCompileErrors }) : '',
            ].filter(Boolean).join(' · ');
            return (
              <Tooltip key={name} title={lifecycleHelp}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${name} · ${familyRows.filter((row) => row.outcome === 'delivered').length}/${familyRows.length} · ${familyCosts.length ? `$${quantile(familyCosts, .5)!.toFixed(3)}` : '—'}${familyRefusals ? ` · ⛔${familyRefusals}` : ''}${familyCompileErrors ? ` · ⚠${familyCompileErrors}` : ''}`}
                  sx={{ borderLeft: `3px solid ${FAMILY_COLORS[name] ?? '#f59e0b'}` }}
                />
              </Tooltip>
            );
          })}
        </Stack>
      </Paper>

      <Paper sx={{ p: 1, mb: 1 }}>
        <BurninChart key={chartGeneration} rows={baseRows} locale={locale} onZoom={handleZoom} />
      </Paper>

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('burnin.rowsTitle')}</TableCell>
              <TableCell>{t('burnin.costDuration')}</TableCell>
              <TableCell>{t('burnin.provider')}</TableCell>
              <TableCell>{t('burnin.lifecycle')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {pageRows.map((row) => (
              <TableRow
                key={`${row.ts}-${row.taskId}`}
                hover
                onClick={() => row.trace && onOpenRun(row.trace.replace(/\.json$/, ''))}
                sx={{ cursor: row.trace ? 'pointer' : 'default' }}
              >
                <TableCell>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Box sx={{ color: row.outcome === 'delivered' ? 'success.main' : 'error.main' }}>
                      {row.outcome === 'delivered' ? '✓' : '✗'}
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{row.taskId}</Typography>
                      <Typography variant="caption" color="text.secondary">{row.ts.slice(0, 16).replace('T', ' ')}</Typography>
                    </Box>
                  </Stack>
                </TableCell>
                <TableCell>${row.costUsd?.toFixed(3) ?? '?'} · {row.durationS ?? '?'}s</TableCell>
                <TableCell>{row.provider}</TableCell>
                <TableCell><Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>{metrics(row, t)}</Stack></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Stack sx={{ pt: 1, alignItems: 'center' }}>
        <Pagination count={totalPages} page={page} onChange={(_event, value) => setPage(value)} />
      </Stack>
    </Box>
  );
}
