import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerLauncher, launcherObjectId } from '../src/launcher/docker.js';
import { startPreview, teardownPreview } from '../src/preview/runtime.js';

/**
 * THE PREVIEW ISOLATION, PROVEN AGAINST A REAL SANDBOX.
 *
 * Everything else about the preview runtime is asserted at the command level:
 * what the launcher would tell the engine to do. That is the right test for a
 * flag, and it is not a test of the boundary. This file drives the real thing
 * — a real gVisor container, a real relay, real HTTP — because the claim under
 * test is a property of the runtime, not of our argv.
 *
 * WHY IT NEEDS gVisor SPECIFICALLY. A preview runs a tenant's model-authored
 * application in a member's browser session; `runsc` is what the design
 * requires in production and what it forbids falling back from silently. A
 * green run under `runc` would prove the plumbing and none of the promise, so
 * this skips rather than degrade.
 *
 * SKIPPED (not failed) when Docker, the image or runsc are missing, so a
 * contributor without them still gets a green suite. `CI_REQUIRE_PREVIEW_RUNTIME=1`
 * turns absence into a hard failure, which is what the CI job sets.
 */

const IMAGE = 'atoma-worker:latest';

function have(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runtimeAvailable(): boolean {
  try {
    const runtimes = execFileSync('docker', ['info', '--format', '{{json .Runtimes}}'], {
      encoding: 'utf8',
    });
    return runtimes.includes('"runsc"');
  } catch {
    return false;
  }
}

const READY =
  have('docker', ['image', 'inspect', IMAGE]) && runtimeAvailable();

if (process.env['CI_REQUIRE_PREVIEW_RUNTIME'] === '1' && !READY) {
  throw new Error(
    'the preview isolation job requires Docker, a built atoma-worker:latest and a registered runsc runtime'
  );
}
const describeRunsc = READY ? describe : describe.skip;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A deliverable of the commonest shape: one Node file honouring PORT. */
function deliverable(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-preview-iso-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'server.js'),
    [
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      'const server = http.createServer((req, res) => {',
      "  if (req.url === '/write-state') {",
      "    fs.writeFileSync(process.env.ATOMA_DATA_DIR + '/state.txt', 'kept');",
      "    res.end('wrote');",
      '    return;',
      '  }',
      "  if (req.url === '/read-state') {",
      '    try {',
      "      res.end(fs.readFileSync(process.env.ATOMA_DATA_DIR + '/state.txt', 'utf8'));",
      '    } catch {',
      "      res.end('absent');",
      '    }',
      '    return;',
      '  }',
      "  if (req.url === '/write-workspace') {",
      "    try { fs.writeFileSync('/workspace/written-by-the-app.txt', 'x'); res.end('wrote'); }",
      "    catch (e) { res.end('refused'); }",
      '    return;',
      '  }',
      "  res.end('served by the preview');",
      '});',
      "server.listen(Number(process.env.PORT), '0.0.0.0', () => {",
      "  console.log('LISTENING_ON_PORT=' + server.address().port);",
      '});',
    ].join('\n')
  );
  writeFileSync(join(workspace, '.env'), 'SECRET=must-not-be-copied');
  return workspace;
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function probe(hostPort: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const reply = await get(hostPort, '/');
      if (reply.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function inspect(name: string, format: string): string {
  return execFileSync('docker', ['inspect', '--format', format, name], {
    encoding: 'utf8',
  }).trim();
}

describeRunsc('preview isolation, against a real gVisor sandbox', () => {
  it('runs the application under runsc and serves it only through the relay', async () => {
    const workspace = deliverable();
    const launcher = new DockerLauncher({
      image: IMAGE,
      // In CI the worker image stands in for the pinned preview image: what is
      // under test is the RUNTIME and the flags, not the image's contents.
      previewImage: IMAGE,
      previewRuntime: 'runsc',
      workspaceRoot: join(tmpdir(), 'atoma-preview-iso-copies'),
    });
    const ownerId = `iso-${process.pid}`;
    const created: Parameters<typeof teardownPreview>[2] = {};

    try {
      const running = await startPreview(
        { launcher, imageDigest: null, runtime: 'runsc', probe, log: () => undefined },
        { ownerId, sourceWorkspace: workspace, entry: 'server.js' }
      );

      const appName = launcher.unitName('preview-app', ownerId);
      const relayName = launcher.unitName('preview-ingress', ownerId);
      created.app = { kind: 'preview-app', ownerId, name: appName };
      created.relay = { kind: 'preview-ingress', ownerId, name: relayName };
      created.network = {
        family: 'preview',
        kind: 'internal',
        ownerId,
        name: launcher.networkName({ family: 'preview', kind: 'internal', ownerId }),
      };
      created.workspace = { ownerId, id: launcherObjectId(ownerId) };

      // THE RUNTIME, READ FROM THE HOST. Never a claim from inside the
      // container: a sandbox that could report its own runtime could lie
      // about it, and this is the one fact the whole feature rests on.
      expect(inspect(appName, '{{.HostConfig.Runtime}}')).toBe('runsc');

      // The application answers, through the relay, on loopback.
      const served = await get(running.hostPort, '/');
      expect(served.body).toBe('served by the preview');

      // THE APP ITSELF IS NOT PUBLISHED. The relay is the only way in.
      expect(inspect(appName, '{{json .NetworkSettings.Ports}}')).toBe('{}');

      // The envelope the profile imposes.
      expect(inspect(appName, '{{.HostConfig.ReadonlyRootfs}}')).toBe('true');
      expect(inspect(appName, '{{.Config.User}}')).not.toBe('');
      expect(inspect(appName, '{{.Config.User}}')).not.toBe('root');
      expect(inspect(appName, '{{json .HostConfig.CapDrop}}')).toContain('ALL');
      expect(inspect(appName, '{{.HostConfig.Memory}}')).toBe(
        inspect(appName, '{{.HostConfig.MemorySwap}}')
      );

      // ONLY the workspace copy is mounted, and it is not the delivered one.
      const mounts = inspect(appName, '{{json .Mounts}}');
      expect(mounts).toContain('/workspace');
      expect(mounts).not.toContain(workspace);

      // No credential and no control-plane path crossed the boundary.
      const env = inspect(appName, '{{json .Config.Env}}');
      for (const forbidden of ['ANTHROPIC', 'ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR', 'GITHUB']) {
        expect(env).not.toContain(forbidden);
      }

      // `/data` is writable, and the SECRET was never copied.
      expect((await get(running.hostPort, '/write-state')).body).toBe('wrote');
      expect((await get(running.hostPort, '/read-state')).body).toBe('kept');
      const copied = inspect(appName, '{{json .Mounts}}');
      expect(copied).not.toContain('.env');
    } finally {
      await teardownPreview({ launcher, log: () => undefined }, ownerId, created);
    }

    // THE DELIVERED WORKSPACE IS UNTOUCHED: it is the deliverable and the seed
    // of the next run.
    expect(readFileSync(join(workspace, 'server.js'), 'utf8')).toContain('LISTENING_ON_PORT');
    expect(() => readFileSync(join(workspace, 'written-by-the-app.txt'))).toThrow();

    // And nothing labelled survives the teardown.
    const survivors = execFileSync(
      'docker',
      ['ps', '-a', '--filter', 'label=dev.atoma.owner=preview', '--format', '{{.Names}}'],
      { encoding: 'utf8' }
    ).trim();
    expect(survivors).toBe('');
  }, 180_000);

  it('refuses to expose an application that never honours the port it was given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-preview-iso-bad-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    // Binds a port of its own choosing, and never emits the marker for 8080.
    writeFileSync(
      join(workspace, 'server.js'),
      "require('node:http').createServer((_q, s) => s.end('x')).listen(9999);"
    );

    const launcher = new DockerLauncher({
      image: IMAGE,
      previewImage: IMAGE,
      previewRuntime: 'runsc',
      workspaceRoot: join(tmpdir(), 'atoma-preview-iso-copies'),
    });
    const ownerId = `iso-bad-${process.pid}`;

    await expect(
      startPreview(
        {
          launcher,
          imageDigest: null,
          runtime: 'runsc',
          probe: async () => true,
          readyTimeoutMs: 15_000,
          log: () => undefined,
        },
        { ownerId, sourceWorkspace: workspace, entry: 'server.js' }
      )
    ).rejects.toMatchObject({ code: 'readiness-timeout' });

    // A refused start leaves nothing behind.
    const survivors = execFileSync(
      'docker',
      ['ps', '-a', '--filter', 'label=dev.atoma.owner=preview', '--format', '{{.Names}}'],
      { encoding: 'utf8' }
    ).trim();
    expect(survivors).toBe('');
  }, 180_000);
});
