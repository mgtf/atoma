import { mkdirSync, existsSync, realpathSync, mkdtempSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * Environment variables a sandboxed child process is allowed to inherit.
 * Everything else — ANTHROPIC_API_KEY first among them — is STRIPPED:
 * `run_shell` executes model-authored code, and `fetch_url`/`npm` give
 * that code unrestricted network egress, so a leaked credential in the
 * child env is a one-liner exfiltration (and an unbounded-spend risk).
 * The allowlist covers what interpreters and npm actually need: binary
 * lookup (PATH), caches and tmp (HOME/TMPDIR/…), locale/terminal
 * basics, and Node/npm knobs.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'NODE_ENV',
  'npm_config_cache',
];

/**
 * Build the minimal environment for a sandboxed child process: the
 * allowlisted subset of `process.env`, plus caller-supplied extras
 * (e.g. `PORT` for server tools). Extras win on conflict.
 */
export function sandboxChildEnv(
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  // HOME is allowlisted for tool CACHES (npm, pip, node-gyp) — but the
  // REAL home is a credential store: run_shell executes model-authored
  // code with network egress (fetch_url, npm), and ~/.aws/credentials,
  // ~/.netrc or ~/.ssh were one `cat` away (same exfiltration class the
  // allowlist itself was built against for env vars, #7a — this closes
  // the FILE side). Children get a scratch HOME under the OS tmpdir:
  // caches still work (they're just cold), dotfiles are out of reach.
  // Callers may still override via `extra` (task-owned config).
  if (env['HOME'] !== undefined && extra['HOME'] === undefined) {
    env['HOME'] = scratchHome();
  }
  return { ...env, ...extra };
}

let scratchHomeDir: string | null = null;

/** Lazily-created per-process scratch HOME for sandbox children. */
function scratchHome(): string {
  if (!scratchHomeDir) {
    scratchHomeDir = mkdtempSync(join(tmpdir(), 'atoma-home-'));
  }
  return scratchHomeDir;
}

/**
 * Module-level registry of every ChildProcess ever tracked across any
 * `ToolSandbox` instance in this process. We hook ONE global
 * `process.on('exit')` (plus `uncaughtException` / `unhandledRejection`)
 * so that even a crash-exit — the code path where `sandbox.cleanup()`
 * never runs, e.g. an unhandled BadRequestError from Anthropic — still
 * kills the Python http.server children. Without this, runs that threw
 * mid-flight left behind stale servers squatting ports 8000/8080/3000
 * across subsequent runs, forcing every fresh run to burn 3-5s on
 * EADDRINUSE auto-retries for each squatted port (observed ~30s/run of
 * pure server-boot thrash on a machine with 4 accumulated zombies).
 *
 * Processes remove themselves from this set on their own `exit`, so
 * the handler below only ever sees live processes. Keeping the set at
 * module scope means it survives across sandbox instances within the
 * same run (rare, but harmless).
 */
const ALL_TRACKED_CHILDREN = new Set<ChildProcess>();

let exitHandlerInstalled = false;
function ensureGlobalExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // `exit` fires on every normal termination path (including
  // process.exit(code) and throw-bubbled-to-top). It is synchronous —
  // we can only do sync calls here, so we SIGKILL rather than await
  // graceful shutdown. That is fine for our children (http.server has
  // no state to flush).
  //
  // We deliberately do NOT register `uncaughtException` /
  // `unhandledRejection` handlers here. Node calls the `exit` event
  // on those failure paths anyway (after its default print-and-die
  // behaviour), so our cleanup still runs. Adding custom handlers
  // swallowed some pre-existing promise rejections that the app had
  // been relying on going un-caught (observed: a mid-run the process
  // exited at 42s with exit_code=unknown because we converted a silent
  // rejection into a hard exit). Better to let Node's default policy
  // govern error propagation and scope ourselves to killing children.
  process.on('exit', () => {
    for (const child of ALL_TRACKED_CHILDREN) {
      // Children spawned `detached: true` lead their own process group
      // (pgid == pid), so a negative-pid kill takes down any grandchildren
      // they forked — the double-fork orphan vector (`bash -c "server &"`
      // via run_shell) that a plain child.kill cannot reach. Fall through
      // to the single-process kill for non-detached children (negative-pid
      // kill on a non-leader throws ESRCH; the catch chains both paths).
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* not a group leader (or already gone) — try the plain kill */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });
}

