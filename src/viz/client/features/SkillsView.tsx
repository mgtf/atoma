import {
  Alert,
  Box,
  Chip,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../data-api.js';
import { useI18n } from '../i18n.js';
import { CodeBlock, EmptyPane, ErrorPane, LoadingPane, StatCard } from '../shared.js';
import type { SkillNamespace, SkillSummary } from '../types.js';

export interface SkillSelection {
  l1Name: string;
  id: string;
}

function Shareability({ skill }: { skill: SkillSummary }) {
  const { t } = useI18n();
  const assessment = skill.shareability;
  if (!assessment) return null;
  const severity =
    assessment.verdict === 'blocked'
      ? 'error'
      : assessment.verdict === 'review-required'
        ? 'success'
        : 'info';
  return (
    <Alert severity={severity} variant="outlined">
      <Typography sx={{ fontWeight: 700 }}>{t(`skill.share.${assessment.verdict}`)}</Typography>
      {assessment.blockers.map((item) => (
        <Typography key={`${item.code}-${item.detail}`} variant="body2">
          {item.code}: {item.detail}
        </Typography>
      ))}
      {assessment.warnings.map((item) => (
        <Typography key={`${item.code}-${item.detail}`} variant="body2" color="warning.main">
          {item.code}: {item.detail}
        </Typography>
      ))}
      {assessment.humanMustCheck ? (
        <Typography variant="body2" sx={{ mt: 0.75 }}>{assessment.humanMustCheck}</Typography>
      ) : null}
    </Alert>
  );
}

function SkillDetail({ selection }: { selection: SkillSelection | null }) {
  const { t } = useI18n();
  const [skill, setSkill] = useState<SkillSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setSkill(null);
    setError(null);
    if (!selection) return;
    void api.skill(selection.l1Name, selection.id).then(setSkill).catch(setError);
  }, [selection]);
  if (!selection) return <EmptyPane>{t('pane.selectSkill')}</EmptyPane>;
  if (error) return <ErrorPane error={error} />;
  if (!skill) return <LoadingPane />;
  return (
    <Stack spacing={1.5}>
      <Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h6">{skill.id}</Typography>
          <Chip
            size="small"
            label={skill.kind === 'script' ? `${skill.kind}:${skill.language ?? 'node'}` : skill.kind}
            color={skill.kind === 'script' ? 'warning' : 'primary'}
            variant="outlined"
          />
        </Stack>
        <Typography color="text.secondary">{selection.l1Name}</Typography>
      </Box>
      <Divider />
      <Box>
        <Typography variant="subtitle2">{t('skill.description')}</Typography>
        <Typography>{skill.description}</Typography>
      </Box>
      <Box>
        <Typography variant="subtitle2">{t('skill.whenToUse')}</Typography>
        <Typography>{skill.whenToUse}</Typography>
      </Box>
      <Stack direction="row" spacing={1}>
        <StatCard label={t('skills.totalSuccess')} value={skill.successes} accent="#4ade80" />
        <StatCard label={t('skills.totalFailure')} value={skill.failures} accent="#f87171" />
      </Stack>
      <Shareability skill={skill} />
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
          {t(skill.kind === 'script' ? 'skill.body' : 'skill.body.recipe')}
        </Typography>
        <CodeBlock maxHeight={680}>{skill.body || t('common.empty')}</CodeBlock>
      </Box>
    </Stack>
  );
}

export function SkillsView({
  refreshKey,
  requestedSkill,
}: {
  refreshKey: number;
  requestedSkill?: SkillSelection | null;
}) {
  const { t } = useI18n();
  const [namespaces, setNamespaces] = useState<SkillNamespace[]>([]);
  const [skillsByL1, setSkillsByL1] = useState<Record<string, SkillSummary[]>>({});
  const [selection, setSelection] = useState<SkillSelection | null>(requestedSkill ?? null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (requestedSkill) setSelection(requestedSkill);
  }, [requestedSkill]);

  useEffect(() => {
    setLoading(true);
    void api.skillNamespaces()
      .then(async (items) => {
        const pairs = await Promise.all(
          items.map(async (item) => {
            try {
              return [item.l1Name, await api.skills(item.l1Name)] as const;
            } catch {
              return [item.l1Name, []] as const;
            }
          })
        );
        const byL1 = Object.fromEntries(pairs);
        setNamespaces(items);
        setSkillsByL1(byL1);
        setSelection((current) => current ?? (
          pairs[0]?.[1][0] ? { l1Name: pairs[0][0], id: pairs[0][1][0].id } : null
        ));
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const allSkills = useMemo(() => Object.values(skillsByL1).flat(), [skillsByL1]);
  if (loading) return <LoadingPane />;
  if (error) return <Box sx={{ p: 2 }}><ErrorPane error={error} /></Box>;
  if (!namespaces.length) return <EmptyPane>{t('skills.none')}</EmptyPane>;

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(340px, 42%) 1fr' }, minHeight: 'calc(100vh - 49px)' }}>
      <Box sx={{ p: 2, borderRight: { md: 1 }, borderColor: 'divider', overflow: 'auto' }}>
        <Typography variant="h6">{t('nav.skills')}</Typography>
        <Typography color="text.secondary" sx={{ mb: 1.5 }}>{t('skills.subtitle')}</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mb: 1.5 }}>
          <StatCard label={t('skill.namespace')} value={namespaces.length} />
          <StatCard label={t('skill.title')} value={allSkills.length} />
          <StatCard label={t('skill.counters')} value={`✓${allSkills.reduce((sum, skill) => sum + skill.successes, 0)} / ✗${allSkills.reduce((sum, skill) => sum + skill.failures, 0)}`} />
        </Box>
        <TextField
          size="small"
          fullWidth
          placeholder={t('nav.filterSkills')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          sx={{ mb: 1.5 }}
        />
        <Stack spacing={1}>
          {namespaces.map((namespace) => {
            const query = filter.toLocaleLowerCase();
            const matching = (skillsByL1[namespace.l1Name] ?? []).filter((skill) =>
              `${skill.id} ${skill.description} ${skill.whenToUse}`.toLocaleLowerCase().includes(query)
            );
            if (query && !matching.length) return null;
            return (
              <Paper key={namespace.l1Name} sx={{ p: 1.25 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  {namespace.l1Name} ({matching.length}{matching.length !== namespace.count ? `/${namespace.count}` : ''})
                </Typography>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {matching.map((skill) => (
                    <Chip
                      key={skill.id}
                      label={`${skill.id}${skill.successes + skill.failures ? ` · ✓${skill.successes}/✗${skill.failures}` : ''}`}
                      color={selection?.l1Name === namespace.l1Name && selection.id === skill.id ? 'primary' : 'default'}
                      variant={selection?.l1Name === namespace.l1Name && selection.id === skill.id ? 'filled' : 'outlined'}
                      onClick={() => setSelection({ l1Name: namespace.l1Name, id: skill.id })}
                      title={`${skill.kind}${skill.language ? `:${skill.language}` : ''}\n${skill.description}\n${skill.whenToUse}`}
                    />
                  ))}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Box>
      <Box sx={{ p: 2, minWidth: 0 }}>
        <SkillDetail selection={selection} />
      </Box>
    </Box>
  );
}
