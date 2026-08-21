import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = process.argv[2] === 'mui' ? 'mui' : 'gpu';
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const result = spawnSync(
  process.execPath,
  [viteCli, 'build', '--config', 'vite.config.ts'],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'production', ATOMA_VIZ_UI: ui },
    stdio: 'inherit',
  }
);

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

// LAZY-CHUNK GUARD. The GPU renderer must stay OUT of the entry chunk: one
// innocuous value-import from gpu-renderer.js in GpuApp silently merges the
// chunks, and that regression already shipped once (fixed by ffe6180 —
// metrics moved to renderer/metrics.ts so GpuSurface keeps `import type`
// only). `mark-shell-front` is a mesh label that exists only in renderer
// code, so it discriminates the chunks even after minification.
if (ui === 'gpu') {
  const assets = fileURLToPath(new URL('../dist/viz/client/assets', import.meta.url));
  const names = readdirSync(assets).filter((name) => name.endsWith('.js'));
  const entry = names.filter((name) => name.startsWith('index-'));
  const renderer = names.filter((name) => name.startsWith('gpu-renderer-'));
  if (entry.length !== 1 || renderer.length !== 1) {
    console.error(`viz build: expected one index-*.js and one gpu-renderer-*.js chunk, got ${names.join(', ')}`);
    process.exit(1);
  }
  const marker = 'mark-shell-front';
  if (readFileSync(join(assets, entry[0]), 'utf8').includes(marker)) {
    console.error('viz build: the GPU renderer leaked into the entry chunk — a value import from gpu-renderer.js re-merged the lazy chunk');
    process.exit(1);
  }
  if (!readFileSync(join(assets, renderer[0]), 'utf8').includes(marker)) {
    console.error('viz build: the lazy-chunk marker moved; update the guard in scripts/viz-build.mjs');
    process.exit(1);
  }
}
process.exit(0);
