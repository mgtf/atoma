import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const service = readFileSync('deploy/atoma-mender.service', 'utf8');
const install = readFileSync('deploy/install-mender.sh', 'utf8');

describe('the dedicated mender host', () => {
  it('retires Actions and keeps product secrets out of the service configuration', () => {
    expect(existsSync('.github/workflows/mender.yml')).toBe(false);
    expect(service).toContain('EnvironmentFile=/home/atoma/config/mender.env');
    expect(service).not.toContain('EnvironmentFile=/home/atoma/config/atoma.env');
    expect(service).not.toContain('--no-idle-gate');
    expect(service).toContain('WorkingDirectory=/home/atoma/mender');
  });

  it('lets the active attempt finish before its container cleanup backstop', () => {
    expect(service).toContain('KillMode=mixed');
    expect(service).toContain('TimeoutStopSec=3h');
    expect(service).toContain('ExecStopPost=/bin/bash /home/atoma/mender/deploy/mender-reap.sh');
    expect(service).toContain('MemoryMax=1G');
    expect(install).toContain('git checkout --detach "$MENDER_REVISION"');
    expect(install).not.toMatch(/gh pr merge|enable-auto-merge/);
  });

  it('keeps installation and stop scripts valid Bash', () => {
    for (const path of ['deploy/install-mender.sh', 'deploy/mender-reap.sh']) {
      const result = spawnSync('bash', ['-n'], { input: readFileSync(path, 'utf8'), encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('reaps only containers with the mender label, including after client death', () => {
    const script = readFileSync('deploy/mender-reap.sh', 'utf8');
    const result = spawnSync('bash', [], { encoding: 'utf8', input: `
      docker() {
        if [[ "$1" == ps ]]; then
          [[ "$*" == 'ps -aq --filter label=atoma.role=mender' ]] || return 8
          printf 'container-one\\ncontainer-two\\n'
        else
          printf '%s\\n' "$*"
        fi
      }
      ${script}
    ` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('rm --force container-one container-two');
  });
});