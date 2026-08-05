import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import type { Tool, Logger } from '../core/types.js';
import { sandboxChildEnv, type ToolSandbox } from './sandbox.js';
import puppeteer, { type Browser } from 'puppeteer';

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

/**
 * Targeted in-place edit — the cost-discipline counterpart to
 * `write_file`. Revision cycles used to re-emit ENTIRE files through
 * `write_file` (full content billed as output tokens on every retouch,
 * the dominant spend of long L1 tool loops); a str_replace edit only
 * emits the changed spans. Contract mirrors the classic str_replace
 * tool: `old_string` must match EXACTLY and be UNIQUE in the file —
 * 0 matches or >1 matches error out with a coaching message (pass
 * `replace_all: true` to substitute every occurrence instead).
 */
export function editFileTool(opts: BuiltinToolOptions): BuiltinTool {
  return {
    declaration: {
      name: 'edit_file',
      description:
        'Replace an exact text span inside an existing workspace file. PREFER this over write_file when MODIFYING a file — you only emit the changed text, not the whole content. `old_string` must match exactly (including whitespace) and be unique in the file; set replace_all=true to substitute every occurrence. Use relative paths only.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the workspace.' },
          old_string: {
            type: 'string',
            description: 'Exact existing text to replace (must be unique unless replace_all).',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text (may be empty to delete the span).',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence instead of requiring a unique match.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async execute(args) {
      const path = expectString(args, 'path');
      const oldString = expectString(args, 'old_string');
      const newString = typeof args['new_string'] === 'string' ? (args['new_string'] as string) : '';
      const replaceAll = args['replace_all'] === true;
      if (oldString.length === 0) {
        throw new Error('edit_file: old_string must be non-empty (to create a file, use write_file)');
      }
      if (oldString === newString) {
        throw new Error('edit_file: old_string and new_string are identical — nothing to do');
      }
      const abs = opts.sandbox.resolve(path);
      if (!existsSync(abs)) {
        throw new Error(`edit_file: no such file "${path}" — use write_file to create it first`);
      }
      const content = readFileSync(abs, 'utf8');
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `edit_file: old_string not found in "${path}". It must match the file EXACTLY, including whitespace and indentation — read_file the current content and retry with a verbatim span.`
        );
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `edit_file: old_string matches ${occurrences} times in "${path}" — extend it with surrounding context to make it unique, or pass replace_all=true.`
        );
      }
      const next = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      writeFileSync(abs, next, 'utf8');
      opts.logger?.info(
        `[tool:edit_file] ${path} (${replaceAll ? occurrences : 1} replacement${occurrences > 1 && replaceAll ? 's' : ''}, ${next.length} bytes)`
      );
      return { ok: true, path, replacements: replaceAll ? occurrences : 1, bytes: next.length };
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
        // lstat, never stat: statSync FOLLOWS symlinks, so a dangling link
        // in the workspace threw ENOENT and took down the whole listing —
        // including the read-back probe (the zero-token verification
        // spine) on an otherwise valid deliverable. A symlink is reported
        // as its own kind; consumers treat it as opaque.
        const st = lstatSync(full);
        return {
          name,
          kind: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
          size: st.size,
        };
      });
      return { path: rel, entries };
    },
  };
}

