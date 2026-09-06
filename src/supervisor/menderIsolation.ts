import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand, runCommand } from './session.js';

/** Only inference credentials cross into the disposable execution host. */
export function menderContainerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (env[key]) isolated[key] = env[key];
  }
  return isolated;
}

/**
 * A worktree is not a security boundary. Run ALL executable proposal code in
 * a separate PID/mount namespace, with only the proposal directory writable.
 * No host HOME, checkout credentials, common git directory or engine socket
 * is mounted. Even model-authored tests cannot read the publisher's /proc.
 * Git readers use a freshly cloned, read-only object database and index.
 */
export const runIsolatedMenderCommand: typeof runCommand = async (spec, extraArgs, options) => {
  if (process.platform !== 'linux') throw new Error('the mender execution host requires Linux with Docker (use WSL2)');
  const metadataRoot = mkdtempSync(join(tmpdir(), 'atoma-mender-git-'));
  const metadata = join(metadataRoot, 'repo.git');
  const gitFile = join(options.cwd, '.git');
  const originalGitFile = readFileSync(gitFile);
  const name = `atoma-mender-${randomUUID()}`;
  let started = false;
  try {
    const controlOptions = { cwd: options.cwd, timeoutMs: options.timeoutMs };
    const cloned = await runCommand('git', ['clone', '--bare', '--no-local', options.cwd, metadata], controlOptions);
    if (cloned.code !== 0) throw new Error('could not prepare isolated mender git metadata');
    const indexed = await runCommand('git', ['--git-dir', metadata, 'read-tree', 'HEAD'], controlOptions);
    if (indexed.code !== 0) throw new Error('could not prepare isolated mender index');
    appendFileSync(join(metadata, 'config'), '\n[core]\n\tbare = false\n\tworktree = /work\n');
    writeFileSync(gitFile, 'gitdir: /atoma-git\n');
    const env = menderContainerEnv(options.env ?? {});
    const command = resolveCommand(spec);
    // Numeric --user preserves worktree ownership, but does not create a passwd
    // entry. Supply container-only identity data so homedir() also works when
    // a child unsets HOME. Never mount the host's account database.
    const uid = process.getuid!();
    const gid = process.getgid!();
    const passwd = join(metadataRoot, 'passwd');
    const group = join(metadataRoot, 'group');
    writeFileSync(passwd, `mender:x:${uid}:${gid}:Mender:/tmp:/usr/sbin/nologin\n`, { mode: 0o644 });
    writeFileSync(group, `mender:x:${gid}:\n`, { mode: 0o644 });
    const args = [
      'run', '--name', name, '--label', 'atoma.role=mender', '--rm', '--init',
      ...(options.input !== undefined || options.onLine ? ['--interactive'] : []),
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
      '--pids-limit=512', '--memory=2g', '--memory-swap=2g', '--cpus=1',
      '--user', `${uid}:${gid}`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=512m',
      '--mount', `type=bind,src=${options.cwd},dst=/work`,
      '--mount', `type=bind,src=${metadata},dst=/atoma-git,readonly`,
      '--mount', `type=bind,src=${passwd},dst=/etc/passwd,readonly`,
      '--mount', `type=bind,src=${group},dst=/etc/group,readonly`,
      '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'HUSKY=0',
      '--env', 'VITEST_MAX_WORKERS=1',
      '--env', 'NODE_OPTIONS=--max-old-space-size=1536',
      ...(options.network ? ['--network', options.network] : []),
      ...Object.keys(env).flatMap((key) => ['--env', key]),
      process.env['ATOMA_MENDER_SANDBOX_IMAGE'] ?? 'atoma-mender:local',
      command.command === process.execPath ? 'node' : command.command,
      ...command.args, ...extraArgs,
    ];
    started = true;
    return await runCommand('docker', args, { ...options, env: { ...process.env, ...env } });
  } finally {
    // Killing the docker client does not kill its container. Reap the isolate
    // before restoring metadata or allowing the publisher to examine files.
    if (started) {
      for (;;) {
        const removed = await runCommand('docker', ['rm', '--force', name], { cwd: metadataRoot, timeoutMs: 60_000 });
        if (removed.code === 0 || removed.stderr.includes('No such container')) break;
        options.onLog?.('mender container still exists; retaining ownership');
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      }
    }
    rmSync(gitFile, { recursive: true, force: true });
    writeFileSync(gitFile, originalGitFile);
    rmSync(metadataRoot, { recursive: true, force: true });
  }
};
