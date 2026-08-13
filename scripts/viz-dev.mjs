import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const detached = process.platform !== 'win32';
const apiPort = process.env['ATOMA_VIZ_API_PORT'] ?? '4111';
const devPort = process.env['ATOMA_VIZ_DEV_PORT'] ?? '5173';
const uiFlag = process.argv.indexOf('--ui');
const ui = (
  uiFlag >= 0 ? process.argv[uiFlag + 1] : process.env['ATOMA_VIZ_UI']
) === 'mui' ? 'mui' : 'gpu';
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const devUiUrl = `http://127.0.0.1:${devPort}`;
const children = [
  spawn(
    process.execPath,
    ['--import', 'tsx', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', apiPort],
    {
      stdio: 'inherit',
      detached,
      env: { ...process.env, ATOMA_VIZ_DEV_URL: devUiUrl },
    }
  ),
  spawn(process.execPath, [viteCli, '--config', 'vite.config.ts'], {
    stdio: 'inherit',
    detached,
    env: { ...process.env, ATOMA_VIZ_UI: ui },
  }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (detached) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      // A child that already exited needs no cleanup.
    }
  }
  setTimeout(() => process.exit(code), 100).unref();
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(`[viz:dev] failed to start: ${error.message}`);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[viz:dev] child exited (${signal ?? code ?? 'unknown'})`);
      stop(code ?? 1);
    }
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
process.once('exit', () => {
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (detached) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // Best effort on hard exit.
    }
  }
});

console.log(
  `Atoma viz dev — ${ui.toUpperCase()} UI ${devUiUrl} · API http://127.0.0.1:${apiPort} (root redirects to UI)`
);
