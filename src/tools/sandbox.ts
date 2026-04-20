import { mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

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
  private readonly children: ChildProcess[] = [];
  private readonly cleanupHooks: Array<() => Promise<void> | void> = [];

  constructor(root: string) {
    const abs = isAbsolute(root) ? root : resolve(process.cwd(), root);
    this.root = abs;
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
    }
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
   * resolved path escapes the sandbox.
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
    return base;
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
