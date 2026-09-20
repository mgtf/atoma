// Execute inside an isolated Linux engine host namespace, with /srv/atoma and
// this checkout's deploy/ and scripts/ mounted at identical absolute paths.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chownSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProvider, CookieJar, request, providerLoginUrl } from './auth-smoke-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = '/srv/atoma';
const base = 'https://127.0.0.1';
assert.equal(process.env.ATOMA_STACK_SMOKE, 'isolated', 'Explicit isolated-engine acknowledgement required');
assert(!existsSync(`${state}/product/atoma.db`), 'Refusing an existing product store');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 240_000 });
assert(JSON.parse(docker('info', '--format', '{{json .Runtimes}}')).runsc, 'Registered runsc required');
for (const command of [['ps','-aq'], ['network','ls','-q'], ['volume','ls','-q']]) {
  assert.equal(docker(...command, '--filter', 'label=dev.atoma.owner').trim(), '',
    'Refusing an engine holding existing Atoma resources');
}
const envFile = `${state}/config/stack.env`;
const compose = (...args) => docker('run', '--rm', '--network', 'host',
  '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  '--mount', `type=bind,source=${state},target=${state}`,
  '--mount', `type=bind,source=${root},target=${root},readonly`,
  'docker:28.3.2-cli', 'compose', '--project-name', 'atoma-w13', '--env-file', envFile,
  '-f', `${root}/deploy/compose.yaml`, ...args);