export function runShellTool(opts: BuiltinToolOptions): BuiltinTool {
  const allowlist = new Set(
    // `bash` is on the default list specifically so `kind: 'script'`
    // skills with `language: 'bash'` can be invoked via run_shell.
    // The skill body still runs inside the ToolSandbox jail (cwd
    // pinned, no network egress beyond what fetch_url declares), so
    // adding bash here doesn't broaden the blast radius of run_shell —
    // a determined LLM could already chain shell-equivalent flows via
    // node -e or python3 -c.
    opts.shellAllowlist ?? ['node', 'npm', 'npx', 'python3', 'bash', 'ls', 'cat', 'echo', 'which']
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
      // Spawned in its OWN PROCESS GROUP (`detached: true`, POSIX pgid ==
      // child pid) and the WHOLE GROUP is SIGKILLed once the command
      // finishes or times out. This makes the declared contract ("do NOT
      // use this for long-running processes") enforceable: with the old
      // promisified execFile, `bash -c "python3 -m http.server 0 &"`
      // double-forked — bash exited 0, the server survived as an orphan
      // outside the sandbox's tracked-children list, squatted its port for
      // DAYS, and every later web run burned boot retries against it
      // (observed: two http.servers from a Saturday session still alive
      // the following Tuesday, one of them on port 8000). execFile's own
      // timeout has the same blind spot: it signals the child only, never
      // the grandchildren.
      return await new Promise((resolvePromise) => {
        const child = spawn(command, argv, {
          cwd: opts.sandbox.root,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          // Model-authored code must never see the parent's secrets
          // (ANTHROPIC_API_KEY et al.) — allowlisted env only.
          env: sandboxChildEnv(),
        });
        opts.sandbox.trackChild(child);

        const MAX_BUFFER = 2 * 1024 * 1024;
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout?.on('data', (c: Buffer) => {
          if (stdout.length < MAX_BUFFER) stdout += c.toString();
        });
        child.stderr?.on('data', (c: Buffer) => {
          if (stderr.length < MAX_BUFFER) stderr += c.toString();
        });

        const killGroup = (): void => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* group already gone (or non-POSIX) — fall through */
          }
          try {
            child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, timeoutMs);

        child.once('error', (err) => {
          clearTimeout(timer);
          killGroup();
          resolvePromise({ exitCode: 1, stdout, stderr: stderr || err.message, error: err.message });
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          // The command itself is done — reap any grandchildren it left
          // behind (`&`-backgrounded servers and the like). By contract
          // they do not belong to run_shell's lifetime.
          killGroup();
          if (timedOut) {
            resolvePromise({
              exitCode: 1,
              stdout,
              stderr,
              error: `run_shell: timed out after ${timeoutMs}ms (process group killed)`,
            });
          } else {
            resolvePromise({
              exitCode: code ?? (signal ? 1 : 0),
              stdout,
              stderr,
              ...(signal ? { error: `terminated by ${signal}` } : {}),
            });
          }
        });
      });
    },
  };
}


/**
 * Ask the OS for a free port by binding a throwaway net.Server on port 0
 * and closing it. Used by start_static_server: python prints its
 * "Serving HTTP on :: port N" line to STDOUT, which is BLOCK-BUFFERED when
 * piped — parsing the assigned port out of a port=0 child was structurally
 * unreliable (measured: 100% of port=0 boots timed out; the model then
 * burned LLM round-trips retrying with hard-coded ports). Binding
 * in-process gets a concrete port the OS just handed out; the close→spawn
 * race window is real but tiny, and the EADDRINUSE retry path covers
 * exactly that loss.
 */
function osAssignedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

