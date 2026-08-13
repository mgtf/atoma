import { spawnSync } from 'node:child_process';
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
process.exit(result.status ?? 1);