const image = kind => {
  const refs = JSON.parse(docker('image', 'inspect', `localhost:5000/${kind}:w13`))[0].RepoDigests;
  const value = refs.find(ref => ref.startsWith(`localhost:5000/${kind}@sha256:`));
  assert(value, `Missing real registry digest for ${kind}`);
  return value;
};
for (const folder of ['config','product','control','worker-sockets','workspaces','launcher-state']) {
  mkdirSync(`${state}/${folder}`, { recursive: true, mode: 0o700 });
}
mkdirSync(`${state}/workspaces/operator`, { recursive: true, mode: 0o700 });
chownSync(`${state}/workspaces/operator`, 10001, 10001);
assert(existsSync(`${state}/certs/web.crt`), 'Provision the fixture CA before starting Node with NODE_EXTRA_CA_CERTS');
const provider = await startProvider({ identities: [
  { id: 4242, name: 'Stack owner A' }, { id: 4300, name: 'Stack member A' },
  { id: 4400, name: 'Stack owner B' }, { id: 4500, name: 'Stack viewer A' },
] });
let started = false;
try {
  writeFileSync(`${state}/config/web.env`, [
    'ATOMA_AUTH_GITHUB_CLIENT_ID=release-client', 'ATOMA_AUTH_GITHUB_CLIENT_SECRET=release-secret',
    `ATOMA_AUTH_GITHUB_AUTHORIZE_URL=${provider.baseUrl}/authorize`,
    `ATOMA_AUTH_GITHUB_TOKEN_URL=${provider.baseUrl}/token`,
    `ATOMA_AUTH_GITHUB_USERINFO_URL=${provider.baseUrl}/userinfo`,
    `ATOMA_SECRET_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`, 'ATOMA_VIZ_SENTINEL=0',
  ].join('\n')+'\n', { mode: 0o600 });
  writeFileSync(envFile, [
    ...['web','launcher','worker','preview','gateway'].map(kind => `ATOMA_${kind.toUpperCase()}_IMAGE=${image(kind)}`),
    `ATOMA_WEB_ENV_FILE=${state}/config/web.env`, 'ATOMA_PUBLIC_HOST=127.0.0.1',
    'ATOMA_PREVIEW_DOMAIN=preview.atoma.test', 'ATOMA_EGRESS_ALLOWLIST=registry.npmjs.org',
  ].join('\n')+'\n', { mode: 0o600 });
  started = true;
  compose('up', '-d', '--wait', '--wait-timeout', '150');
  console.log('reference Compose stack healthy');
  const web = compose('ps', '-q', 'web').trim();
  assert(web);
  const webCommand = (...args) => docker('exec', web, 'node', ...args);
  const login = async (invitation = null) => {
    const jar = new CookieJar();
    const selector = await request(jar, `${base}/auth/login${invitation ? `?invite=${invitation}` : ''}`);
    assert.equal(selector.status, 200);
    const href = providerLoginUrl(await selector.text(), base, invitation);
    const initiated = await request(jar, href.href);
    assert.equal(initiated.status, 302);
    const authorized = await request(jar, initiated.headers.get('location'));
    assert.equal(authorized.status, 302);
    const callback = await request(jar, authorized.headers.get('location'));
    assert.equal(callback.status, 302);
    const who = await request(jar, `${base}/auth/whoami`);
    assert.equal(who.status, 200);
    return { jar, viewer: await who.json() };
  };
  assert.equal((await fetch(`${base}/api/projects`, { redirect: 'manual' })).status, 401);
  const owner = await login();
  assert.equal(owner.viewer.role, 'org:owner');
  const orgId = owner.viewer.activeOrganisation.id;
  const invite = role => {
    const result = webCommand('/app/dist/cli/auth.js', 'invite', '--org', orgId, '--role', role, '--ttl-hours', '1');
    const line = result.split('\n').find(value => value.startsWith('Open: '));
    assert(line, 'Compiled invite did not return a link');
    return new URL(line.slice(6).trim()).searchParams.get('invite');
  };
  const member = await login(invite('org:member'));
  assert.equal(member.viewer.role, 'org:member');
  assert.equal(member.viewer.activeOrganisation.id, orgId);
  const other = await login();
  assert.notEqual(other.viewer.activeOrganisation.id, orgId);
  const viewer = await login(invite('org:viewer'));
  assert.equal(viewer.viewer.role, 'org:viewer');
  assert.equal(viewer.viewer.activeOrganisation.id, orgId);
  for (const account of [member, viewer, other]) {
    assert.equal((await request(account.jar, `${base}/api/admin/invitations`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
    })).status, 403);
  }
  assert.equal(provider.verifiedPkce(), 4);
  console.log('HTTPS founder, compiled invitations, member/viewer admission and admin role refusals passed');
  const authority = { a: owner.viewer, b: other.viewer };
  writeFileSync(`${state}/product/smoke-authority.json`, JSON.stringify(authority), { mode: 0o600 });
  // The scenario runs inside the actual web container without engine access.
  const scenario = readFileSync(`${root}/scripts/packaged-stack-workload.mjs`, 'utf8');
  writeFileSync(`${state}/product/smoke-scenario.mjs`, scenario);
  writeFileSync(`${state}/product/smoke-restore.py`, readFileSync(`${root}/scripts/restore-drill.py`));
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn('docker', ['exec', '-i', web, 'node', `${state}/product/smoke-scenario.mjs`],
      { stdio: ['pipe','pipe','pipe'] });
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error('Workload acceptance timed out')); }, 240000);
    let buffer = '', errorText = '', attested = false;
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1);
        if (!line.startsWith('{"inspectPreview":')) { console.log(line); continue; }
        try {
          const name = JSON.parse(line).inspectPreview;
          const inspected = JSON.parse(docker('inspect', name))[0];
          assert.equal(inspected.HostConfig.Runtime, 'runsc');
          assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
          assert.notEqual(inspected.Config.User, 'root');
          attested = true;
          child.stdin.end('engine runtime verified\n');
        } catch (error) { child.kill(); clearTimeout(timer); rejectRun(error); }
      }
    });
    child.on('error', error => { clearTimeout(timer); rejectRun(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && attested) resolveRun();
      else rejectRun(new Error(`Workload failed (${code}): ${errorText.slice(-3000)}`)); });
  });
  const receipt = JSON.parse(readFileSync(`${state}/product/smoke-workload.json`, 'utf8'));
  for (const run of receipt.runs) {
    const own = run.orgId === orgId ? owner : other;
    const foreign = run.orgId === orgId ? other : owner;
    const path = `/api/projects/${run.projectId}/runs`;
    assert.equal((await request(own.jar, base+path)).status, 200);
    assert.equal((await request(foreign.jar, base+path)).status, 404);
    const previewPath = `${path}/${run.runId}/preview`;
    assert.equal((await request(own.jar, base+previewPath)).status, 200,
      'The web preview service must accept the configured launcher image digest');
    assert.equal((await request(foreign.jar, base+previewPath)).status, 404);
  }
  compose('restart', 'launcher', 'web');
  compose('up', '-d', '--wait', '--wait-timeout', '150');
  assert.equal((await request(owner.jar, `${base}/api/projects`)).status, 200);
  console.log('authenticated scoped run reads and session persistence after restart passed');
  writeFileSync(`${state}/product/stack-smoke-report.json`, JSON.stringify({
    status: 'passed', auth: 'https-pkce', organisations: 2, roles: ['org:owner','org:member','org:viewer'],
    workload: receipt, restart: 'graceful', images: Object.fromEntries(['web','launcher','worker','preview','gateway'].map(k => [k,image(k)])),
  }, null, 2)+'\n');
} catch (error) {
  if (started) process.stderr.write(compose('logs', '--no-color', '--tail', '35'));
  throw error;
} finally {
  await provider.close();
  if (started) compose('down', '--timeout', '25');
}
