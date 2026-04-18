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
        'Load a URL in a real headless browser and verify the app actually works.',
        'Captures console.error, pageerror, and failed subresource loads.',
        'OPTIONAL: pass `interactions` to simulate user input (clicks, right-clicks)',
        'at absolute page coordinates — this is how you detect silent bugs like',
        'elements that render but do not respond. OPTIONAL: pass `smoke`, a JS',
        'snippet evaluated in the page context after interactions; it must return',
        '{ ok: true } (or a truthy value) for the check to pass. For any',
        'interactive app you MUST use interactions + smoke to prove functionality,',
        'otherwise "no console errors" is meaningless.',
        'Returns { ok, errors, warnings, failedRequests, smokeResult?, interactionLog? }.',
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
          interactions: {
            type: 'array',
            description:
              'Sequence of user interactions to simulate AFTER the page loads. Mouse events (click/rightclick) or keyboard events (keydown/keyup/keypress). Use keypress with holdMs to simulate holding a key for a duration — essential for platformer-style inputs like "move right for 500ms while jumping".',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['click', 'rightclick', 'keydown', 'keyup', 'keypress'],
                  description:
                    'Event kind. "keypress" = keydown then keyup after holdMs.',
                },
                selector: {
                  type: 'string',
                  description:
                    'Mouse-only. CSS selector. If omitted, x/y are used as absolute page coordinates.',
                },
                x: {
                  type: 'number',
                  description:
                    'Mouse-only. Absolute X (CSS px) if no selector; otherwise offset within the selected element.',
                },
                y: { type: 'number' },
                key: {
                  type: 'string',
                  description:
                    'Keyboard-only. Key name e.g. "ArrowRight", "ArrowLeft", "Space", "w", "ArrowUp", "Enter".',
                },
                holdMs: {
                  type: 'number',
                  description:
                    'keypress-only. Time in ms between keydown and keyup. Default 120ms.',
                },
              },
              required: ['type'],
            },
          },
          smoke: {
            type: 'string',
            description:
              'JavaScript snippet evaluated in the page context after interactions. Must be an expression (not a function declaration). Should return { ok: boolean, details?: any } or any truthy value to pass. Example: "document.querySelectorAll(\\".revealed\\").length > 0".',
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
      const interactions = parseInteractions(args['interactions']);
      const smoke =
        typeof args['smoke'] === 'string' && args['smoke'].trim().length > 0
          ? args['smoke']
          : undefined;

      const browser = await getBrowser();
      const page = await browser.newPage();
      const errors: string[] = [];
      const warnings: string[] = [];
      const failedRequests: Array<{ url: string; reason: string }> = [];
      const interactionLog: string[] = [];

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
        opts.logger?.info(
          `[tool:validate_html] loading ${url}` +
            (interactions.length ? ` (+${interactions.length} interactions)` : '') +
            (smoke ? ' (+smoke)' : '')
        );
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 15_000 });
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

        for (const it of interactions) {
          try {
            if (it.type === 'click' || it.type === 'rightclick') {
              const coords = await resolveInteractionCoords(page, it);
              const button = it.type === 'rightclick' ? 'right' : 'left';
              await page.mouse.click(coords.x, coords.y, { button });
              interactionLog.push(
                `${it.type} at (${coords.x}, ${coords.y})${it.selector ? ` on ${it.selector}` : ''}`
              );
            } else if (it.type === 'keydown') {
              if (!it.key) throw new Error('keydown requires "key"');
              await page.keyboard.down(it.key as import('puppeteer').KeyInput);
              interactionLog.push(`keydown ${it.key}`);
            } else if (it.type === 'keyup') {
              if (!it.key) throw new Error('keyup requires "key"');
              await page.keyboard.up(it.key as import('puppeteer').KeyInput);
              interactionLog.push(`keyup ${it.key}`);
            } else if (it.type === 'keypress') {
              if (!it.key) throw new Error('keypress requires "key"');
              const holdMs =
                typeof it.holdMs === 'number' && Number.isFinite(it.holdMs)
                  ? Math.max(0, Math.floor(it.holdMs))
                  : 120;
              const key = it.key as import('puppeteer').KeyInput;
              await page.keyboard.down(key);
              await new Promise((r) => setTimeout(r, holdMs));
              await page.keyboard.up(key);
              interactionLog.push(`keypress ${it.key} (${holdMs}ms)`);
            }
            // Let listeners run / raf fire.
            await new Promise((r) => setTimeout(r, 80));
          } catch (err) {
            errors.push(
              `interaction ${it.type} failed: ${(err as Error).message}`
            );
          }
        }

        let smokeResult: unknown;
        let smokeOk = true;
        if (smoke) {
          try {
            smokeResult = await page.evaluate(
              // We wrap the snippet so callers can write either an expression
              // ("x > 0") or a full statement block ("const y=...; return y>0").
              `(() => { try { const __r = (${smoke}); return __r; } catch (e) { return { ok: false, error: String(e) }; } })()`
            );
            smokeOk = isSmokeOk(smokeResult);
            if (!smokeOk) {
              errors.push(
                `smoke check failed: ${JSON.stringify(smokeResult).slice(0, 500)}`
              );
            }
          } catch (err) {
            smokeOk = false;
            smokeResult = { error: (err as Error).message };
            errors.push(`smoke evaluation threw: ${(err as Error).message}`);
          }
        }

        const title = await page.title();
        return {
          ok: errors.length === 0 && failedRequests.length === 0 && smokeOk,
          url,
          title,
          errors,
          warnings,
          failedRequests,
          interactionLog,
          ...(smoke ? { smokeResult } : {}),
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
          interactionLog,
        };
      } finally {
        await page.close().catch(() => undefined);
      }
    },
  };
}

