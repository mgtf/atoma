import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerToolBackend } from '../dist/run/toolBackend.js';

const workspace = mkdtempSync(join(tmpdir(), 'atoma-release-egress-'));
let backend;

try {
  backend = await containerToolBackend({
    workspaceRoot: workspace,
    egress: true,
    runId: `release-egress-${process.pid}`,
  });

  const allowed = await backend.executor.execute('fetch_url', {
    url: 'https://registry.npmjs.org/left-pad',
    timeout_ms: 10_000,
  });
  if (!allowed?.ok || allowed.status !== 200) {
    throw new Error(`allowlisted egress failed: ${JSON.stringify(allowed)}`);
  }

  const denied = await backend.executor.execute('fetch_url', {
    url: 'http://host.docker.internal:4111/',
    timeout_ms: 3_000,
  });
  if (denied?.ok) {
    throw new Error(`control plane was reachable: ${JSON.stringify(denied)}`);
  }

  process.stdout.write('release container smoke: external=200 control-plane=blocked\n');
} finally {
  await backend?.cleanup();
  rmSync(workspace, { recursive: true, force: true });
}