export function startStaticServerTool(opts: BuiltinToolOptions): BuiltinTool {
  return {
    declaration: {
      name: 'start_static_server',
      description:
        'Start a static HTTP server (python3 -m http.server) in the background that serves the workspace root, and return the URL to access it. Pass port=0 (or omit) to let the OS pick a free port — required when several subtasks may call this tool in parallel. The server runs until the process exits.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description:
              'Port to listen on. Defaults to 0 (OS-assigned). Pass a fixed port only when you must; parallel subtasks MUST leave it unset to avoid "Address already in use" clashes.',
          },
        },
      },
    },
    async execute(args) {
      const requestedPort =
        typeof args['port'] === 'number' && Number.isFinite(args['port'])
          ? Math.floor(args['port'] as number)
          : 0;

      // Try the caller's requested port first; if it's taken, kill the
      // failing child and retry ONCE with port=0 (OS-assigned). This way
      // an LLM that hard-codes 8000 never blocks the run just because a
      // stale server from a previous run is still squatting that port.
      //
      // Boot timeouts (ms):
      //   - initial attempt: 3s. Cold-boot Python can take >1.5s on some
      //     machines (measured ~2s on macOS when python3 is freshly
      //     invoked). A too-tight cap made the post-EADDRINUSE retry race
      //     the Python startup and time out spuriously in earlier runs.
      //   - retry attempt: 5s. We already paid the cost of one failure;
      //     give the OS-assigned port extra headroom so we don't force
      //     the LLM to re-enter the tool a third time.
      // Since the Serving-line match became reliable (-u + both streams +
      // accumulation), the timer is only the silent-but-alive FALLBACK —
      // healthy boots resolve on the match, dead children fail on exit.
      // So the timers can afford to cover slow interpreters: a pyenv
      // python3 measured ~5.2s to first output, and the old 3s timer
      // fired mid-boot, reporting a port as ready ~2s before the server
      // actually bound it (a race the old code hid by never confirming
      // port=0 boots at all).
      const INITIAL_BOOT_TIMEOUT_MS = 8000;
      const RETRY_BOOT_TIMEOUT_MS = 10_000;
      const attempt = async (
        portToUse: number,
        isRetry: boolean
      ): Promise<{
        ok: true;
        url: string;
        port: number;
        pid: number | undefined;
        servedFrom: string;
        retriedFromPort?: number;
      }> => {
        // port=0 is resolved IN-PROCESS (see osAssignedPort) so the child
        // is always told a concrete port — we never need to parse the
        // OS-assigned port out of python's buffered stdout.
        const concretePort = portToUse === 0 ? await osAssignedPort() : portToUse;
        const child = spawn(
          'python3',
          // -u: unbuffered stdio, so the "Serving" line arrives as soon as
          // python prints it instead of sitting in a 4k block buffer.
          ['-u', '-m', 'http.server', String(concretePort)],
          {
            cwd: opts.sandbox.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            // Own process group, like run_shell (#7c): a server that forks
            // workers/watchers must not leave grandchildren behind when the
            // sandbox reaps it — detached:false let a double-forked child
            // escape BOTH cleanup() and the global exit reaper (the exact
            // multi-day orphan class #7c closed for run_shell only).
            detached: true,
            env: sandboxChildEnv(),
          }
        );
        opts.sandbox.trackChild(child);

        const bootTimeoutMs = isRetry ? RETRY_BOOT_TIMEOUT_MS : INITIAL_BOOT_TIMEOUT_MS;
        const actualPort = await new Promise<number>((resolve, reject) => {
          let settled = false;
          // ACCUMULATED buffers, per stream: the Serving line can straddle
          // a chunk boundary, and python emits it on stdout (stderr kept
          // for older/altered pythons and for the EADDRINUSE message).
          let outBuf = '';
          let errBuf = '';
          const fail = (msg: string, kind?: 'eaddrinuse'): void => {
            if (settled) return;
            settled = true;
            const err = new Error(msg) as Error & { kind?: 'eaddrinuse' };
            if (kind) err.kind = kind;
            try {
              child.kill('SIGTERM');
            } catch {
              /* already dead */
            }
            reject(err);
          };
          const succeed = (port: number): void => {
            if (settled) return;
            settled = true;
            resolve(port);
          };
          const timer = setTimeout(() => {
            // The child is alive (exit would have failed fast below) but
            // never printed a recognisable Serving line. Assume it bound
            // the port we told it — the old fixed-port semantics — rather
            // than killing a probably-working server.
            succeed(concretePort);
          }, bootTimeoutMs);
          const scan = (): void => {
            const all = outBuf + '\n' + errBuf;
            const match = all.match(/Serving HTTP on [^ ]+ port (\d+)/);
            if (match && match[1]) {
              clearTimeout(timer);
              succeed(Number(match[1]));
            } else if (/Address already in use/i.test(all)) {
              clearTimeout(timer);
              fail(`port ${concretePort} already in use`, 'eaddrinuse');
            }
          };
          child.stdout?.on('data', (chunk: Buffer) => {
            outBuf = (outBuf + chunk.toString()).slice(-4096);
            scan();
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            errBuf = (errBuf + chunk.toString()).slice(-4096);
            scan();
          });
          child.once('error', (err) => {
            clearTimeout(timer);
            fail(`server failed to start: ${err.message}`);
          });
          // A child that DIES before serving must fail fast and loudly —
          // the old code let the boot timer expire and, on a fixed port,
          // report ok:true with a dead URL into the validation chain.
          child.once('exit', (code) => {
            clearTimeout(timer);
            if (/Address already in use/i.test(errBuf + outBuf)) {
              fail(`port ${concretePort} already in use`, 'eaddrinuse');
            } else {
              const tail = (errBuf + outBuf).slice(-300).trim();
              fail(
                `server exited with code ${code} before serving` +
                  (tail ? ` — output tail: ${tail}` : '')
              );
            }
          });
        });

        opts.logger?.info(
          `[tool:start_static_server] python3 http.server :${actualPort} in ${opts.sandbox.root}` +
            (isRetry ? ` (auto-retry after ${requestedPort} was busy)` : '')
        );

        return {
          ok: true,
          url: `http://localhost:${actualPort}/`,
          port: actualPort,
          pid: child.pid,
          servedFrom: opts.sandbox.root,
          ...(isRetry ? { retriedFromPort: requestedPort } : {}),
        };
      };

      try {
        return await attempt(requestedPort, false);
      } catch (err) {
        const e = err as Error & { kind?: 'eaddrinuse' };
        if (e.kind === 'eaddrinuse' && requestedPort > 0) {
          opts.logger?.warn(
            `[tool:start_static_server] port ${requestedPort} busy — retrying on OS-assigned port`
          );
          return await attempt(0, true);
        }
        throw err;
      }
    },
  };
}

