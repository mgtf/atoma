import RefreshIcon from '@mui/icons-material/Refresh';
import {
  AppBar,
  Box,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { SkillSelection } from './features/SkillsView.js';
import { I18N_CATALOGS, useI18n } from './i18n.js';
import { RunPicker, type RunPickerOption } from './run-picker.js';
import { fmtCost, isIndexEntryLive } from './run-utils.js';
import { useRunsIndex } from './use-runs.js';
import type { RunIndexEntry } from './types.js';
import { LoadingPane } from './shared.js';

const RunsView = lazy(() =>
  import('./features/RunsView.js').then((module) => ({ default: module.RunsView }))
);
const RegistryView = lazy(() =>
  import('./features/RegistryView.js').then((module) => ({ default: module.RegistryView }))
);
const SkillsView = lazy(() =>
  import('./features/SkillsView.js').then((module) => ({ default: module.SkillsView }))
);
const BurninView = lazy(() =>
  import('./features/BurninView.js').then((module) => ({ default: module.BurninView }))
);
const LaunchView = lazy(() =>
  import('./features/LaunchView.js').then((module) => ({ default: module.LaunchView }))
);

export type ViewName = 'runs' | 'registry' | 'skills' | 'burnin' | 'launch';

function pickerOption(run: RunIndexEntry, t: (key: string) => string): RunPickerOption {
  const title = run.label.replace(/^(?:build-app|baseline):\s*/i, '');
  const live = isIndexEntryLive(run);
  const state = run.cancelled
    ? 'cancelled'
    : run.hasError || run.inFlight && !live
      ? 'error'
      : live
        ? 'live'
        : 'complete';
  const status = run.cancelled
    ? t('runs.flag.cancelled')
    : run.hasError
      ? '✖'
      : live
        ? t('runs.flag.live')
        : run.inFlight
          ? t('runs.flag.abandoned')
          : run.degraded
            ? t('runs.flag.fallback')
            : '';
  const meta =
    `${run.startedAt.slice(0, 19).replace('T', ' ')} · ${run.calls ?? 0} calls · ${fmtCost(run.costUsd)}` +
    (status ? ` · ${status}` : '');
  return {
    id: run.id,
    title,
    meta,
    search: `${run.id} ${run.label} ${title} ${meta}`.toLocaleLowerCase(),
    state,
  };
}

export function App() {
  const { locale, setLocale, t } = useI18n();
  const [view, setView] = useState<ViewName>('runs');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [requestedSkill, setRequestedSkill] = useState<SkillSelection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { runs, loading: runsLoading, refresh: refreshRuns } = useRunsIndex(view === 'runs');
  const pickerOptions = useMemo(
    () => runs.map((run) => pickerOption(run, t)),
    [runs, t]
  );

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
    if (selectedRunId && runs.length > 0 && !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0]!.id);
    }
  }, [runs, selectedRunId]);

  const refresh = () => {
    setRefreshKey((value) => value + 1);
    if (view === 'runs') void refreshRuns();
  };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="sticky" color="transparent" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 1.5, minHeight: 48 }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', whiteSpace: 'nowrap', mr: 2 }}
          >
            <Box
              component="img"
              src="/favicon.svg"
              alt=""
              sx={{
                width: 36,
                height: 36,
                filter: 'drop-shadow(3px 4px 5px rgba(34,211,238,.12))',
              }}
            />
            <Typography variant="h6" sx={{ fontWeight: 750 }}>Atoma</Typography>
          </Stack>
          <Tabs
            value={view}
            onChange={(_event, value: ViewName) => setView(value)}
            variant="scrollable"
            scrollButtons={false}
            sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, minWidth: 64, px: 1.25 } }}
          >
            {(['runs', 'registry', 'skills', 'burnin', 'launch'] as const).map((name) => (
              <Tab key={name} value={name} label={t(`nav.${name}`)} />
            ))}
          </Tabs>
          {view === 'runs' ? (
            <Box sx={{ width: { xs: 280, md: 520 }, minWidth: 220 }}>
              <RunPicker
                options={pickerOptions}
                value={selectedRunId}
                placeholder={t('runs.search', { count: runs.length })}
                emptyLabel={runsLoading ? t('common.loading') : t('runs.none')}
                onChange={setSelectedRunId}
              />
            </Box>
          ) : null}
          <Box sx={{ flex: 1 }} />
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <FormControl size="small">
              <Select
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
                aria-label={t('nav.language')}
                sx={{ minWidth: 92 }}
              >
                {(['en', 'fr'] as const).map((code) => (
                  <MenuItem key={code} value={code}>{I18N_CATALOGS[code]['lang.name']}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title={t('nav.refresh.title')}>
              <IconButton onClick={refresh} aria-label={t('nav.refresh')}>
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Toolbar>
      </AppBar>

      <Suspense fallback={<LoadingPane />}>
        {view === 'runs' ? (
          <RunsView
            runId={selectedRunId}
            active
            refreshKey={refreshKey}
            onOpenSkill={(l1Name, id) => {
              setRequestedSkill({ l1Name, id });
              setView('skills');
            }}
          />
        ) : null}
        {view === 'registry' ? (
          <RegistryView
            refreshKey={refreshKey}
            onOpenSkill={(l1Name, id) => {
              setRequestedSkill({ l1Name, id });
              setView('skills');
            }}
          />
        ) : null}
        {view === 'skills' ? <SkillsView refreshKey={refreshKey} requestedSkill={requestedSkill} /> : null}
        {view === 'burnin' ? (
          <BurninView
            refreshKey={refreshKey}
            onOpenRun={(id) => {
              setSelectedRunId(id);
              setView('runs');
            }}
          />
        ) : null}
        {view === 'launch' ? <LaunchView refreshKey={refreshKey} /> : null}
      </Suspense>
    </Box>
  );
}
