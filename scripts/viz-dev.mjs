import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const detached = process.platform !== 'win32';
const apiPort = process.env['ATOMA_VIZ_API_PORT'] ?? '4111';
const devPort = process.env['ATOMA_VIZ_DEV_PORT'] ?? '5173';
const children = [
  spawn(
    npm,
    ['exec', 'tsx', '--', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', apiPort],
    { stdio: 'inherit', detached }
  ),
  spawn(npm, ['exec', 'vite', '--', '--config', 'vite.config.ts'], {
    stdio: 'inherit',
    detached,
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
  `atoma viz dev — UI http://127.0.0.1:${devPort} · API http://127.0.0.1:${apiPort}`
);