interface ParsedInteraction {
  type: 'click' | 'rightclick' | 'keydown' | 'keyup' | 'keypress';
  selector?: string;
  x?: number;
  y?: number;
  key?: string;
  holdMs?: number;
}

function parseInteractions(raw: unknown): ParsedInteraction[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedInteraction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const t = rec['type'];
    if (
      t !== 'click' &&
      t !== 'rightclick' &&
      t !== 'keydown' &&
      t !== 'keyup' &&
      t !== 'keypress'
    )
      continue;
    const parsed: ParsedInteraction = { type: t };
    if (typeof rec['selector'] === 'string' && rec['selector']) {
      parsed.selector = rec['selector'] as string;
    }
    if (typeof rec['x'] === 'number' && Number.isFinite(rec['x'])) {
      parsed.x = rec['x'] as number;
    }
    if (typeof rec['y'] === 'number' && Number.isFinite(rec['y'])) {
      parsed.y = rec['y'] as number;
    }
    if (typeof rec['key'] === 'string' && rec['key']) {
      parsed.key = rec['key'] as string;
    }
    if (typeof rec['holdMs'] === 'number' && Number.isFinite(rec['holdMs'])) {
      parsed.holdMs = rec['holdMs'] as number;
    }
    out.push(parsed);
  }
  return out;
}

async function resolveInteractionCoords(
  page: import('puppeteer').Page,
  it: ParsedInteraction
): Promise<{ x: number; y: number }> {
  if (it.selector) {
    const el = await page.$(it.selector);
    if (!el) throw new Error(`selector ${it.selector} not found`);
    const box = await el.boundingBox();
    if (!box) throw new Error(`selector ${it.selector} has no bounding box`);
    const offsetX = typeof it.x === 'number' ? it.x : box.width / 2;
    const offsetY = typeof it.y === 'number' ? it.y : box.height / 2;
    return { x: box.x + offsetX, y: box.y + offsetY };
  }
  if (typeof it.x !== 'number' || typeof it.y !== 'number') {
    throw new Error('interaction without selector needs absolute x and y');
  }
  return { x: it.x, y: it.y };
}

function isSmokeOk(result: unknown): boolean {
  if (result === undefined || result === null) return false;
  if (typeof result === 'boolean') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if ('ok' in r) return Boolean(r['ok']);
    return true;
  }
  return Boolean(result);
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
