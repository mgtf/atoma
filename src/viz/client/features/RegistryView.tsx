import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../data-api.js';
import { useI18n } from '../i18n.js';
import { CodeBlock, EmptyPane, ErrorPane, LoadingPane, StatCard, TierChip } from '../shared.js';
import type { RegistrySummary, RegistryType, SkillSummary } from '../types.js';
import { elementForTool } from '../../../contracts/toolTaxonomy.js';
import { taxonomyForTier } from '../../../core/taxonomy.js';

function AtomDetail({
  atom,
  onOpenSkill,
}: {
  atom: RegistryType | null;
  onOpenSkill: (l1Name: string, id: string) => void;
}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    setSkills([]);
    if (atom?.tier === 1) void api.skills(atom.name).then(setSkills).catch(() => setSkills([]));
  }, [atom]);
  if (!atom) return <EmptyPane>{t('pane.selectAtom')}</EmptyPane>;
  return (
    <Stack spacing={1.5}>
      <Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h6">{atom.name}</Typography>
          <TierChip tier={atom.tier} />
          <Chip
            size="small"
            label={t(
              `rank.${atom.rank ?? taxonomyForTier(atom.tier as 1 | 2 | 3).rank}`
            )}
            variant="outlined"
          />
          <Chip size="small" label={`v${atom.version}`} variant="outlined" />
        </Stack>
        <Typography color="text.secondary">{atom.description}</Typography>
      </Box>
      <Divider />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <StatCard label={t('registry.successes')} value={atom.successes} accent="#4ade80" />
        <StatCard label={t('registry.failures')} value={atom.failures} accent="#f87171" />
        <StatCard label={t('registry.createdBy')} value={atom.createdBy} />
      </Stack>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('common.tools')}</Typography>
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {atom.tools.map((tool) => {
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
          {!atom.tools.length ? <Typography color="text.secondary">{t('common.none')}</Typography> : null}
        </Stack>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('common.params')}</Typography>
        <CodeBlock>{JSON.stringify(atom.params, null, 2)}</CodeBlock>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('common.systemPrompt')}</Typography>
        <CodeBlock maxHeight={580}>{atom.systemPrompt}</CodeBlock>
      </Box>
      {atom.history?.length ? (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
            {t('registry.versionHistory', { count: atom.history.length })}
          </Typography>
          {[...atom.history].reverse().map((entry) => (
            <Accordion key={entry.version} disableGutters>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Chip size="small" label={`v${entry.version}`} />
                  <Typography variant="body2">{entry.modifiedBy} · {entry.modifiedAt}</Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                {entry.reason ? <Alert severity="info" sx={{ mb: 1 }}>{entry.reason}</Alert> : null}
                <CodeBlock>{entry.systemPrompt}</CodeBlock>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      ) : null}
      {atom.tier === 1 ? (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('registry.attachedSkills')}</Typography>
          {skills.length ? (
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {skills.map((skill) => (
                <Chip key={skill.id} label={skill.id} onClick={() => onOpenSkill(atom.name, skill.id)} />
              ))}
            </Stack>
          ) : (
            <Typography color="text.secondary">{t('registry.noSkillsForAtom')}</Typography>
          )}
        </Box>
      ) : null}
    </Stack>
  );
}

export function RegistryView({
  refreshKey,
  onOpenSkill,
}: {
  refreshKey: number;
  onOpenSkill: (l1Name: string, id: string) => void;
}) {
  const { t } = useI18n();
  const [registries, setRegistries] = useState<RegistrySummary[]>([]);
  const [selectedRegistry, setSelectedRegistry] = useState('');
  const [payload, setPayload] = useState<{ registry: RegistrySummary; types: RegistryType[] } | null>(null);
  const [selectedAtom, setSelectedAtom] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setLoading(true);
    void api.registries()
      .then((items) => {
        setRegistries(items);
        const next = items.find((item) => item.exists)?.id ?? items[0]?.id ?? '';
        setSelectedRegistry((value) => items.some((item) => item.id === value) ? value : next);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  useEffect(() => {
    setPayload(null);
    setSelectedAtom(null);
    if (!selectedRegistry) return;
    void api.registry(selectedRegistry)
      .then((next) => {
        setPayload(next);
        setSelectedAtom(next.types[0]?.name ?? null);
        setError(null);
      })
      .catch(setError);
  }, [selectedRegistry, refreshKey]);

  const filtered = useMemo(() => {
    const query = filter.toLocaleLowerCase();
    return (payload?.types ?? []).filter((atom) =>
      `${atom.name} ${atom.description} ${atom.systemPrompt}`.toLocaleLowerCase().includes(query)
    );
  }, [filter, payload]);
  const atom = payload?.types.find((item) => item.name === selectedAtom) ?? null;

  if (loading) return <LoadingPane />;
  if (error) return <Box sx={{ p: 2 }}><ErrorPane error={error} /></Box>;
  if (!registries.length) return <EmptyPane>{t('registry.none')}</EmptyPane>;

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(360px, 44%) 1fr' }, minHeight: 'calc(100vh - 49px)' }}>
      <Box sx={{ p: 2, borderRight: { md: 1 }, borderColor: 'divider', overflow: 'auto' }}>
        <Stack spacing={1.25}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <FormControl size="small" fullWidth>
              <InputLabel>{t('nav.selectRegistry')}</InputLabel>
              <Select
                value={selectedRegistry}
                label={t('nav.selectRegistry')}
                onChange={(event) => setSelectedRegistry(event.target.value)}
              >
                {registries.map((registry) => (
                  <MenuItem key={registry.id} value={registry.id}>
                    {registry.label} · {registry.counts.total}{registry.exists ? '' : ` · ${t('registry.missing')}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              size="small"
              placeholder={t('nav.filterAtoms')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              fullWidth
            />
          </Stack>
          {payload ? (
            <>
              <Box>
                <Typography variant="h6">{payload.registry.label}</Typography>
                <Typography variant="caption" color="text.secondary">{payload.registry.path}</Typography>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1 }}>
                {[3, 2, 1].map((tier) => (
                  <StatCard key={tier} label={t(`lanes.l${tier}`)} value={payload.registry.counts[tier as 1 | 2 | 3]} />
                ))}
                <StatCard
                  label={t('registry.successFailure')}
                  value={`✓${payload.types.reduce((sum, item) => sum + item.successes, 0)} / ✗${payload.types.reduce((sum, item) => sum + item.failures, 0)}`}
                />
              </Box>
              {[3, 2, 1].map((tier) => {
                const atoms = filtered.filter((item) => item.tier === tier).sort((a, b) => a.ordinal - b.ordinal);
                return (
                  <Paper key={tier} sx={{ p: 1.25, borderLeft: `3px solid ${tier === 3 ? '#c084fc' : tier === 2 ? '#fbbf24' : '#2dd4bf'}` }}>
                    <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t(`lanes.l${tier}`)}</Typography>
                    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {atoms.map((item) => (
                        <Chip
                          key={item.name}
                          label={item.name}
                          title={`v${item.version} · ✓${item.successes}/✗${item.failures}`}
                          color={selectedAtom === item.name ? 'primary' : 'default'}
                          variant={selectedAtom === item.name ? 'filled' : 'outlined'}
                          onClick={() => setSelectedAtom(item.name)}
                        />
                      ))}
                      {!atoms.length ? <Typography color="text.secondary">{filter ? t('registry.noAtomMatch') : t('common.none')}</Typography> : null}
                    </Stack>
                  </Paper>
                );
              })}
            </>
          ) : <LoadingPane />}
        </Stack>
      </Box>
      <Box sx={{ p: 2, minWidth: 0 }}>
        <AtomDetail atom={atom} onOpenSkill={onOpenSkill} />
      </Box>
    </Box>
  );
}
