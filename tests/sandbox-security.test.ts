import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox, sandboxChildEnv } from '../src/tools/sandbox.js';
import { runShellTool } from '../src/tools/builtin.js';

const posixIt = it.skipIf(process.platform === 'win32');

/**
 * Tests for the two sandbox-security findings of the cost review (#7):
 *  a. child processes must NOT inherit the parent's secrets
 *     (ANTHROPIC_API_KEY + open network egress = one-liner exfiltration)
 *  b. symlinks planted inside the workspace must not escape the jail
 *     (path.resolve is lexical; the docstring promised symlink safety
 *     the old code didn't deliver)
 */

describe('sandboxChildEnv — env allowlist (#7a)', () => {
  let envBefore: string | undefined;
  beforeEach(() => {
    envBefore = process.env['ATOMA_TEST_SECRET'];
    process.env['ATOMA_TEST_SECRET'] = 'sk-super-secret';
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_TEST_SECRET'];
    else process.env['ATOMA_TEST_SECRET'] = envBefore;
  });

  it('strips everything outside the allowlist, keeps PATH/HOME, honours extras', () => {
    const env = sandboxChildEnv({ PORT: '0' });
    expect(env['ATOMA_TEST_SECRET']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['PORT']).toBe('0');
  });

  it('run_shell children cannot read parent secrets (end to end)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-env-'));
    const sandbox = new ToolSandbox(dir);
    try {
      const tool = runShellTool({ sandbox });
      const res = (await tool.execute({
        command: 'node',
        args: ['-e', "console.log(process.env.ATOMA_TEST_SECRET || 'unset')"],
      })) as { exitCode: number; stdout: string };
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('unset');
    } finally {
      await sandbox.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixIt('run_shell reaps `&`-backgrounded grandchildren — no orphan survives the command (#7c)', async () => {
    // The double-fork vector: `bash -c "server &"` exits 0 immediately and
    // the promisified-execFile implementation left the grandchild running
    // FOREVER, outside the tracked-children list (observed live: two
    // python http.servers from a Saturday session still squatting ports —
    // one on 8000 — the following Tuesday, degrading every web run's boot
    // sequence). run_shell now spawns in its own process group and kills
    // the WHOLE group once the command exits, making the declared "no
    // long-running processes" contract enforceable.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-orphan-'));
    const sandbox = new ToolSandbox(dir);
    try {
      const tool = runShellTool({ sandbox });
      const res = (await tool.execute({
        command: 'bash',
        args: ['-c', 'sleep 300 & echo PID=$!'],
      })) as { exitCode: number; stdout: string };
      expect(res.exitCode).toBe(0);
      const pid = Number(res.stdout.match(/PID=(\d+)/)?.[1]);
      expect(pid).toBeGreaterThan(0);
      // SIGKILL delivery is asynchronous — give it a beat, then the
      // grandchild must be gone (kill(pid, 0) throws ESRCH).
      await new Promise((r) => setTimeout(r, 150));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        try {
          process.kill(pid, 'SIGKILL'); // never leak from the test itself
        } catch {
          /* raced to death — fine */
        }
      }
      expect(alive).toBe(false);
    } finally {
      await sandbox.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixIt('run_shell timeout kills the whole group, not just the direct child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-timeout-'));
    const sandbox = new ToolSandbox(dir);
    try {
      const tool = runShellTool({ sandbox, shellTimeoutMs: 500 });
      const started = Date.now();
      const res = (await tool.execute({
        command: 'bash',
        args: ['-c', 'echo PID=$$; sleep 300'],
      })) as { exitCode: number; stdout: string; error?: string };
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/timed out.*process group killed/);
      const pid = Number(res.stdout.match(/PID=(\d+)/)?.[1]);
      await new Promise((r) => setTimeout(r, 150));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await sandbox.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ToolSandbox.resolve — symlink containment (#7b)', () => {
  let outside: string;
  let dir: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'atoma-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside the jail', 'utf8');
    dir = mkdtempSync(join(tmpdir(), 'atoma-jail-'));
    sandbox = new ToolSandbox(dir);
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a symlinked DIR pointing outside the sandbox', () => {
    symlinkSync(outside, join(dir, 'pwn'), 'dir');
    expect(() => sandbox.resolve('pwn/secret.txt')).toThrow(/escapes sandbox via symlink/);
    expect(() => sandbox.resolve('pwn')).toThrow(/escapes sandbox via symlink/);
  });

  it('rejects a symlinked FILE pointing outside the sandbox', () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'innocent.txt'));
    expect(() => sandbox.resolve('innocent.txt')).toThrow(/escapes sandbox via symlink/);
  });

  it('still rejects lexical ".." escapes', () => {
    expect(() => sandbox.resolve('../outside.txt')).toThrow(/escapes sandbox/);
  });

  it('allows legitimate paths, including not-yet-created nested files', () => {
    mkdirSync(join(dir, 'src'));
    expect(() => sandbox.resolve('src/main.js')).not.toThrow();
    // write_file creates parents — a deep new path must still resolve.
    expect(() => sandbox.resolve('a/b/c/new.txt')).not.toThrow();
  });

  it('allows a symlink pointing to a sibling INSIDE the workspace', () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir');
    expect(() => sandbox.resolve('link/file.txt')).not.toThrow();
  });
});

