import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContainerToolExecutor, workerRunArgs } from '../src/tools/containerExecutor.js';
import { containerToolBackend } from '../src/run/toolBackend.js';
import { drainLines, encodeMessage, isWorkerHello } from '../src/tools/containerProtocol.js';

/**
 * The isolation primitive, proven against a real container.
 *
 * `run_shell`'s child is spawned with `cwd` and nothing more, so in a single
 * process the atom registry, every skill body and the ledger are one
 * filesystem walk from model-authored code — reproduced earlier as
 * `ls ../../atoma.db ../../skills` listing all of them. Moving the tool
 * layer into a container with only the workspace mounted and no route out is
 * what makes that walk find nothing.
 *
 * These tests DRIVE THE REAL THING: a built image, a real `docker run`, real
 * tool calls over the stdio protocol. A mocked version would prove nothing —
 * the claim under test is a property of the container, not of our code.
 *
 * Skipped (not failed) when Docker or the image is missing: a contributor
 * without Docker still gets a green suite, and CI gets the guarantee.
 */

function dockerReady(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'atoma-worker:latest'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerReady();
if (process.env['CI_REQUIRE_DOCKER'] === '1' && !HAVE_DOCKER) {
  throw new Error('CI worker job requires Docker and a freshly built atoma-worker:latest image');
}
const describeDocker = HAVE_DOCKER ? describe : describe.skip;

describe('workerRunArgs — the isolation is in the flags, so assert them', () => {
  const args = workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws' });

  it('gives the container no route out', () => {
    // The network half of invariant T1. Loopback survives (verified live), so
    // start_node_server + fetch_url still work against the run's own server.
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });

  it('mounts the workspace and nothing else', () => {
    const mounts = args.filter((a, i) => args[i - 1] === '-v');
    expect(mounts).toEqual(['/host/ws:/workspace']);
  });

  it('drops capabilities and forbids regaining privilege', () => {
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('can match the non-root host uid so the bind mount stays writable', () => {
    const a = workerRunArgs({
      image: 'img',
      workspaceHostPath: '/host/ws',
      user: '1001:1001',
    });
    expect(a[a.indexOf('--user') + 1]).toBe('1001:1001');
    expect(a).toContain('HOME=/tmp/atoma-home');
    expect(a).not.toContain('0:0');
  });

  it('bounds memory and cpu', () => {
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
  });

  it('EGRESS MODE swaps none for the internal network and points HTTP_PROXY at the one peer', () => {
    const a = workerRunArgs({
      image: 'img',
      workspaceHostPath: '/host/ws',
      egress: { network: 'atoma-run-net', proxyHost: 'atoma-proxy', proxyPort: 3128 },
    });
    expect(a[a.indexOf('--network') + 1]).toBe('atoma-run-net');
    const env = a.filter((_x, i) => a[i - 1] === '-e');
    expect(env).toContain('HTTP_PROXY=http://atoma-proxy:3128');
    expect(env).toContain('npm_config_https_proxy=http://atoma-proxy:3128');
    expect(env).toContain('NO_PROXY=127.0.0.1,localhost,::1');
    expect(env).toContain('no_proxy=127.0.0.1,localhost,::1');
    expect(env).toContain('NODE_USE_ENV_PROXY=1');
    // Still only the workspace, still no capabilities: egress widens the
    // network and nothing else.
    expect(a.filter((_x, i) => a[i - 1] === '-v')).toEqual(['/host/ws:/workspace']);
    expect(a[a.indexOf('--cap-drop') + 1]).toBe('ALL');
  });

  it('egress mode is OPT-IN — the default is still no network at all', () => {
    const a = workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws' });
    expect(a[a.indexOf('--network') + 1]).toBe('none');
    expect(a.join(' ')).not.toContain('HTTP_PROXY');
  });

  it('never passes --privileged or mounts the docker socket', () => {
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('docker.sock');
  });
});

describe('drainLines — a tool result can span chunks', () => {
  it('reassembles across arbitrary chunk boundaries', () => {
    const whole = encodeMessage({ id: 1, ok: true, result: { a: 'x'.repeat(50) } });
    let buf = '';
    const got: unknown[] = [];
    for (const ch of whole.match(/[\s\S]{1,7}/g) ?? []) {
      buf += ch;
      const { messages, rest } = drainLines(buf);
      buf = rest;
      got.push(...messages);
    }
    expect(got).toHaveLength(1);
    expect((got[0] as { result: { a: string } }).result.a).toHaveLength(50);
  });

  it('drops a non-JSON line instead of throwing', () => {
    const { messages } = drainLines('garbage from some dependency\n{"id":2,"ok":true}\n');
    expect(messages).toHaveLength(1);
    expect(isWorkerHello(messages[0])).toBe(false);
  });
});

describeDocker('a containerised run cannot reach the stores', () => {
  let dir: string;
  let workspace: string;
  let exec: ContainerToolExecutor;

  beforeAll(async () => {
    // Mimic the real layout: a workspace with the stores as SIBLINGS, i.e.
    // exactly the shape that leaks in-process.
    dir = mkdtempSync(join(tmpdir(), 'atoma-container-'));
    workspace = join(dir, 'ws');
    writeFileSync(join(dir, 'atoma.db'), 'TENANT_REGISTRY_SECRET');
    writeFileSync(join(dir, 'atoma-ledger.jsonl'), 'TENANT_LEDGER_SECRET');
    mkdirSync(join(dir, 'skills', 'Helium'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'Helium', 'SKILL.md'), 'TENANT_SKILL_SECRET');
    mkdirSync(workspace, { recursive: true });
    exec = new ContainerToolExecutor({ workspaceHostPath: workspace, startTimeoutMs: 90_000 });
    await exec.start();
  }, 120_000);

  afterAll(() => {
    exec?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('announces its tools', () => {
    const names = exec.toolDeclarations().map((t) => t.name);
    expect(names).toContain('write_file');
    expect(names).toContain('run_shell');
    expect(exec.has('read_file')).toBe(true);
    expect(exec.has('no_such_tool')).toBe(false);
  });

  it('does real work inside the workspace', async () => {
    await exec.execute('write_file', { path: 'hello.txt', content: 'from the container' });
    const read = (await exec.execute('read_file', { path: 'hello.txt' })) as { content?: string };
    expect(read.content).toContain('from the container');
    // …and it landed on the HOST, through the mount.
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toContain('from the container');
  }, 60_000);

  it('records probe output through the worker contract at runtime', async () => {
    await exec.execute('write_file', {
      path: 'probe.js',
      content: "console.log('CONTAINER_PROBE_OK');",
    });
    const result = (await exec.execute('record_probe', { cmd: 'node probe.js' })) as {
      recorded?: boolean;
      stdout?: string;
    };
    expect(result.recorded).toBe(true);
    expect(result.stdout).toContain('CONTAINER_PROBE_OK');
    const manifest = JSON.parse(readFileSync(join(workspace, '.atoma-probes.json'), 'utf8')) as {
      entries: Array<{ cmd: string; stdout?: string }>;
    };
    expect(manifest.entries[0]).toMatchObject({
      cmd: 'node probe.js',
      stdout: 'CONTAINER_PROBE_OK\n',
    });
  }, 60_000);

  it('CANNOT read the sibling stores — the walk that works in-process', async () => {
    const r = (await exec.execute('run_shell', {
      command: 'ls',
      args: ['-1', '../atoma.db', '../skills'],
    })) as { stdout?: string; stderr?: string };
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).not.toContain('TENANT');
    expect(out.toLowerCase()).toMatch(/no such file|cannot access|not found/);
  }, 60_000);

  it('CANNOT read them via an absolute host path either', async () => {
    const r = (await exec.execute('run_shell', {
      command: 'cat',
      args: [join(dir, 'atoma.db')],
    })) as { stdout?: string; stderr?: string };
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).not.toContain('TENANT_REGISTRY_SECRET');
  }, 60_000);

  it('CANNOT reach the control plane over the network', async () => {
    // The other half of T1: a run that could POST to the viz could launch
    // runs, and a run that could reach the internet could exfiltrate.
    const r = (await exec.execute('run_shell', {
      command: 'bash',
      args: ['-c', 'getent hosts host.docker.internal || echo UNRESOLVABLE'],
    })) as { stdout?: string };
    expect(r.stdout ?? '').toContain('UNRESOLVABLE');
  }, 60_000);

  it('CAN still serve and probe its OWN loopback — the http bucket survives', async () => {
    // The property that makes --network none acceptable rather than
    // crippling: verification of an HTTP deliverable happens inside.
    await exec.execute('write_file', {
      path: 'server.js',
      content: [
        "const http = require('http');",
        'const s = http.createServer((q, r) => r.end(JSON.stringify({ ok: true })));',
        's.listen(0, "127.0.0.1", () => console.log("LISTENING_ON_PORT=" + s.address().port));',
      ].join('\n'),
    });
    const started = (await exec.execute('start_node_server', { entry: 'server.js' })) as {
      ok?: boolean;
      url?: string;
    };
    expect(started.ok, `server did not boot: ${JSON.stringify(started)}`).toBe(true);
    const probed = (await exec.execute('fetch_url', { url: started.url })) as {
      status?: number;
      body?: string;
    };
    expect(probed.status).toBe(200);
    expect(probed.body).toContain('"ok":true');
  }, 90_000);

  it('keeps HTTP loopback working when proxied egress is enabled', async () => {
    const egressWorkspace = join(dir, 'egress-ws');
    mkdirSync(egressWorkspace, { recursive: true });
    const backend = await containerToolBackend({
      workspaceRoot: egressWorkspace,
      egress: true,
      runId: `test-loopback-${process.pid}`,
    });
    try {
      await backend.executor.execute('write_file', {
        path: 'server.js',
        content: [
          "const http = require('http');",
          "const s = http.createServer((_q, r) => r.end('EGRESS_LOOPBACK_OK'));",
          's.listen(0, "127.0.0.1", () => console.log("LISTENING_ON_PORT=" + s.address().port));',
        ].join('\n'),
      });
      const started = (await backend.executor.execute('start_node_server', {
        entry: 'server.js',
      })) as { url?: string };
      const probed = (await backend.executor.execute('fetch_url', {
        url: started.url,
      })) as { status?: number; body?: string };
      expect(probed.status).toBe(200);
      expect(probed.body).toContain('EGRESS_LOOPBACK_OK');
      const external = (await backend.executor.execute('fetch_url', {
        url: 'https://registry.npmjs.org/left-pad/latest',
        timeoutMs: 20_000,
      })) as { status?: number; body?: string; error?: string };
      expect(external.status, JSON.stringify(external)).toBe(200);
      expect(external.body).toContain('"name":"left-pad"');
    } finally {
      await backend.cleanup();
    }
  }, 120_000);
});
