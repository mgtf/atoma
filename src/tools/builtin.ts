import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, Logger } from '../core/types.js';
import type { ToolSandbox } from './sandbox.js';
import puppeteer, { type Browser } from 'puppeteer';

const execFileAsync = promisify(execFile);

export interface BuiltinToolOptions {
  sandbox: ToolSandbox;
  logger?: Logger;
  /** Allowed executables for `run_shell`. Defaults to a conservative list. */
  shellAllowlist?: string[];
  /** Hard timeout for shell commands in ms. Defaults to 30s. */
  shellTimeoutMs?: number;
}

/** Simple declaration + implementation bundle for an atom tool. */
export interface BuiltinTool {
  declaration: Tool;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export function writeFileTool(opts: BuiltinToolOptions): BuiltinTool {
  return {
    declaration: {
      name: 'write_file',
      description:
        'Write a text file inside the workspace. Creates parent directories as needed. Overwrites existing files. Use RELATIVE paths only (e.g. "index.html", "src/main.js").',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the workspace.' },
          content: { type: 'string', description: 'Full text content to write.' },
        },
        required: ['path', 'content'],
      },
    },
    async execute(args) {
      const path = expectString(args, 'path');
      const content = expectString(args, 'content');
      const abs = opts.sandbox.resolve(path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      opts.logger?.info(`[tool:write_file] ${path} (${content.length} bytes)`);
      return { ok: true, path, bytes: content.length };
    },
  };
}

export function readFileTool(opts: BuiltinToolOptions): BuiltinTool {
  return {
    declaration: {
      name: 'read_file',
      description:
        'Read the full contents of a file from the workspace. Use relative paths only.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
    async execute(args) {
      const path = expectString(args, 'path');
      const abs = opts.sandbox.resolve(path);
      const content = readFileSync(abs, 'utf8');
      opts.logger?.debug(`[tool:read_file] ${path} (${content.length} bytes)`);
      return { path, content };
    },
  };
}

export function listFilesTool(opts: BuiltinToolOptions): BuiltinTool {
  return {
    declaration: {
      name: 'list_files',
      description:
        'List files and directories inside the workspace (optionally under a subdirectory).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory to list. Defaults to workspace root.',
          },
        },
      },
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' && args['path'] ? args['path'] : '.';
      const abs = opts.sandbox.resolve(rel);
      const entries = readdirSync(abs).map((name) => {
        const full = `${abs}/${name}`;
        const st = statSync(full);
        return { name, kind: st.isDirectory() ? 'dir' : 'file', size: st.size };
      });
      return { path: rel, entries };
    },
  };
}

export function runShellTool(opts: BuiltinToolOptions): BuiltinTool {
  const allowlist = new Set(
    opts.shellAllowlist ?? ['node', 'npm', 'npx', 'python3', 'ls', 'cat', 'echo', 'which']
  );
  const timeoutMs = opts.shellTimeoutMs ?? 30_000;

  return {
    declaration: {
      name: 'run_shell',
      description: [
        'Run an allowlisted shell command inside the workspace and return stdout/stderr.',
        `Allowed executables: ${[...allowlist].join(', ')}.`,
        'Do NOT use this for long-running processes (use start_static_server instead).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Program to invoke (must be in the allowlist). E.g. "node", "npm", "python3".',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Positional arguments. E.g. ["--version"].',
          },
        },
        required: ['command'],
      },
    },
    async execute(args) {
      const command = expectString(args, 'command');
      const rawArgs = Array.isArray(args['args']) ? (args['args'] as unknown[]) : [];
      const argv = rawArgs.map((a) => String(a));
      if (!allowlist.has(command)) {
        throw new Error(
          `run_shell: command "${command}" is not in allowlist (${[...allowlist].join(', ')})`
        );
      }
      opts.logger?.info(`[tool:run_shell] ${command} ${argv.join(' ')}`);
      try {
        const { stdout, stderr } = await execFileAsync(command, argv, {
          cwd: opts.sandbox.root,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (err) {
        const e = err as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
        };
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message,
          error: e.message,
        };
      }
    },
  };
}

