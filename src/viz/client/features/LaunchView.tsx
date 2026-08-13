import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  Alert,
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../data-api.js';
import { useI18n } from '../i18n.js';
import { launchCommand } from '../launch-utils.js';
import { CodeBlock, ErrorPane, LoadingPane } from '../shared.js';
import type { LaunchProfile } from '../types.js';

export function LaunchView({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [selected, setSelected] = useState('');
  const [goal, setGoal] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setLoading(true);
    void api.profiles()
      .then((payload) => {
        setProfiles(payload.profiles);
        setSelected((value) => value || payload.profiles[0]?.id || '');
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const profile = profiles.find((item) => item.id === selected);
  const command = useMemo(() => launchCommand(profile, goal), [goal, profile]);
  if (loading) return <LoadingPane />;
  if (error) return <Box sx={{ p: 2 }}><ErrorPane error={error} /></Box>;

  return (
    <Box sx={{ p: 2, maxWidth: 960, mx: 'auto' }}>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6">{t('nav.launch')}</Typography>
            <Typography color="text.secondary">{t('launch.help')}</Typography>
          </Box>
          <Alert severity="info">{t('pane.selectLaunch')}</Alert>
          <FormControl fullWidth size="small">
            <InputLabel>{t('launch.family')}</InputLabel>
            <Select
              label={t('launch.family')}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {profiles.map((item) => (
                <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          {profile ? (
            <>
              <Typography color="text.secondary">
                {t(`launch.help.${profile.id}`) === `launch.help.${profile.id}`
                  ? profile.help
                  : t(`launch.help.${profile.id}`)}
              </Typography>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('launch.examples')}</Typography>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {profile.examples.map((example) => (
                    <Button key={example} size="small" variant="outlined" onClick={() => setGoal(example)}>
                      {example}
                    </Button>
                  ))}
                </Stack>
              </Box>
            </>
          ) : null}
          <TextField
            label={t('launch.goal')}
            placeholder={t('launch.goal.placeholder')}
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value);
              setCopied(false);
            }}
            multiline
            minRows={4}
          />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('launch.command')}</Typography>
            <CodeBlock>{command || t('launch.empty')}</CodeBlock>
          </Box>
          <Button
            variant="contained"
            startIcon={<ContentCopyIcon />}
            disabled={!command}
            onClick={() => {
              void navigator.clipboard.writeText(command).then(() => setCopied(true));
            }}
            sx={{ alignSelf: 'flex-start' }}
          >
            {copied ? t('launch.copied') : t('launch.copy')}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