/**
 * A ToolSandbox confines tool side-effects to a single workspace directory
 * and tracks any child processes started by tools so they can be torn down
 * cleanly at the end of a run.
 *
 * All filesystem paths passed to tools are resolved relative to `root` and
 * must stay inside it; attempts to escape via `..`, absolute paths, or
 * symlink-like tricks are rejected with a clear error.
 */
export class ToolSandbox {
  readonly root: string;
  /**
   * Fully symlink-resolved root, computed once. Containment checks run
   * against THIS, not `root`: on macOS common workspace parents are
   * themselves symlinks (/tmp → /private/tmp, /var → /private/var), so
   * comparing a realpath'd candidate against the lexical root would
   * reject every legitimate path.
   */
  private readonly realRoot: string;
  private readonly children: ChildProcess[] = [];
  private readonly cleanupHooks: Array<() => Promise<void> | void> = [];

  constructor(root: string) {
    const abs = isAbsolute(root) ? root : resolve(process.cwd(), root);
    this.root = abs;
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
    }
    this.realRoot = realpathSync(abs);
    ensureGlobalExitHandler();
  }

  /**
   * Register a callback invoked during `cleanup()`. Used by tools that hold
   * long-lived resources (e.g. a Puppeteer browser) so they can tear them down
   * when the sandbox shuts down.
   */
  onCleanup(hook: () => Promise<void> | void): void {
    this.cleanupHooks.push(hook);
  }

  /**
   * Resolve a caller-supplied path against the sandbox root. Throws if the
   * resolved path escapes the sandbox — lexically (`..`, absolute paths)
   * OR through a symlink planted inside the workspace.
   */
  resolve(input: string): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new Error('path must be a non-empty string');
    }
    // Reject absolute paths outright — callers must use relative paths.
    const base = isAbsolute(input) ? join(this.root, input.replace(/^[\\/]+/, '')) : resolve(this.root, input);
    const rel = relative(this.root, base);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path escapes sandbox: ${input} (resolved ${base}, outside ${this.root})`);
    }
    // Symlink containment: `path.resolve` is purely lexical, so a link
    // created INSIDE the workspace (run_shell can `ln -s /etc pwn`)
    // passed the check above while pointing outside the jail. Follow
    // the deepest existing ancestor through realpath and re-run the
    // containment check against the symlink-resolved root.
    const real = this.realpathDeepestExisting(base);
    const realRel = relative(this.realRoot, real);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(
        `path escapes sandbox via symlink: ${input} (real path ${real}, outside ${this.realRoot})`
      );
    }
    return base;
  }

  /**
   * Symlink-resolve the deepest EXISTING ancestor of `abs` and re-append
   * the not-yet-created tail segments. Lets `resolve()` vet paths that
   * are about to be written (write_file creates parents as needed) while
   * still following any symlink that already sits on the path.
   */
  private realpathDeepestExisting(abs: string): string {
    let dir = abs;
    const tail: string[] = [];
    while (!existsSync(dir)) {
      tail.unshift(basename(dir));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const real = realpathSync(dir);
    return tail.length > 0 ? join(real, ...tail) : real;
  }

  /**
   * Pids of the children this sandbox is currently tracking — i.e. the
   * processes the synchronous `process.on('exit')` handler will SIGKILL.
   * Exists so the orphan-reaping guarantee is TESTABLE from outside
   * (`tests/puppeteer-orphan-reaping.test.ts` drives a hard exit and
   * checks the browser died); nothing in the runtime reads it.
   */
  trackedChildPids(): number[] {
    return this.children.map((c) => c.pid).filter((p): p is number => typeof p === 'number');
  }

  trackChild(child: ChildProcess): void {
    this.children.push(child);
    ALL_TRACKED_CHILDREN.add(child);
    child.once('exit', () => {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      ALL_TRACKED_CHILDREN.delete(child);
    });
  }

  /**
   * Kill all tracked child processes and run every registered cleanup hook.
   * Safe to call multiple times.
   */
  async cleanup(): Promise<void> {
    for (const hook of this.cleanupHooks.splice(0)) {
      try {
        await hook();
      } catch {
        // hooks are best-effort; don't let one failure block the others
      }
    }
    for (const child of [...this.children]) {
      if (!child.killed) {
        // Group-kill FIRST (negative pid): server tools now spawn
        // detached (own pgid), so this reaps grandchildren — workers,
        // watchers, double-forks — that a unit SIGTERM leaves orphaned.
        // The unit kill stays as fallback for non-detached children.
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // no such group / not a group leader — unit kill below
          }
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead, ignore
        }
      }
    }
    // Small grace period before returning so sockets unbind.
    await new Promise((r) => setTimeout(r, 150));
  }
}