export function startStaticServerTool(opts: BuiltinToolOptions): BuiltinTool {
  return {
    declaration: {
      name: 'start_static_server',
      description:
        'Start a static HTTP server (python3 -m http.server) in the background that serves the workspace root, and return the URL to access it. The server runs until the process exits.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'Port to listen on. Defaults to 8000.',
          },
        },
      },
    },
    async execute(args) {
      const port =
        typeof args['port'] === 'number' && Number.isFinite(args['port'])
          ? Math.floor(args['port'] as number)
          : 8000;
      const child = spawn('python3', ['-m', 'http.server', String(port)], {
        cwd: opts.sandbox.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      opts.sandbox.trackChild(child);
      opts.logger?.info(`[tool:start_static_server] python3 http.server :${port} in ${opts.sandbox.root}`);

      // Wait briefly to confirm the process is up and the port is bound.
      await new Promise((resolve, reject) => {
        const fail = (msg: string) => reject(new Error(msg));
        const timer = setTimeout(() => resolve(undefined), 500);
        child.once('error', (err) => {
          clearTimeout(timer);
          fail(`server failed to start: ${err.message}`);
        });
        child.stderr?.once('data', (chunk: Buffer) => {
          const s = chunk.toString();
          // python prints the Serving line to stderr. That's good news.
          if (/Serving HTTP/.test(s)) {
            clearTimeout(timer);
            resolve(undefined);
          } else if (/Address already in use/i.test(s)) {
            clearTimeout(timer);
            fail(`port ${port} already in use`);
          }
        });
      });

      return {
        ok: true,
        url: `http://localhost:${port}/`,
        pid: child.pid,
        servedFrom: opts.sandbox.root,
      };
    },
  };
}

/**
 * validate_html — headless-browser sanity check.
 *
 * Opens `url` in a fresh Puppeteer page, waits for network idle, and returns
 * every `console.error`, `pageerror`, and failed network request observed.
 * This is the fix-loop signal the L1 worker needs to know whether the app it
 * just built actually runs.
 */
export function validateHtmlTool(opts: BuiltinToolOptions): BuiltinTool {
  // One shared browser per sandbox so we don't pay the 500ms+ launch cost on
  // every validation iteration.
  let sharedBrowser: Browser | null = null;
  const getBrowser = async (): Promise<Browser> => {
    if (sharedBrowser && sharedBrowser.connected) return sharedBrowser;
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    sharedBrowser = browser;
    opts.sandbox.onCleanup(async () => {
      try {
        await browser.close();
      } catch {
        /* already closed */
      }
    });
    return browser;
  };

  return {
    declaration: {
      name: 'validate_html',
      description: [
        'Load a URL in a real headless browser and report any runtime problems',
        '(console.error messages, uncaught page errors, failed subresource loads).',
        'Use this AFTER start_static_server to verify the app you built actually runs.',
        'Returns { ok: boolean, errors: [...], warnings: [...] }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'Absolute URL returned by start_static_server (e.g. "http://localhost:8000/").',
          },
          waitMs: {
            type: 'number',
            description:
              'Additional time to wait after network idle to catch async errors. Default 1500ms.',
          },
        },
        required: ['url'],
      },
    },
    async execute(args) {
      const url = expectString(args, 'url');
      const waitMs =
        typeof args['waitMs'] === 'number' && Number.isFinite(args['waitMs'])
          ? Math.max(0, Math.floor(args['waitMs'] as number))
          : 1500;

      const browser = await getBrowser();
      const page = await browser.newPage();
      const errors: string[] = [];
      const warnings: string[] = [];
      const failedRequests: Array<{ url: string; reason: string }> = [];

      page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error') errors.push(text);
        else if (type === 'warn') warnings.push(text);
      });
      page.on('pageerror', (err: unknown) => {
        errors.push(
          `pageerror: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      page.on('requestfailed', (req) => {
        failedRequests.push({
          url: req.url(),
          reason: req.failure()?.errorText ?? 'unknown',
        });
      });

      try {
        opts.logger?.info(`[tool:validate_html] loading ${url}`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 15_000 });
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        const title = await page.title();
        return {
          ok: errors.length === 0 && failedRequests.length === 0,
          url,
          title,
          errors,
          warnings,
          failedRequests,
        };
      } catch (err) {
        return {
          ok: false,
          url,
          errors: [
            ...errors,
            `navigation failed: ${(err as Error).message}`,
          ],
          warnings,
          failedRequests,
        };
      } finally {
        await page.close().catch(() => undefined);
      }
    },
  };
}

function expectString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new Error(`tool arg "${key}" must be a string, got ${typeof v}`);
  }
  return v;
}

/** Convenience: build the full default toolset. */
export function defaultBuiltinTools(opts: BuiltinToolOptions): BuiltinTool[] {
  return [
    writeFileTool(opts),
    readFileTool(opts),
    listFilesTool(opts),
    runShellTool(opts),
    startStaticServerTool(opts),
    validateHtmlTool(opts),
  ];
}
