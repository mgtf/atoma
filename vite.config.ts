import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = Number(process.env['ATOMA_VIZ_API_PORT'] ?? 4111);
const devPort = Number(process.env['ATOMA_VIZ_DEV_PORT'] ?? 5173);

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./src/viz/client', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/viz/client', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 750,
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
