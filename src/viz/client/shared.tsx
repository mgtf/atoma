import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import { tierColors } from './theme.js';

export function LoadingPane() {
  return (
    <Stack sx={{ minHeight: 160, alignItems: 'center', justifyContent: 'center' }}>
      <CircularProgress size={24} />
    </Stack>
  );
}

export function EmptyPane({ children }: { children: ReactNode }) {
  return (
    <Typography color="text.secondary" align="center" sx={{ py: 5 }}>
      {children}
    </Typography>
  );
}

export function ErrorPane({ error }: { error: unknown }) {
  return <Alert severity="error">{error instanceof Error ? error.message : String(error)}</Alert>;
}

export function StatCard({
  label,
  value,
  accent,
}: {
  label: ReactNode;
  value: ReactNode;
  accent?: string;
}) {
  return (
    <Paper sx={{ p: 1.25, borderLeft: accent ? `3px solid ${accent}` : undefined }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ mt: 0.25 }}>
        {value}
      </Typography>
    </Paper>
  );
}

export function TierChip({ tier, label }: { tier?: number; label?: string }) {
  const color = tierColors[tier as 1 | 2 | 3] ?? '#8a96ae';
  return (
    <Chip
      size="small"
      label={label ?? (tier ? `L${tier}` : '?')}
      sx={{ color, borderColor: color, bgcolor: `${color}18` }}
      variant="outlined"
    />
  );
}

export function HelpChip({
  label,
  help,
  color = 'default',
}: {
  label: ReactNode;
  help: string;
  color?: 'default' | 'primary' | 'success' | 'warning' | 'error';
}) {
  return (
    <Tooltip title={help} arrow>
      <Chip size="small" label={label} color={color} variant="outlined" />
    </Tooltip>
  );
}

export function CodeBlock({ children, maxHeight = 520 }: { children: ReactNode; maxHeight?: number }) {
  return (
    <Box
      component="pre"
      sx={{
        p: 1.5,
        maxHeight,
        overflow: 'auto',
        borderRadius: 1,
        bgcolor: '#0f1523',
        border: '1px solid',
        borderColor: 'divider',
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      {children}
    </Box>
  );
}
