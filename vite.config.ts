import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = Number(process.env['ATOMA_VIZ_API_PORT'] ?? 4111);
const devPort = Number(process.env['ATOMA_VIZ_DEV_PORT'] ?? 5173);
const clientName = process.env['ATOMA_VIZ_UI'] === 'mui' ? 'client' : 'client-gl';

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL(`./src/viz/${clientName}`, import.meta.url)),
  publicDir: fileURLToPath(new URL('./src/viz/public', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/viz/client', import.meta.url)),
    emptyOutDir: true,
    // The default 2D application remains below 500 KB minified. The optional
    // lazy R3F/Three topology chunk is intentionally larger and loads only
    // after first paint.
    chunkSizeWarningLimit: 1100,
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
