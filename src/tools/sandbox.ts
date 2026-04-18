import { mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

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
    child.once('exit', () => {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
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
