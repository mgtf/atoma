import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
      env: { ...process.env, ATOMA_VIZ_DEV_URL: devUiUrl },
    }
  ),
  spawn(process.execPath, [viteCli, '--config', 'vite.config.ts'], {
    stdio: 'inherit',
    env: { ...process.env, ATOMA_VIZ_UI: ui },
  }),
];

// The children deliberately stay in this process group. Detaching them looks
// tidier, but `npm run` SIGKILLs this script on Ctrl-C — no handler runs, no
// backstop fires — so a detached child's only exit path dies with its parent
// and it is orphaned holding its port. Sharing the group lets the terminal
// signal every process itself. stop() covers the non-terminal paths.
let stopping = false;

// A child killed by a signal keeps exitCode null and reports signalCode, so the
// naive liveness test would keep signalling a pid the OS may have recycled.
function isRunning(child) {
  return Boolean(child.pid) && child.exitCode === null && child.signalCode === null;
}

function signalChild(child, signal) {
  if (!isRunning(child)) return;
  try {
    child.kill(signal);
  } catch {
    // A child that already exited needs no cleanup.
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) signalChild(child, 'SIGTERM');
  // Wait for the children to actually go rather than exiting on a fixed delay,
  // then escalate. This path only runs when this process survives to run it.
  const escalate = setTimeout(() => {
    for (const child of children) signalChild(child, 'SIGKILL');
    setTimeout(() => process.exit(code), 50).unref();
  }, 2000);
  const settle = () => {
    if (children.some(isRunning)) return;
    clearTimeout(escalate);
    process.exit(code);
  };
  for (const child of children) child.once('exit', settle);
  settle();
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
process.once('SIGHUP', () => stop(0));
process.once('exit', () => {
  for (const child of children) signalChild(child, 'SIGKILL');
});

console.log(
  `Atoma viz dev — ${ui.toUpperCase()} UI ${devUiUrl} · API http://127.0.0.1:${apiPort} (root redirects to UI)`
);
