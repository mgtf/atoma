import { createTheme } from '@mui/material/styles';

export const tierColors = {
  1: '#2dd4bf',
  2: '#fbbf24',
  3: '#c084fc',
} as const;

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#6ea8ff' },
    success: { main: '#4ade80' },
    error: { main: '#f87171' },
    warning: { main: '#fbbf24' },
    background: {
      default: '#0b0f17',
      paper: '#121826',
    },
    divider: '#1f2a3d',
    text: {
      primary: '#e6edf7',
      secondary: '#8a96ae',
    },
  },
  typography: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif",
    fontSize: 13,
    h6: { fontSize: '0.95rem', fontWeight: 700 },
    subtitle2: { fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '.06em' },
    body2: { fontSize: '0.78rem' },
    caption: { fontSize: '0.68rem' },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { height: '100%' },
        body: { minHeight: '100%', margin: 0 },
        '#root': { minHeight: '100vh' },
        pre: {
          margin: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #1f2a3d',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontSize: '0.68rem' },
      },
    },
  },
});