/**
 * fetch_url — issue an HTTP(S) request and return status/headers/body.
 *
 * The companion tool to `start_node_server`: once an L1 has booted a Node
 * HTTP server, it needs a way to probe the endpoints it just wrote (GET
 * /health, POST /users with a body, etc.) so the validate-and-fix loop
 * has a signal to iterate on. `fetch_url` is the L1-tier analogue of
 * `validate_html` for headless web artefacts: small, focused, and
 * purpose-built to feed the supervise-loop.
 *
 * Notes:
 *   - Body is returned as a UTF-8 STRING. JSON parsing is the caller's
 *     job — keeps the tool surface small and avoids silently dropping
 *     non-JSON responses (HTML error pages, plain-text 404 bodies).
 *   - No URL allowlist: callers need to hit arbitrary URLs (localhost
 *     for probing their own server, real APIs for mocked integrations).
 *     The sandbox still confines filesystem + child processes; network
 *     is intentionally open.
 *   - Hard timeout defaults to 10s. A Node server that doesn't answer
 *     an HTTP request within 10s is almost certainly broken, and the
 *     L1 loop should see "timeout" as a fix signal rather than wait
 *     30s+ and exhaust its tool budget.
 */
export function fetchUrlTool(opts: BuiltinToolOptions): BuiltinTool {
  const DEFAULT_TIMEOUT_MS = 10_000;
  return {
    declaration: {
      name: 'fetch_url',
      description: [
        'Issue an HTTP(S) request to any URL (localhost for probing your own server, or external APIs).',
        'Returns { status, headers, body }. Body is a UTF-8 string — parse JSON yourself if you need it.',
        'Use this AFTER start_node_server to verify the endpoints you just wrote actually answer correctly.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL, e.g. "http://localhost:3000/health".' },
          method: {
            type: 'string',
            description: 'HTTP method (GET|POST|PUT|PATCH|DELETE). Defaults to GET.',
          },
          body: {
            type: ['string', 'object'],
            description:
              'Request body. If an object is passed, it is JSON-stringified and Content-Type defaults to application/json.',
          },
          headers: {
            type: 'object',
            description: 'Additional request headers as a flat string→string map.',
          },
          timeoutMs: {
            type: 'number',
            description: `Request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          },
        },
        required: ['url'],
      },
    },
    async execute(args) {
      const url = expectString(args, 'url');
      const methodRaw = typeof args['method'] === 'string' ? args['method']!.toUpperCase() : 'GET';
      const method = methodRaw;
      const timeoutMs =
        typeof args['timeoutMs'] === 'number' && Number.isFinite(args['timeoutMs'])
          ? (args['timeoutMs'] as number)
          : DEFAULT_TIMEOUT_MS;

      const rawHeaders =
        args['headers'] && typeof args['headers'] === 'object' && !Array.isArray(args['headers'])
          ? (args['headers'] as Record<string, unknown>)
          : {};
      const headers = new Headers();
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === 'string') headers.set(k, v);
      }

      let bodyInit: string | undefined;
      if (args['body'] !== undefined && args['body'] !== null) {
        if (typeof args['body'] === 'string') {
          bodyInit = args['body'];
        } else if (typeof args['body'] === 'object') {
          bodyInit = JSON.stringify(args['body']);
          if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      opts.logger?.info(`[tool:fetch_url] ${method} ${url}`);
      try {
        const res = await fetch(url, {
          method,
          headers,
          ...(bodyInit !== undefined ? { body: bodyInit } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });
        return {
          ok: res.ok,
          status: res.status,
          headers: respHeaders,
          body: text,
        };
      } catch (err) {
        const e = err as Error & { name?: string };
        if (e.name === 'AbortError') {
          return {
            ok: false,
            error: `fetch_url timed out after ${timeoutMs}ms`,
            timeout: true,
          };
        }
        return { ok: false, error: e.message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * start_node_server — spawn a long-running Node process that listens on
 * an OS-assigned port and return its URL.
 *
 * The tier-1 counterpart to `start_static_server` for HTTP API builds.
 * L1 writes an Express/native-http server into a JS file, starts it
 * via this tool, then probes it with `fetch_url`. Same process-tracking
 * machinery as `start_static_server` — the module-level exit handler
 * in `sandbox.ts` SIGKILLs orphaned children even on crash-exit paths.
 *
 * Port discovery contract:
 *   - The tool injects `PORT=0` into the child's env (standard Node
 *     convention: the server binds to an OS-assigned port by reading
 *     `process.env.PORT`).
 *   - The L1's server code MUST emit the literal line
 *         LISTENING_ON_PORT=<N>
 *     on stdout once it has successfully bound. Example:
 *         const srv = app.listen(Number(process.env.PORT) || 0, () => {
 *           const p = srv.address().port;
 *           console.log('LISTENING_ON_PORT=' + p);
 *         });
 *     We do not parse Express's default "Listening on 3000" or arbitrary
 *     "Server running at ..." strings — the explicit marker is the only
 *     contract, and L1 is told about it via the canonical HTTP prompt.
 *   - If the child exits before emitting the marker (e.g. a syntax
 *     error, a missing dep), the tool returns { ok: false, stderr } so
 *     the L1 loop gets a concrete signal.
 */
export function startNodeServerTool(opts: BuiltinToolOptions): BuiltinTool {
  const BOOT_TIMEOUT_MS = 8_000;
  return {
    declaration: {
      name: 'start_node_server',
      description: [
        'Spawn `node <entry>` as a background process with PORT=0 (OS-assigned) and return the bound URL.',
        'The server MUST emit the literal line "LISTENING_ON_PORT=<port>" on stdout once it has bound.',
        'Example listener:',
        '  app.listen(Number(process.env.PORT) || 0, function(){ console.log("LISTENING_ON_PORT=" + this.address().port); });',
        'The server runs until the run exits (sandbox cleanup SIGKILLs it).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          entry: {
            type: 'string',
            description: 'Relative path to the Node entry file (e.g. "index.js", "server.js").',
          },
          env: {
            type: 'object',
            description:
              'Extra environment variables passed to the child process (merged over PORT=0 and the parent env).',
          },
        },
        required: ['entry'],
      },
    },
    async execute(args) {
      const entry = expectString(args, 'entry');
      const entryAbs = opts.sandbox.resolve(entry);
      const extraEnv =
        args['env'] && typeof args['env'] === 'object' && !Array.isArray(args['env'])
          ? (args['env'] as Record<string, unknown>)
          : {};
      // Allowlisted base env (no parent secrets), PORT=0 for OS-assigned
      // port discovery, then the model-supplied extras on top — those are
      // task config (API keys the TASK owns, feature flags), not ours.
      const env: NodeJS.ProcessEnv = sandboxChildEnv({ PORT: '0' });
      for (const [k, v] of Object.entries(extraEnv)) {
        if (typeof v === 'string') env[k] = v;
      }

      const child = spawn('node', [entryAbs], {
        cwd: opts.sandbox.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group — same rationale as start_static_server above.
        detached: true,
        env,
      });
      opts.sandbox.trackChild(child);

      let stderrBuf = '';
      const port = await new Promise<number>((resolve, reject) => {
        const fail = (msg: string): void => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already dead */
          }
          reject(new Error(msg));
        };
        const timer = setTimeout(() => {
          fail(
            `node server did not emit LISTENING_ON_PORT=<N> within ${BOOT_TIMEOUT_MS}ms. stderr: ${stderrBuf.slice(0, 400)}`
          );
        }, BOOT_TIMEOUT_MS);

        child.once('error', (err) => {
          clearTimeout(timer);
          fail(`node server failed to start: ${err.message}`);
        });
        child.once('exit', (code) => {
          // Only relevant if this fires before we've seen the marker.
          clearTimeout(timer);
          fail(
            `node server exited early (code=${code}). stderr: ${stderrBuf.slice(0, 400)}`
          );
        });
        let stdoutBuf = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          // ACCUMULATE before matching: the marker can straddle a chunk
          // boundary ('LISTENING_ON_PORT=51' + '324'), and a per-chunk
          // match would then bind fetch_url to a WRONG (dead) port —
          // worse than a timeout, because it looks like a server bug.
          stdoutBuf = (stdoutBuf + chunk.toString()).slice(-4096);
          const match = stdoutBuf.match(/LISTENING_ON_PORT=(\d+)(?!\d)/);
          if (match && match[1]) {
            clearTimeout(timer);
            // Detach the early-exit listener — the server is up now,
            // subsequent exits are the sandbox cleanup's job.
            child.removeAllListeners('exit');
            resolve(Number(match[1]));
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString();
        });
      });

      opts.logger?.info(
        `[tool:start_node_server] node ${entry} :${port} in ${opts.sandbox.root}`
      );

      return {
        ok: true,
        url: `http://localhost:${port}/`,
        port,
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

  const stuck = makeSmokeStuckTracker(SMOKE_STUCK_WINDOW);

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
              'Additional time to wait after DOM ready to catch async errors (rAF, fetch chains, late scripts). Default 500ms — bump this explicitly when the app does non-trivial work on load.',
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
              'JavaScript EXPRESSION evaluated in the page context after interactions (wrapped internally as `(() => { const __r = (YOUR_CODE); ... })()` — it CANNOT start with `const`, `let`, `return`, `function`, or contain top-level `;`-separated statements). Should return { ok: boolean, details?: any } or any truthy value to pass. Simple form: `document.querySelectorAll(".revealed").length > 0`. For logic that needs locals, wrap in an IIFE: `(() => { const x = compute(); return x > 0 })()`. For state-heavy apps (games, etc.), EXPOSE A `window.__test` helper from the app and call it here — do NOT try to simulate inputs that need domain-specific knowledge (e.g. a specific winning chess move).',
          },
        },
        required: ['url'],
      },
    },
    async execute(args) {
      const url = expectString(args, 'url');
      // Default post-load settle reduced 1500 → 500ms. For local static
      // HTML served by start_static_server, 500ms is enough to let
      // DOMContentLoaded handlers run and any same-tick rAF fire.
      // Heavier apps (fetch chains during onload) can still bump this
      // explicitly via the `waitMs` arg.
      const waitMs =
        typeof args['waitMs'] === 'number' && Number.isFinite(args['waitMs'])
          ? Math.max(0, Math.floor(args['waitMs'] as number))
          : 500;
      const interactions = parseInteractions(args['interactions']);
      const smoke =
        typeof args['smoke'] === 'string' && args['smoke'].trim().length > 0
          ? args['smoke']
          : undefined;

      // Cheap pre-flight check on the smoke snippet. The tool wraps it as
      // `(() => { try { const __r = (${smoke}); return __r; } ... })()`
      // which requires `smoke` to be an EXPRESSION — a top-level `const`,
      // `let`, `function` declaration, or bare `return` inside the parens
      // is a syntax error ("Unexpected token 'const'") that we can catch
      // locally without paying the Puppeteer round-trip. Observed in
      // production: three ~4s validate_html calls burned purely on
      // `smoke evaluation threw: Unexpected token 'const'`. Rejecting
      // here also teaches the model the right pattern via a clear error
      // instead of an opaque "unexpected token".
      if (smoke !== undefined) {
        const syntax = detectSmokeStatementError(smoke);
        if (syntax) {
          return {
            ok: false,
            url,
            errors: [`smoke rejected pre-flight: ${syntax}`],
            warnings: [],
            failedRequests: [],
            interactionLog: [],
            smokeResult: { error: syntax, hint: SMOKE_EXPR_HINT },
          };
        }
      }

      // Same-smoke-stuck short-circuit. If the model has been retrying
      // the exact same smoke assertion against the same app and it keeps
      // failing, more Puppeteer rounds won't help — the assertion is
      // structurally unreachable (needs inputs the model can't
      // reproduce, or references a state that the app never enters).
      // Observed in production: 15+ consecutive calls on a chess puzzle
      // asserting `statusText.includes('Checkmate')` after random
      // clicks that couldn't produce a mate. We surface a coaching
      // error instead of running Puppeteer yet again.
      if (smoke !== undefined && stuck.isStuck(smoke)) {
        return {
          ok: false,
          url,
          errors: [
            `smoke stuck: this assertion has failed at least ${SMOKE_STUCK_THRESHOLD} times within the last ${SMOKE_STUCK_WINDOW} calls. ` +
              SMOKE_STUCK_HINT,
          ],
          warnings: [],
          failedRequests: [],
          interactionLog: [],
          smokeResult: { error: 'stuck', hint: SMOKE_STUCK_HINT },
        };
      }

      // Oscillation short-circuit (#2). If the SAME smoke has both
      // passed and failed in the window, the assertion itself is
      // non-deterministic — a sporadic pass is not a real signal, and
      // the L1 is likely going to declare victory on one of those
      // passes while the supervisor's ground-truth probe sees a fail
      // state (observed on the backgammon timeout run: internal smoke
      // oscillated ok/fail while the supervisor kept rejecting with a
      // 404 it couldn't escape from). We stop the loop and surface a
      // coaching error distinct from the isStuck one.
      if (smoke !== undefined && stuck.isOscillating(smoke)) {
        return {
          ok: false,
          url,
          errors: [
            `smoke non-deterministic: this assertion produced BOTH passes AND failures within the last ${SMOKE_STUCK_WINDOW} calls against the same page. ` +
              SMOKE_OSCILLATION_HINT,
          ],
          warnings: [],
          failedRequests: [],
          interactionLog: [],
          smokeResult: { error: 'oscillating', hint: SMOKE_OSCILLATION_HINT },
        };
      }

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
        // `domcontentloaded` waits only for HTML parse — adequate for
        // local static files, which are what start_static_server serves.
        // The earlier `networkidle0` wait was 500ms+ of guaranteed idle
        // on top of the load, burning ~1s per call × 15-25 calls per
        // run of pure overhead. Callers can still ask for more settle
        // time via `waitMs` when they know the page kicks off async
        // work (e.g. fetch during onload).
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
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
          // Record outcome for the stuck-detector above.
          stuck.record(smoke, smokeOk);
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

/**
 * History length over which the stuck-smoke detector counts failures.
 * Kept at module level so tests and the error-message text stay in sync.
 *
 * Previous version used a strict "N CONSECUTIVE identical failures"
 * window. The model learned to route around it by interleaving a
 * trivially-passing sanity smoke between real-assertion retries
 * (observed: 5 occurrences of the same failing smoke across 9 calls
 * but never 3 in a row, so the detector never fired). Switching to
 * "N failing occurrences within the last WINDOW calls" is immune to
 * that gaming pattern — the model cannot accumulate N failures of the
 * same assertion without tripping the guard, regardless of what it
 * interleaves.
 */
export const SMOKE_STUCK_WINDOW = 10;

/**
 * Minimum cumulative failures of the same normalised smoke inside the
 * sliding window before the detector flips to stuck.
 */
export const SMOKE_STUCK_THRESHOLD = 3;

/**
 * Bounded tracker for "the same smoke assertion keeps failing across
 * a short history window". Returns a small imperative handle:
 *   - `record(smoke, ok)` — register the outcome of the most recent
 *     Puppeteer evaluation. Whitespace is normalised so minor
 *     formatting tweaks still count as the same assertion.
 *   - `isStuck(smoke)` — returns true when the LAST `windowSize`
 *     recorded outcomes contain at least `failureThreshold` FAILURES
 *     that share the same normalised smoke body as the argument.
 *     Interleaving an unrelated passing smoke between attempts does
 *     NOT reset the count — the model cannot game the detector by
 *     spacing out retries.
 *
 * Defaults: `SMOKE_STUCK_WINDOW` (10) and `SMOKE_STUCK_THRESHOLD` (3).
 * Exported for unit tests.
 */
export function makeSmokeStuckTracker(
  opts:
    | { windowSize: number; failureThreshold: number }
    | number = { windowSize: SMOKE_STUCK_WINDOW, failureThreshold: SMOKE_STUCK_THRESHOLD }
): {
  record: (smoke: string, ok: boolean) => void;
  isStuck: (smoke: string) => boolean;
  /**
   * Inconsistency detector (#2): returns true when the same normalised
   * smoke assertion has BOTH passed AND failed within the window. That
   * pattern is NOT the "same assertion fails N times" pattern isStuck
   * catches — it's the subtler "smoke gives sporadic success between
   * real failures", observed on the backgammon timeout run where
   * Hydrogen declared the run successful after a sporadic pass even
   * though the supervisor's ground-truth probe kept reporting a 404.
   * A sporadic-pass smoke is a BUG in the smoke design (e.g. the
   * assertion depends on timing or side-effects that aren't
   * deterministically seeded), not valid progress signal. We surface a
   * targeted coaching hint (distinct from the isStuck one) so the
   * model knows to swap to a deterministic `window.__test` hook
   * rather than keep retrying.
   */
  isOscillating: (smoke: string) => boolean;
} {
  // Backwards-compatible: a number is interpreted as windowSize with
  // failureThreshold defaulting to the module constant. Tests and
  // older call sites that pass a single `number` keep working.
  const { windowSize, failureThreshold } =
    typeof opts === 'number'
      ? { windowSize: opts, failureThreshold: SMOKE_STUCK_THRESHOLD }
      : opts;
  const history: Array<{ normalized: string; ok: boolean }> = [];
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return {
    record(smoke, ok): void {
      history.push({ normalized: normalize(smoke), ok });
      if (history.length > windowSize) history.shift();
    },
    isStuck(smoke): boolean {
      const target = normalize(smoke);
      let failures = 0;
      for (const h of history) {
        if (h.normalized === target && !h.ok) failures++;
      }
      return failures >= failureThreshold;
    },
    isOscillating(smoke): boolean {
      const target = normalize(smoke);
      let passes = 0;
      let fails = 0;
      for (const h of history) {
        if (h.normalized !== target) continue;
        if (h.ok) passes++;
        else fails++;
      }
      // Require at least one of each AND at least 3 total occurrences
      // of the same smoke — a single pass followed by a single fail is
      // often just the natural "validate -> fix -> re-validate" loop
      // and shouldn't trip the detector. Three or more occurrences
      // with BOTH polarities is the signature of a non-deterministic
      // assertion.
      return passes > 0 && fails > 0 && passes + fails >= 3;
    },
  };
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

/**
 * Shared coaching hints, reused by the pre-flight and stuck-smoke
 * branches so the L1 narrow prompt and the tool error channel speak the
 * same language. Kept at module level so the strings are identical to
 * the examples in `buildNarrowL1Prompt`.
 */
const SMOKE_EXPR_HINT =
  'The `smoke` arg must be a JS EXPRESSION, not a statement. It is ' +
  'wrapped as `(() => { const __r = (YOUR_CODE); ... })()`. A top-level ' +
  '`const` / `let` / `return` breaks parsing. Wrap any logic in an IIFE, ' +
  'e.g. `(() => { const x = computeIt(); return x > 0 })()`.';

const SMOKE_STUCK_HINT =
  'Change your strategy rather than retry the same assertion. Options: ' +
  '(1) expose a deterministic test hook from your app code — e.g. ' +
  '`window.__test = { solveMateIn1: () => boolean, forceState: (fen) => void }` ' +
  '— and call it from smoke so you do not need to simulate fragile ' +
  'click/keyboard inputs; (2) if the assertion needs domain-specific ' +
  'state (a specific chess position, a specific game step), seed that ' +
  'state from the smoke IIFE directly; (3) accept the functionality as ' +
  'verified by a simpler invariant (element exists + renders) and move ' +
  'on — you do not need end-to-end gameplay in a smoke check.';

const SMOKE_OSCILLATION_HINT =
  'Your smoke assertion is NON-DETERMINISTIC: it passed at least once ' +
  'AND failed at least once against the same page within this session. ' +
  'A sporadic pass is NOT a validation signal — the supervisor\'s ' +
  'independent ground-truth probe will re-run the page and either see ' +
  'the fail state or a different issue entirely, rejecting your ' +
  'result. Stop retrying. Root-cause options: (1) the assertion ' +
  'depends on TIMING (animation frame, setTimeout, fetch) — wrap it ' +
  'in a deterministic wait or a window.__test hook that the app ' +
  'updates synchronously; (2) the assertion depends on an INIT side-' +
  'effect that isn\'t seeded before the check — initialise the state ' +
  'from the smoke IIFE before asserting; (3) the assertion is racing ' +
  'against the server boot — add a window.__test hook that the app ' +
  'flips only after it\'s fully ready, and assert that flag first.';

/**
 * Quick lexical check: does the smoke snippet look like a top-level
 * STATEMENT (which won't parse inside `(${smoke})`) rather than an
 * expression? We don't do a full JS parse — we look for the leading
 * keywords that produce the "Unexpected token 'const'" class of errors.
 * An IIFE (`(function(){...})()`) or `(() => ...)` passes fine because
 * it starts with `(`, not with `const`/`let`/`return`/etc.
 *
 * Exported for unit tests — consumers should use the pre-flight path
 * inside `validateHtmlTool.execute` rather than call this directly.
 */
export function detectSmokeStatementError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Banned leaders. These patterns fire ONLY when the snippet starts
  // with the keyword at top-level — anything inside a balanced
  // `( ... )` or `{ ... }` is fine because the wrapper already makes
  // that a nested scope.
  const leaderPatterns: Array<{ re: RegExp; keyword: string }> = [
    { re: /^const\s/, keyword: 'const' },
    { re: /^let\s/, keyword: 'let' },
    { re: /^var\s/, keyword: 'var' },
    { re: /^return\s/, keyword: 'return' },
    { re: /^function\s/, keyword: 'function declaration' },
    { re: /^if\s*\(/, keyword: 'if' },
    { re: /^for\s*\(/, keyword: 'for' },
    { re: /^while\s*\(/, keyword: 'while' },
    { re: /^throw\s/, keyword: 'throw' },
  ];
  for (const { re, keyword } of leaderPatterns) {
    if (re.test(trimmed)) {
      return `smoke starts with top-level \`${keyword}\` — that is a STATEMENT, not an expression.`;
    }
  }
  // Multi-line snippets that separate statements with `;` at the top
  // level (e.g. `const x = 1; x > 0`) are also statements. Heuristic:
  // if the snippet contains a naked `;` that isn't inside any bracket
  // AND is not the very last non-whitespace char, it's almost certainly
  // a statement-series masquerading as an expression.
  if (hasTopLevelStatementSeparator(trimmed)) {
    return 'smoke contains a top-level `;` — that indicates separate statements. Wrap the whole thing in an IIFE: `(() => { ...; return X })()`.';
  }
  return null;
}

/**
 * Scan `s` for a `;` at depth 0 (not inside `()`, `[]`, or `{}`) that
 * is followed by non-whitespace. Used to catch statement-series where
 * the author forgot to wrap in an IIFE.
 */
function hasTopLevelStatementSeparator(s: string): boolean {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      // Is there non-whitespace AFTER this `;`?
      for (let j = i + 1; j < s.length; j++) {
        if (!/\s/.test(s[j]!)) return true;
      }
      return false;
    }
  }
  return false;
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
    editFileTool(opts),
    readFileTool(opts),
    listFilesTool(opts),
    runShellTool(opts),
    startStaticServerTool(opts),
    validateHtmlTool(opts),
    fetchUrlTool(opts),
    startNodeServerTool(opts),
  ];
}
