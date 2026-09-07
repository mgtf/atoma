import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const hostDeploy = readFileSync('deploy/host-deploy.sh', 'utf8');
const sshCommand = readFileSync('deploy/ssh-command.sh', 'utf8');
const service = readFileSync('deploy/atoma.service', 'utf8');
const deployEnv = readFileSync('deploy/deploy.env.example', 'utf8');
const preflight = readFileSync('src/cli/deploy-preflight.ts', 'utf8');
const releaseSmoke = readFileSync('scripts/release-smoke.mjs', 'utf8');

describe('post-CI deployment pipeline', () => {
  it('packages the exact verified main revision and no runtime state', () => {
    expect(ci).toContain('root="atoma-${GITHUB_SHA}"');
    expect(ci).toContain('printf \'%s\\n\' "${GITHUB_SHA}" > "deployment/${root}/REVISION"');
    expect(ci).toContain('name: atoma-deploy-${{ github.sha }}');
    expect(ci).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    const packageStep = ci.slice(ci.indexOf('Package the exact main revision'), ci.indexOf('Upload immutable'));
    for (const forbidden of ['atoma.db', 'runs', 'skills', '.env ']) {
      expect(packageStep).not.toContain(forbidden);
    }
  });

  it('runs only after a successful main push CI and remains explicitly disarmed by default', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [CI]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("vars.ATOMA_DEPLOY_ENABLED == 'true'");
    expect(workflow).toMatch(/environment:\n\s+name: production/);
    expect(workflow).toMatch(/permissions:\n\s+actions: read\n\s+contents: read/);
  });

  it('downloads from the triggering run and never deploys a floating checkout', () => {
    expect(workflow).toContain('run-id: ${{ github.event.workflow_run.id }}');
    expect(workflow).toContain('name: atoma-deploy-${{ github.event.workflow_run.head_sha }}');
    expect(workflow).toContain('sha256sum -c');
    expect(workflow).toContain('StrictHostKeyChecking=yes');
    expect(workflow).toContain('UserKnownHostsFile=');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toMatch(/git (pull|checkout|reset)/);
  });

  it('keeps a quiet long-running activation alive across the SSH channel', () => {
    expect(workflow).toContain('-o ServerAliveInterval=15');
    expect(workflow).toContain('-o ServerAliveCountMax=20');
    expect(workflow).toContain('-o TCPKeepAlive=yes');
  });

  it('keeps the deployment input validation syntactically valid Bash', () => {
    const start = workflow.indexOf('      - name: Verify deployment inputs and artifact');
    const end = workflow.indexOf('      - name: Install pinned SSH identity and host key', start);
    const step = workflow.slice(start, end);
    const runMarker = '        run: |\n';
    const script = step.slice(step.indexOf(runMarker) + runMarker.length).replace(/^ {10}/gm, '');
    const parsed = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });

    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it('drains before stopping and rolls back both code and worker identity on failed health', () => {
    expect(hostDeploy.indexOf('ATOMA_DEPLOY_LOCK_PATH')).toBeLessThan(
      hostDeploy.lastIndexOf('systemctl stop "${SERVICE_NAME}"')
    );
    expect(hostDeploy.indexOf('--hold')).toBeLessThan(
      hostDeploy.lastIndexOf('systemctl stop "${SERVICE_NAME}"')
    );
    expect(hostDeploy).toContain('GUARD_READY_FILE');
    expect(hostDeploy).toContain(
      'GUARD_DIR="$(mktemp -d "${DEPLOY_ROOT}/.deploy-guard-${REVISION}.XXXXXX")"'
    );
    expect(hostDeploy).not.toContain('GUARD_DIR="${WORK_DIR}/guard"');
    expect(hostDeploy).toContain(
      'install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${GUARD_DIR}"'
    );
    expect(hostDeploy).toContain('"${DEPLOY_ROOT}"/.deploy-guard-*) rm -rf -- "${GUARD_DIR}"');
    expect(hostDeploy).toContain('--admission-marker "${MARKER_PATH}"');
    expect(hostDeploy).toContain('WORKER_ROLLBACK_TAG="atoma-worker:rollback-${OLD_REVISION}"');
    expect(hostDeploy).toContain('mv -Tf "${rollback_link}" "${CURRENT}"');
    expect(hostDeploy).toContain('ATOMA_DEPLOY_HEALTH_URL must be a loopback HTTP URL');
  });

  it('serialises on the host and restores the old generation after any activation failure', () => {
    expect(hostDeploy).toContain('flock -n 9 || fail "another deployment is already active"');
    expect(hostDeploy.indexOf('flock -n 9')).toBeLessThan(hostDeploy.indexOf('cat >"${BUNDLE}"'));
    expect(hostDeploy).toMatch(
      /if \[\[ "\$\{status\}" -ne 0 && "\$\{ACTIVATION_STARTED\}" -eq 1 \]\]; then\s+restore_previous_generation/
    );
    expect(hostDeploy).toContain("trap 'exit 129' HUP");
    expect(hostDeploy).toContain("trap 'exit 130' INT");
    expect(hostDeploy).toContain("trap 'exit 143' TERM");
    expect(hostDeploy.indexOf('ACTIVATION_STARTED=1')).toBeLessThan(
      hostDeploy.lastIndexOf('systemctl stop "${SERVICE_NAME}"')
    );
    expect(hostDeploy).toContain('docker image rm atoma-worker:latest');
    expect(preflight).toMatch(/finally \{\s+lease\?\.release\(\);[\s\S]+rmSync\(resolve\(options\.admissionMarker\)/);
  });

  it('refreshes the mender after the application is healthy, outside the rollback section', () => {
    // 2026-09-07: the mender runs from its OWN clone, so nothing moved it to
    // the deployed revision — it stayed on whatever install-mender.sh last
    // pinned while mender.env already described the new one. The refresh runs
    // after health verification and after ACTIVATION_STARTED is cleared, so a
    // mender failure can never restore the previous application generation.
    const healthy = hostDeploy.indexOf('fail "new generation failed health verification"');
    const closed = hostDeploy.lastIndexOf('ACTIVATION_STARTED=0');
    const refresh = hostDeploy.indexOf('\nrefresh_mender\n');
    expect(healthy).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(healthy);
    expect(refresh).toBeGreaterThan(closed);
    // A host without a mender skips; a present one is moved to THIS revision,
    // rebuilt with its image and unit, and restarted.
    expect(hostDeploy).toContain('echo "mender: not installed on this host');
    expect(hostDeploy).toContain('git checkout --quiet --detach "$MENDER_REVISION"');
    expect(hostDeploy).toContain('docker build -f docker/mender.Dockerfile -t atoma-mender:local .');
    expect(hostDeploy).toContain('"/etc/systemd/system/${MENDER_SERVICE}"');
    expect(hostDeploy).toContain('systemctl start "${MENDER_SERVICE}"');
    // Failure is reported, not hidden, and names the application as deployed.
    expect(hostDeploy).toContain('(the application itself is deployed)');
    expect(hostDeploy).toContain('ATOMA_DEPLOY_MENDER_CHECKOUT');
    expect(readFileSync('deploy/deploy.env.example', 'utf8')).toContain('ATOMA_DEPLOY_MENDER_ENV=');
  });

  it('restricts the SSH key and keeps state/environment outside the release link', () => {
    expect(sshCommand).toContain('SSH_ORIGINAL_COMMAND');
    expect(sshCommand).toMatch(/\^deploy\\ \(\[0-9a-f\]\{40\}\)\\ \(\[0-9a-f\]\{64\}\)\$/);
    expect(sshCommand).not.toContain('eval');
    expect(service).toContain('WorkingDirectory=/home/atoma/current');
    expect(service).toContain('EnvironmentFile=/home/atoma/config/atoma.env');
    expect(service).toContain('RequiresMountsFor=/home/atoma');
    expect(service).not.toContain('.env.example');
    expect(hostDeploy).toContain('DEPLOY_ROOT="${ATOMA_DEPLOY_ROOT:-/home/atoma}"');
    expect(hostDeploy).toContain('findmnt --mountpoint "${REQUIRED_MOUNT}"');
    expect(hostDeploy.indexOf('findmnt --mountpoint')).toBeLessThan(
      hostDeploy.indexOf('install -d -m 0755 "${DEPLOY_ROOT}"')
    );
    expect(deployEnv).toContain('ATOMA_DEPLOY_ROOT=/home/atoma');
    expect(deployEnv).toContain('ATOMA_DEPLOY_REQUIRED_MOUNT=/home/atoma');
    expect(deployEnv).toContain('ATOMA_DEPLOY_APP_ENV=/home/atoma/config/atoma.env');
    for (const legacyRoot of ['/opt/atoma', '/var/lib/atoma']) {
      expect(hostDeploy).not.toContain(legacyRoot);
      expect(service).not.toContain(legacyRoot);
      expect(deployEnv).not.toContain(legacyRoot);
    }
    expect(releaseSmoke).toContain("mkdtempSync(join(tmpdir(), 'atoma-release-smoke-'))");
    expect(releaseSmoke).not.toContain("join(root, 'smoke-store.db')");
    expect(releaseSmoke).not.toContain("join(root, 'smoke-runs')");
    expect(releaseSmoke).toContain('rmSync(smokeRoot, { recursive: true, force: true })');
  });
});
