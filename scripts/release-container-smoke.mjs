import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerToolBackend } from '../dist/run/toolBackend.js';

const workspace = mkdtempSync(join(tmpdir(), 'atoma-release-egress-'));
let backend;
let hostProbeServer;

try {
  hostProbeServer = createServer((_req, res) => res.end('CONTROL_PLANE_REACHED'));
  await new Promise((resolve, reject) => {
    hostProbeServer.once('error', reject);
    hostProbeServer.listen(0, '0.0.0.0', resolve);
  });
  const hostProbePort = hostProbeServer.address().port;

  backend = await containerToolBackend({
    workspaceRoot: workspace,
    image: process.env.ATOMA_WORKER_IMAGE,
    egress: true,
    runId: `release-egress-${process.pid}`,
  });

  writeFileSync(join(workspace, 'checksum.txt'), 'abc');
  const checksum = await backend.executor.execute('run_shell', {
    command: 'sha256sum', args: ['checksum.txt'],
  });
  if (checksum?.exitCode !== 0 || checksum.stdout?.trim() !==
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  checksum.txt') {
    throw new Error(`direct worker checksum failed: ${JSON.stringify(checksum)}`);
  }

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

  // `--internal` by itself still exposes the bridge's host gateway. Bypass
  // every proxy variable and probe that raw address, where this process has
  // deliberately bound a canary. An isolated-gateway network has no default
  // route/address to probe; any CONTROL_PLANE_REACHED output is a release
  // blocker, regardless of the allowlist proxy working correctly.
  const direct = await backend.executor.execute('run_shell', {
    command: 'node',
    args: [
      '-e',
      [
        "const fs=require('node:fs'),http=require('node:http');",
        "const row=fs.readFileSync('/proc/net/route','utf8').split(/\\n/).slice(1).find((line)=>line.trim().split(/\\s+/)[1]==='00000000');",
        "if(!row){console.log('NO_DEFAULT_GATEWAY');process.exit(0)}",
        "const hex=row.trim().split(/\\s+/)[2];",
        "const host=hex.match(/../g).reverse().map((part)=>parseInt(part,16)).join('.');",
        "const req=http.get({host,port:Number(process.argv[1]),path:'/'},(res)=>{let body='';res.on('data',(chunk)=>body+=chunk);res.on('end',()=>console.log(body))});",
        "req.setTimeout(1500,()=>req.destroy(new Error('timeout')));",
        "req.on('error',()=>console.log('BLOCKED'));",
      ].join(''),
      String(hostProbePort),
    ],
  });
  if (`${direct?.stdout ?? ''}${direct?.stderr ?? ''}`.includes('CONTROL_PLANE_REACHED')) {
    throw new Error(`raw Docker gateway reached the host: ${JSON.stringify(direct)}`);
  }

  process.stdout.write('release container smoke: external=200 control-plane=blocked\n');
} finally {
  await backend?.cleanup();
  await new Promise((resolve) => hostProbeServer?.close(resolve) ?? resolve());
  rmSync(workspace, { recursive: true, force: true });
}
