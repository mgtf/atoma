import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GpuApp } from './GpuApp.js';
import { GpuErrorBoundary } from './GpuErrorBoundary.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <GpuErrorBoundary>
        <GpuApp />
      </GpuErrorBoundary>
    </QueryClientProvider>
  </StrictMode>
);