describe('child HOME is a scratch dir, not the credential store (audit rank-11)', () => {
  it('run_shell children see a HOME that is NOT the real home', async () => {
    // run_shell executes model-authored code with network egress; the real
    // HOME made ~/.aws/credentials, ~/.netrc and ~/.ssh one `cat` away —
    // the same exfiltration class the env allowlist (#7a) closed for
    // variables, left open on the FILE side.
    const { sandboxChildEnv } = await import('../src/tools/sandbox.js');
    const env = sandboxChildEnv();
    expect(env['HOME']).toBeDefined();
    expect(env['HOME']).not.toBe(process.env['HOME']);
    expect(env['HOME']).toMatch(/atoma-home-/);
    // Caller-supplied HOME (task-owned config) still wins.
    expect(sandboxChildEnv({ HOME: '/task/home' })['HOME']).toBe('/task/home');
    // Stable within the process: caches accumulate across tool calls.
    expect(sandboxChildEnv()['HOME']).toBe(env['HOME']);
  });

  it('substitutes the scratch HOME even when the parent has none (the win32 shape)', async () => {
    // The original guard only rewrote an EXISTING HOME. A win32 parent
    // usually defines none, so nothing was rewritten — and a child with no
    // HOME at all still reaches the real profile through os.homedir()'s
    // USERPROFILE/syscall fallback. Measured 2026-08-30 on a Windows host:
    // ~/.claude/.credentials.json was readable from run_shell.
    const { sandboxChildEnv } = await import('../src/tools/sandbox.js');
    const saved = process.env['HOME'];
    delete process.env['HOME'];
    try {
      const env = sandboxChildEnv({}, 'win32');
      expect(env['HOME']).toMatch(/atoma-home-/);
    } finally {
      if (saved !== undefined) process.env['HOME'] = saved;
    }
  });

  it('pins the win32 home variables to the scratch dir, never the real profile', async () => {
    const { sandboxChildEnv } = await import('../src/tools/sandbox.js');
    const saved = process.env['USERPROFILE'];
    process.env['USERPROFILE'] = 'C:\\Users\\real-user';
    try {
      const env = sandboxChildEnv({}, 'win32');
      // The parent's USERPROFILE is not allowlisted and must not leak; the
      // child's one is the scratch HOME itself.
      expect(env['USERPROFILE']).toBe(env['HOME']);
      expect(env['USERPROFILE']).not.toBe('C:\\Users\\real-user');
      // A drive-qualified scratch path splits into the legacy pair; the two
      // halves must reassemble into HOME exactly. (On a POSIX host running
      // this branch the scratch path has no drive and the pair is absent.)
      if (env['HOMEDRIVE'] !== undefined) {
        expect(`${env['HOMEDRIVE']}${env['HOMEPATH']}`).toBe(env['HOME']);
      } else {
        expect(env['HOMEPATH']).toBeUndefined();
      }
      // Task-owned HOME propagates to the win32 variables coherently.
      const task = sandboxChildEnv({ HOME: 'D:\\task\\home' }, 'win32');
      expect(task['HOME']).toBe('D:\\task\\home');
      expect(task['USERPROFILE']).toBe('D:\\task\\home');
      expect(task['HOMEDRIVE']).toBe('D:');
      expect(task['HOMEPATH']).toBe('\\task\\home');
      // POSIX children carry no win32 home variables at all.
      expect(sandboxChildEnv({}, 'linux')['USERPROFILE']).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = saved;
    }
  });
});
