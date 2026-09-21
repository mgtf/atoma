import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStack } from '../docker/stack-contract.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--env-file') {
  console.error('Usage: npm run stack:check -- --env-file /absolute/stack.env');
  process.exitCode = 2;
} else {
  try {
    const compose = fileURLToPath(new URL('../deploy/compose.yaml', import.meta.url));
    const raw = execFileSync('docker', ['compose', '--env-file', args[1], '-f', compose, 'config', '--format', 'json'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    validateStack(JSON.parse(raw));
    console.log('Stack configuration and image digest references are valid. No containers were started.');
  } catch (error) {
    // Docker diagnostics can include the rendered environment. Never echo them.
    console.error(error?.status !== undefined ? 'Compose configuration failed; check required variables and file paths.' : error.message);
    process.exitCode = 1;
  }
}
