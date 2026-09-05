import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
) as { version?: unknown };
if (typeof packageMetadata.version !== 'string' || packageMetadata.version.trim() === '') {
  throw new Error('package.json must declare a non-empty version');
}
export const ATOMA_RELEASE_VERSION = packageMetadata.version;

const apiPort = Number(process.env['ATOMA_VIZ_API_PORT'] ?? 4111);
const devPort = Number(process.env['ATOMA_VIZ_DEV_PORT'] ?? 5173);
const clientName = process.env['ATOMA_VIZ_UI'] === 'mui' ? 'client' : 'client-gl';
// Off unless asked for, and asked for explicitly: a dev service worker's
// scope is the ORIGIN, so it outlives the dev server. See src/viz/client/pwa.ts.
const serviceWorkerInDev = process.env['ATOMA_VIZ_SW_DEV'] === '1';

export default defineConfig({
  plugins: [react()],
  define: {
    __ATOMA_RELEASE_VERSION__: JSON.stringify(ATOMA_RELEASE_VERSION),
    __ATOMA_SW_DEV__: JSON.stringify(serviceWorkerInDev),
  },
  root: fileURLToPath(new URL(`./src/viz/${clientName}`, import.meta.url)),
  publicDir: fileURLToPath(new URL('./src/viz/public', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/viz/client', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    proxy: {
      '/mcp': {
        target: `http://127.0.0.1:${apiPort}`,
        // Local MCP pins the API Host; gated MCP pins the public origin.
        changeOrigin: !['1', 'true'].includes(process.env['ATOMA_VIZ_AUTH'] ?? ''),
      },
      '/api': `http://127.0.0.1:${apiPort}`,
      '/auth': `http://127.0.0.1:${apiPort}`,
      '/webhooks': `http://127.0.0.1:${apiPort}`,
      '/robots.txt': `http://127.0.0.1:${apiPort}`,
      '/sitemap.xml': `http://127.0.0.1:${apiPort}`,
    },
  },
});
