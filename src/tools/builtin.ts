import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import type { Tool, Logger } from '../core/types.js';
import { sandboxChildEnv, type ToolSandbox } from './sandbox.js';
import {
  DECORATED_CMD_RE,
  PORT_BEARING_STDOUT_RE,
  PROBE_MANIFEST_FILENAME,
} from '../contracts/probeManifest.js';
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
        'Replace an exact text span inside an existing workspace file. PREFER this over write_file when MODIFYING a file — you only emit the changed text, not the whole content. `old_string` must match exactly (including whitespace) and be unique in the file; set replace_all=true to substitute every occurrence. Do not call edit_file when old_string and new_string are identical: no change is needed. Use relative paths only.',
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
      const newString = typeof args['new_string'] === 'string' ? (args['new_string']) : '';
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
      // THE PROBE MANIFEST IS NOT EDITABLE BY HAND. Measured across 122
      // archived traces: 31 of the 50 `old_string not found` failures were on
      // this one file — 62% of every edit_file failure in the corpus. The
      // cause is structural, not sloppiness: the manifest is a JSON document
      // the model must MERGE into, and compiled verification scripts rewrite
      // it behind the model's back (`node _skill_*.mjs` merges its
      // observations back in), so a span remembered from an earlier tool call
      // is stale by construction. Refused here rather than diagnosed, because
      // `record_probe` now does the merge correctly and a better error message
      // would still cost a wasted round-trip.
      if (path === PROBE_MANIFEST_FILENAME) {
        throw new Error(
          `edit_file: refuse to hand-edit "${PROBE_MANIFEST_FILENAME}". It is a merged record that ` +
            `compiled verification scripts also rewrite, so any span you remember from earlier is ` +
            `likely stale — this was 62% of all edit_file failures before the tool existed. ` +
            `Use record_probe to run a command AND record its real result, or write_file the whole ` +
            `document after read_file if you must repair its structure.`
        );
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        // Naming the diagnosis was not enough. This message already told the
        // model its escaping was probably wrong, and the model kept
        // re-emitting the same broken span: measured 2026-08-09 over the last
        // 40 runs, 9 of 10 `old_string not found` failures carried
        // two-character `\\n` sequences instead of real newlines, across six
        // runs on two consecutive days.
        //
        // So when the defect is PROVABLE for this specific call — unescaping
        // the argument finds exactly one match — stop describing the class
        // and hand back the verbatim span to copy. A diagnosis the model must
        // act on from memory is weaker than the bytes it needs.
        const unescaped = unescapeJsonish(oldString);
        if (unescaped !== oldString && content.split(unescaped).length - 1 === 1) {
          throw new Error(
            `edit_file: old_string not found in "${path}" — you DOUBLE-ESCAPED it. ` +
              `Your argument contains the two characters backslash-n (and/or backslash-quote) where the file has real newlines and quotes. ` +
              `Un-escaping your argument matches exactly one span, so re-send old_string as these RAW bytes, copied verbatim:\n` +
              `---8<---\n${unescaped.slice(0, EDIT_SPAN_ECHO_CHARS)}${unescaped.length > EDIT_SPAN_ECHO_CHARS ? '\n… (truncated — copy the full span from read_file)' : ''}\n--->8---` +
              // new_string is escaped the same way in EVERY measured case (7 of 7
              // on round 4), and fixing only old_string writes literal
              // backslash-n INTO the file — which fails the next edit against it.
              // Shown, not applied: 6 of those 7 MIX real newlines with escaped
              // ones, so an automatic un-escape could corrupt a source file that
              // legitimately contains "\\n". A retry costs one round-trip;
              // corruption costs the deliverable.
              (unescapeJsonish(newString) !== newString
                ? `\nAND new_string is escaped the same way — it must be RAW too, or you will write the two characters backslash-n into the file:\n` +
                  `---8<---\n${unescapeJsonish(newString).slice(0, EDIT_SPAN_ECHO_CHARS)}\n--->8---`
                : '')
          );
        }
        // The span un-escapes to nothing that exists either: the model is
        // reconstructing a half-remembered region, not mis-escaping a real
        // one. Hand back what IS there rather than sending it to read_file.
        const near = findNearestSpan(content, oldString);
        if (near) {
          throw new Error(
            `edit_file: old_string not found in "${path}". ` +
              (near.how === 'whitespace'
                ? 'It matches exactly one region ignoring whitespace, so your indentation or line breaks differ from the file. '
                : 'The closest region in the file starts where your span starts and then diverges. ') +
              `Here are the file's REAL bytes for that region — re-send old_string copied verbatim from between the markers:\n` +
              `---8<---\n${near.span.slice(0, EDIT_SPAN_ECHO_CHARS)}${near.span.length > EDIT_SPAN_ECHO_CHARS ? '\n… (truncated — read_file for the rest)' : ''}\n--->8---`
          );
        }
        throw new Error(
          `edit_file: old_string not found in "${path}", and no region of the file resembles it — nothing here starts the way your span does. Either you are editing the wrong file, or the content changed since you last read it: list_files then read_file "${path}" and work from what it actually contains. Note that old_string must hold the file's RAW bytes (real newlines, real quotes), never two-character \\n or \\" escape sequences.`
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

/**
 * Executables `run_shell` will spawn by default.
 *
 * WHAT THIS LIST IS — and is NOT. It is NOT a security boundary: `bash`,
 * `node -e` and `python3 -c` are all on it, and each is a complete escape
 * hatch for command selection (verified empirically: `bash -c "head …"`
 * runs `head` fine, and `curl` is reachable the same way). What actually
 * contains model-authored shell is elsewhere and unchanged — the env
 * allowlist that strips ANTHROPIC_API_KEY et al. (#7a), the scratch HOME
 * that hides ~/.ssh and ~/.aws, the workspace cwd, the process-GROUP
 * SIGKILL (#7c) and the 30s timeout.
 *
 * What the list IS: a STEERING and DECLARATION surface. It is rendered
 * into the tool description, so its contents tell the model what the
 * house considers the normal way to work — and each rejection costs a
 * wasted tool round-trip. Hence the two rules below.
 *
 * INCLUDED: the read-only inspection utilities (the `cat`/`ls` class) and
 * the workspace-shaping ones that merely mirror capabilities the atom
 * already has through `write_file`/`edit_file`. Adding these buys real
 * friction relief at zero security cost — `grep` (6 rejections), `head`
 * (5) and `chmod` (3) were the measured friction across the archived
 * traces.
 *
 * DELIBERATELY EXCLUDED, for reasons that are NOT "it would be
 * dangerous" (bash already reaches all of them) but about coherence:
 *   - `curl` / `wget` (3 rejections, deliberately left failing): network
 *     reach is a DECLARED bucket capability — `fetch_url` is the
 *     observable path (it emits trace events, honours its own timeout,
 *     and its presence is what `hostAllowsLoopbackNetwork` keys on). An
 *     L1 that lacks `fetch_url` is one the plan should not have sent
 *     after HTTP at all (the F1 toolset-scope work); advertising curl
 *     here would invite every file-scribe atom to bypass all of that.
 *   - `git`: the workspace lives INSIDE this repo, and git discovers the
 *     nearest ancestor `.git` — a stray `git checkout .` or `git clean`
 *     would operate on the user's uncommitted work, not on the sandbox.
 *   - `rm`: never appeared in the friction data (scratch cleanup already
 *     goes through `node -e … rmSync`), and it is the highest-regret
 *     entry to advertise.
 */
/**
 * Cap on the span echoed back by `edit_file`'s double-escape diagnosis. Long
 * enough for a real function body, short enough not to re-dump a file the
 * model already has.
 */
export const EDIT_SPAN_ECHO_CHARS = 600;

/**
 * Undo ONE level of JSON-ish string escaping.
 *
 * Only the sequences actually observed in the failures — `\\n`, `\\t`,
 * `\\r`, `\\"`, `\\\\`. Deliberately not a JSON parser: the argument is a
 * fragment, not a document, and a parser would reject it or mangle a lone
 * backslash that was legitimately in the file.
 */
export const EDIT_NEAREST_ANCHOR_MIN = 24;

/**
 * Find the real bytes the model was probably aiming at when `old_string` is
 * not in the file.
 *
 * WHY THIS EXISTS. Measured over 122 archived traces: 50 `edit_file` failures,
 * and the double-escape branch above explains only SEVEN of them. In the other
 * 43 the argument un-escapes to something still absent — the model is not
 * mis-escaping a span it has, it is reconstructing one it half-remembers,
 * usually from a file it wrote several tool calls earlier. Telling it to
 * "read_file and retry" costs a full round-trip and it frequently comes back
 * with the same invented span.
 *
 * Two attempts, cheapest first, both returning REAL bytes from the file:
 *   1. WHITESPACE-INSENSITIVE match. If the span exists modulo runs of
 *      whitespace and matches exactly once, the intent is unambiguous and the
 *      only thing wrong was indentation — the single most common way a
 *      remembered span drifts.
 *   2. LONGEST-PREFIX ANCHOR. Otherwise, find the longest leading slice of the
 *      argument that does occur, and return the file's actual content from
 *      there. That is the region the model was editing, in its true form.
 *
 * Deliberately returns bytes and never applies an edit: the argument proves
 * where the model was looking, not what it meant to write there.
 */
export function findNearestSpan(
  content: string,
  oldString: string
): { span: string; how: 'whitespace' | 'anchor' } | null {
  const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();
  const needle = squash(oldString);
  if (needle.length === 0) return null;

  // 1. Whitespace-insensitive, and only when it is UNIQUE — an ambiguous hit
  // would hand back a span the model did not mean.
  const squashedContent = squash(content);
  if (squashedContent.split(needle).length - 1 === 1) {
    // Walk the real content to recover the true bytes of that region.
    const words = needle.split(' ');
    const first = words[0]!;
    const last = words[words.length - 1]!;
    const start = content.indexOf(first);
    if (start >= 0) {
      const end = content.indexOf(last, start + first.length);
      if (end >= 0) return { span: content.slice(start, end + last.length), how: 'whitespace' };
    }
  }

  // 2. Longest leading slice that actually occurs. Binary search rather than a
  // scan: old_string can be kilobytes and this runs on a failure path.
  const probe = unescapeJsonish(oldString);
  let lo = 0;
  let hi = Math.min(probe.length, 4000);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (content.includes(probe.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  if (lo < EDIT_NEAREST_ANCHOR_MIN) return null;
  const at = content.indexOf(probe.slice(0, lo));
  return { span: content.slice(at, at + Math.min(probe.length + 80, EDIT_SPAN_ECHO_CHARS)), how: 'anchor' };
}

export function unescapeJsonish(s: string): string {
  return s.replace(/\\(n|t|r|"|\\)/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '"' ? '"' : '\\'
  );
}

export const DEFAULT_SHELL_ALLOWLIST: readonly string[] = [
  // Interpreters and package tooling (unchanged).
  'node',
  'npm',
  'npx',
  'python3',
  'bash',
  // Read-only inspection — the `cat`/`ls` class.
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  // `od` joins on the CLASS rule, not on frequency: the list admits read-only
  // inspection utilities and a hex/octal dump is squarely one. Observed once
  // (round 5) with the model reaching for it despite the allowlist being
  // rendered in the tool description it had just read — which is the evidence
  // that the friction is real rather than a naming slip. `bash -c "od …"`
  // already worked, so this removes a wasted round-trip, not a boundary.
  'od',
  'grep',
  'sort',
  'uniq',
  'diff',
  'find',
  'cut',
  'tr',
  'basename',
  'dirname',
  'echo',
  'printf',
  'date',
  'pwd',
  'env',
  'which',
  // Workspace shaping — mirrors what write_file/edit_file already do.
  'mkdir',
  'touch',
  'cp',
  'mv',
  'chmod',
  'sed',
  'awk',
];

/**
 * A `command` that is really a whole shell LINE (pipes, redirections,
 * `&&` chains, quoted arguments). Measured: an L1 sent
 * `chmod +x test-api.js && node test-api.js` as the executable name, so
 * the rejection named a "command" no allowlist could ever contain. The
 * error message coaches the two correct shapes instead of just listing
 * the allowlist again.
 */
const SHELL_LINE_RE = /[\s|&;><]/;

export function runShellTool(opts: BuiltinToolOptions): BuiltinTool {
  const allowlist = new Set(opts.shellAllowlist ?? DEFAULT_SHELL_ALLOWLIST);
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
          cmd: {
            type: 'string',
            description:
              'The whole command line, as you would type it: "node cli.js data.csv --format json". Pipes and redirects are fine — they run through bash.',
          },
          command: {
            type: 'string',
            description:
              'Alternative to cmd: preferably the program alone (must be in the allowlist), e.g. "node". For compatibility, a whole line is also accepted here when args is empty.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Positional arguments, used with "command". E.g. ["--version"].',
          },
        },
      },
    },
    async execute(args) {
      // ACCEPTS A WHOLE LINE. Measured on round 4: 6 of run_shell's 90 calls
      // were rejected as "a shell LINE, not an executable" — the model passing
      // `grep -n "some phrase" file` as one string. record_probe had the same
      // friction and was fixed; leaving run_shell behind made the two tools
      // disagree about the shape of a command, which is worse than either
      // choice. A line needing a shell is routed through bash (already on the
      // allowlist and documented as a sanctioned escape hatch); a plain one is
      // split and still checked against the allowlist.
      let line = typeof args['cmd'] === 'string' ? args['cmd'].trim() : '';
      const rawArgs = Array.isArray(args['args']) ? (args['args'] as unknown[]) : [];
      const commandField =
        typeof args['command'] === 'string' ? args['command'].trim() : '';
      // Models still occasionally put the whole line in `command` despite the
      // declaration preferring `cmd` (live: `grep -n "node cli.js" README.md`).
      // When args is empty there is no ambiguity: normalize it through the
      // exact same parser/shell classifier as `cmd`. Security is unchanged —
      // the resolved executable is still allowlist-checked below.
      if (!line && rawArgs.length === 0 && SHELL_LINE_RE.test(commandField)) {
        line = commandField;
      }
      let command: string;
      let argv: string[];
      if (line) {
        if (commandLineNeedsShell(line)) {
          command = 'bash';
          argv = ['-c', line];
        } else {
          const parts = splitCommandLine(line);
          command = parts[0] ?? '';
          argv = parts.slice(1);
          if (!command) throw new Error('run_shell: "cmd" is empty.');
        }
      } else {
        command = expectString(args, 'command');
        argv = rawArgs.map((a) => String(a));
      }
      if (!allowlist.has(command)) {
        if (SHELL_LINE_RE.test(command.trim())) {
          throw new Error(
            `run_shell: "${command}" is a shell LINE, not an executable. Pass the program alone in "command" and its arguments in "args" (e.g. command: "chmod", args: ["+x", "file.js"]), or run the whole line through bash: command: "bash", args: ["-c", "<the line>"].`
          );
        }
        throw new Error(
          `run_shell: command "${command}" is not in allowlist (${[...allowlist].join(', ')}). For anything else, invoke it through bash: command: "bash", args: ["-c", "..."] — except network fetches, which belong to the fetch_url tool.`
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
            type: 'integer',
            minimum: 0,
            maximum: 65535,
            description:
              'Port to listen on. Defaults to 0 (OS-assigned). Pass a fixed port only when you must; parallel subtasks MUST leave it unset to avoid "Address already in use" clashes.',
          },
        },
      },
    },
    async execute(args) {
      const rawPort = args['port'];
      if (
        rawPort !== undefined &&
        (typeof rawPort !== 'number' ||
          !Number.isInteger(rawPort) ||
          rawPort < 0 ||
          rawPort > 65535)
      ) {
        throw new Error('start_static_server: port must be an integer between 0 and 65535');
      }
      const requestedPort = rawPort ?? 0;

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
        `Set record=true when the request is evidence; the tool appends the exact observation to ${PROBE_MANIFEST_FILENAME}.`,
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
          record: {
            type: 'boolean',
            description:
              `When true, append the exact observed method/path/status/body to ${PROBE_MANIFEST_FILENAME}. Use this for endpoint requests that are verification evidence instead of curl, node -e, or hand-written manifest JSON.`,
          },
          note: {
            type: 'string',
            description: 'Optional one-line reason this HTTP request is evidence.',
          },
        },
        required: ['url'],
      },
    },
    async execute(args) {
      const url = expectString(args, 'url');
      const methodRaw = typeof args['method'] === 'string' ? args['method'].toUpperCase() : 'GET';
      const method = methodRaw;
      const timeoutMs =
        typeof args['timeoutMs'] === 'number' && Number.isFinite(args['timeoutMs'])
          ? (args['timeoutMs'])
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
        const result = {
          ok: res.ok,
          status: res.status,
          headers: respHeaders,
          body: text,
        };
        if (args['record'] === true) {
          const parsedUrl = new URL(url);
          const entry: {
            probe: 'http';
            method: string;
            path: string;
            status: number;
            body?: string;
            note?: string;
          } = {
            probe: 'http',
            method,
            path: `${parsedUrl.pathname}${parsedUrl.search}` || '/',
            status: res.status,
            body: text.slice(0, 200),
          };
          if (typeof args['note'] === 'string' && args['note'].trim()) {
            entry.note = args['note'].trim();
          }
          const manifestPath = opts.sandbox.resolve(PROBE_MANIFEST_FILENAME);
          const existing = existsSync(manifestPath)
            ? readFileSync(manifestPath, 'utf8')
            : null;
          writeFileSync(manifestPath, appendHttpProbe(existing, entry), 'utf8');
          opts.logger?.info(
            `[tool:fetch_url] recorded ${method} ${entry.path} -> ${res.status} in ${PROBE_MANIFEST_FILENAME}`
          );
          return { ...result, recorded: true, manifest: PROBE_MANIFEST_FILENAME };
        }
        return result;
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
              'Task-owned environment variables passed to the child over PORT=0 and the credential-stripped sandbox allowlist.',
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
      // Puppeteer defaults this to 180s, so a single wedged CDP command
      // stalls for three minutes. Observed: one call spent 546s mostly
      // inside `Input.dispatchMouseEvent timed out`. Local pages answer in
      // milliseconds — this turns a wedge into a prompt, reportable failure.
      protocolTimeout: CDP_PROTOCOL_TIMEOUT_MS,
    });
    sharedBrowser = browser;
    // TRACK THE BROWSER PROCESS, not just the graceful close. `onCleanup`
    // hooks are async and only run on the orderly path — a hard exit (the
    // burn-in harness group-killing a run at its wall-clock budget, the
    // build-app watchdog, a crash) skips them entirely, and headless Chrome
    // then survives with its whole helper fleet. Measured 2026-08-08: one
    // web run killed at its 900s budget after 46 validations left Chrome
    // behind; 126 puppeteer processes (42 reparented to init, up to 22h
    // old) had accumulated, loading the machine enough that the next two
    // runs blew their own budgets — a leak that cascades into failures.
    // `trackChild` puts it under the same synchronous process.on('exit')
    // SIGKILL every run_shell / server child already gets.
    const proc = browser.process();
    if (proc) opts.sandbox.trackChild(proc);
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
            description: `Additional time to wait after DOM ready to catch async errors (rAF, fetch chains, late scripts). Default 500ms, capped at ${MAX_WAIT_MS}ms — bump this explicitly when the app does non-trivial work on load.`,
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
                  description: `keypress-only. Time in ms between keydown and keyup. Default 120ms, CAPPED at ${MAX_HOLD_MS}ms. The browser runs in real time and cannot fast-forward, so holding a key can NEVER advance an in-page timer or animation — to test time-dependent behaviour, expose a hook from the app (e.g. window.__test.advance(ms)) and drive it from \`smoke\`.`,
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
      const requestedWaitMs =
        typeof args['waitMs'] === 'number' && Number.isFinite(args['waitMs'])
          ? Math.max(0, Math.floor(args['waitMs']))
          : 500;
      const waitMs = Math.min(requestedWaitMs, MAX_WAIT_MS);
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

      // Console errors are held STRUCTURED (text + source url) until the
      // end of the call: the favicon filter below decides on the source,
      // and re-parsing our own rendered `[source: ...]` suffix would be a
      // string round-trip we can simply not do.
      const consoleErrors: Array<{ text: string; loc?: string }> = [];
      page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        // Puppeteer's msg.text() does NOT carry the offending URL (a bare
        // "Failed to load resource: ... 404" is unattributable — measured:
        // 25 such errors across 41 traces, zero identifiable). The source
        // location is the evidence that lets a validator (or an operator
        // reading the friction report) tell a phantom favicon 404 from a
        // genuinely missing artefact file.
        const loc = msg.location()?.url;
        if (type === 'error') consoleErrors.push(loc ? { text, loc } : { text });
        else if (type === 'warn') warnings.push(loc ? `${text} [source: ${loc}]` : text);
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

        // Bound the PHASE, not the count: a game replay legitimately needs a
        // long sequence, but 31 interactions once cost 546s (most of it
        // inside a wedged CDP command) and still failed.
        const budgetMs = interactionPhaseBudgetMs();
        const interactionDeadline = Date.now() + budgetMs;
        let skippedInteractions = 0;
        for (const [idx, it] of interactions.entries()) {
          if (Date.now() > interactionDeadline) {
            skippedInteractions = interactions.length - idx;
            break;
          }
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
              const requestedHoldMs =
                typeof it.holdMs === 'number' && Number.isFinite(it.holdMs)
                  ? Math.max(0, Math.floor(it.holdMs))
                  : 120;
              const holdMs = Math.min(requestedHoldMs, MAX_HOLD_MS);
              if (holdMs < requestedHoldMs) {
                // Say WHY and give the technique that works — a silent clamp
                // turns a long dead end into a short mystery.
                warnings.push(
                  `holdMs ${requestedHoldMs} clamped to ${MAX_HOLD_MS}: a headless browser runs in ` +
                    `real time and cannot fast-forward, so holding a key cannot advance an in-page ` +
                    `timer. To test time-dependent behaviour, expose a hook from the app ` +
                    `(e.g. window.__test.advance(ms), or accept a duration via ?query) and drive it ` +
                    `from \`smoke\` instead.`
                );
              }
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

        if (skippedInteractions > 0) {
          // An ERROR, not a warning: the sequence the caller asked for did
          // not fully run, so whatever the smoke observes is not the state
          // it was written against.
          errors.push(
            `interaction budget exhausted after ${budgetMs}ms: ` +
              `${skippedInteractions} of ${interactions.length} interactions were SKIPPED, so the ` +
              `page is not in the state your smoke expects. Split this into several validate_html ` +
              `calls, or drive the app through an exposed window.__test hook instead of replaying ` +
              `every input.`
          );
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

        // Does the DOCUMENT declare an icon? Read it AFTER interactions so a
        // page that installs its <link rel="icon"> dynamically still counts.
        const declaresIcon = await page
          .evaluate(`!!document.querySelector('link[rel~="icon"]')`)
          .then((v) => v === true)
          .catch(() => false);
        const pageErrors = mergeConsoleErrors(consoleErrors, url, declaresIcon);
        const realFailedRequests = failedRequests.filter(
          (r) => !isSpeculativeFaviconRequest(r.url, url, declaresIcon)
        );
        const allErrors = [...pageErrors, ...errors];

        const title = await page.title();
        return {
          ok: allErrors.length === 0 && realFailedRequests.length === 0 && smokeOk,
          url,
          title,
          errors: allErrors,
          warnings,
          failedRequests: realFailedRequests,
          interactionLog,
          ...(smoke ? { smokeResult } : {}),
        };
      } catch (err) {
        // Navigation failed, so the icon-link probe is unavailable; treating
        // the document as declaring none only ever suppresses a favicon 404,
        // which is never the cause of a navigation failure.
        return {
          ok: false,
          url,
          errors: [
            ...mergeConsoleErrors(consoleErrors, url, false),
            ...errors,
            `navigation failed: ${(err as Error).message}`,
          ],
          warnings,
          failedRequests: failedRequests.filter(
            (r) => !isSpeculativeFaviconRequest(r.url, url, false)
          ),
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
      parsed.selector = rec['selector'];
    }
    if (typeof rec['x'] === 'number' && Number.isFinite(rec['x'])) {
      parsed.x = rec['x'];
    }
    if (typeof rec['y'] === 'number' && Number.isFinite(rec['y'])) {
      parsed.y = rec['y'];
    }
    if (typeof rec['key'] === 'string' && rec['key']) {
      parsed.key = rec['key'];
    }
    if (typeof rec['holdMs'] === 'number' && Number.isFinite(rec['holdMs'])) {
      parsed.holdMs = rec['holdMs'];
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
 * Upper bound on a single `keypress` hold, in ms.
 *
 * A headless browser runs in REAL TIME and cannot fast-forward. Measured
 * 2026-08-09 on a Quiz Timer task: the model asked for
 * `keypress (270500ms)` — 4.5 minutes of held key — trying to advance an
 * in-page countdown to zero. The tool obeyed, the call took 273s, and the
 * run's wall-clock tripled. It is never a real interaction: no user holds a
 * key for minutes, and the app under test cannot be steered that way. So the
 * hold is clamped and the caller is TOLD, with the technique that does work
 * (expose a hook and drive the clock from `smoke`) — a clamp the model
 * cannot see just turns a 273s dead end into a 3s mystery.
 */
export const MAX_HOLD_MS = 3_000;

/**
 * Upper bound on the post-load settle `waitMs`. Same class as MAX_HOLD_MS —
 * unbounded model-supplied durations convert arithmetic slips straight into
 * dead wall-clock. The largest legitimate value observed across 208 archived
 * calls is 6000ms, so this leaves real headroom.
 */
export const MAX_WAIT_MS = 15_000;

/**
 * Wall-clock ceiling for the whole interaction phase of ONE call.
 *
 * Measured 2026-08-09: a single call carrying 31 interactions ran 546
 * seconds and STILL failed (`Input.dispatchMouseEvent timed out`). Batching
 * interactions is legitimate — a game replay needs a sequence — so the count
 * is not capped; what must be bounded is the TIME. On expiry the remaining
 * interactions are skipped and reported as an error, because a partially
 * executed sequence makes the smoke result untrustworthy.
 */
export const INTERACTION_PHASE_BUDGET_MS = 45_000;

/**
 * The interaction-phase budget, read at CALL time so a single run can be
 * tightened without a rebuild (`ATOMA_VALIDATE_INTERACTION_BUDGET_MS`).
 * Mirrors `trustThreshold()` / `cliCallTimeoutMs()`: an invalid, zero or
 * negative value falls back to the DEFAULT rather than disabling the guard —
 * a typo must never make the system less careful.
 */
export function interactionPhaseBudgetMs(): number {
  const raw = process.env['ATOMA_VALIDATE_INTERACTION_BUDGET_MS'];
  if (raw === undefined) return INTERACTION_PHASE_BUDGET_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return INTERACTION_PHASE_BUDGET_MS;
  return Math.floor(n);
}

/**
 * Per-CDP-command timeout for the shared browser.
 *
 * Puppeteer's default is 180s, so ONE wedged `Input.dispatchMouseEvent`
 * costs three minutes before it reports. Local pages answer in
 * milliseconds; 30s is far beyond any healthy command while turning a wedge
 * into a prompt failure instead of a stall.
 */
export const CDP_PROTOCOL_TIMEOUT_MS = 30_000;

/**
 * Is this failing request Chrome's OWN speculative favicon fetch?
 *
 * Chrome requests `/favicon.ico` on every navigation when the document
 * declares no icon link — nothing in the page asked for it, and
 * `start_static_server` has no such file, so it 404s. That 404 arrives as a
 * console error, and `validate_html` computes `ok` from `errors.length ===
 * 0`, so a PERFECTLY WORKING PAGE was reported broken.
 *
 * Measured over 208 archived calls: 23 carried the favicon 404 and **10
 * returned `ok: false` with it as their ONLY error** — 13% of every failure
 * the tool reported. The model usually reasoned past it ("browser
 * auto-fetch, not a task failure"), which is tokens spent overriding our own
 * false negative, and it cannot be relied on to always do so.
 *
 * Deliberately NARROW: it suppresses the request only when it is same-origin
 * AND the document declares no icon link. A page that ships
 * `<link rel="icon" href="favicon.ico">` and 404s is a REAL broken artefact
 * and keeps failing the check.
 */
export function isSpeculativeFaviconRequest(
  requestUrl: string,
  pageUrl: string,
  documentDeclaresIcon: boolean
): boolean {
  if (documentDeclaresIcon) return false;
  let req: URL;
  let page: URL;
  try {
    req = new URL(requestUrl);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (req.origin !== page.origin) return false;
  return req.pathname === '/favicon.ico';
}

/**
 * Render captured console errors into the reported `errors` list, dropping
 * Chrome's own speculative favicon fetch (see `isSpeculativeFaviconRequest`).
 *
 * An entry with no source location is ALWAYS kept: absent evidence that it is
 * the favicon, the honest default is to report it.
 */
export function mergeConsoleErrors(
  captured: ReadonlyArray<{ text: string; loc?: string }>,
  pageUrl: string,
  documentDeclaresIcon: boolean
): string[] {
  const out: string[] = [];
  for (const e of captured) {
    if (e.loc && isSpeculativeFaviconRequest(e.loc, pageUrl, documentDeclaresIcon)) continue;
    out.push(e.loc ? `${e.text} [source: ${e.loc}]` : e.text);
  }
  return out;
}

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

/**
 * Render `command` + `args` back into ONE replayable shell string.
 *
 * Quoting is not cosmetic here: the manifest's `cmd` is re-executed verbatim
 * by compiled verifiers, and a previous compiled script's command regex
 * dropped quotes — amputating `node index.js "Hello World"` to
 * `node index.js` and failing a correct deliverable.
 */
/**
 * Syntax whose meaning changes when a line is split into argv locally.
 *
 * Conservative by design: an unnecessary bash hop costs almost nothing, while
 * missing one records a command different from the one a future verifier
 * replays. Globs were the live gap — `*.test.js` ran literally on the first
 * pass, then expanded when the manifest was replayed through a shell.
 */
const NEEDS_SHELL_RE = /[|&;<>()$`*?[\]{}~#\\\r\n]|\d>&\d/;
const LEADING_ENV_ASSIGNMENT_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;

export function commandLineNeedsShell(line: string): boolean {
  return NEEDS_SHELL_RE.test(line) || LEADING_ENV_ASSIGNMENT_RE.test(line);
}

/**
 * Split a plain command line into argv, honouring quotes.
 *
 * `record_probe` accepts a whole line because that is what the manifest STORES
 * and what a model reaches for — the first version demanded run_shell's
 * {command, args} shape, and round 3 measured the consequence: the model
 * worked around the rejection with `bash -c "…"`, every manifest entry gained
 * a wrapper, and the compiled verifier's argument regex then captured the
 * wrapper's closing quote (`node csvstat.js sample.csv"`), failing a correct
 * artefact until the script demoted itself.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      any = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (any) { out.push(cur); cur = ''; any = false; }
    } else {
      cur += c;
      any = true;
    }
  }
  if (quote) throw new Error('command line contains an unterminated quote');
  if (any) out.push(cur);
  return out;
}

export function renderProbeCmd(command: string, argv: readonly string[]): string {
  const quote = (a: string): string =>
    a.length > 0 && /^[A-Za-z0-9_./:=@,+-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
  return [command, ...argv.map(quote)].join(' ').trim();
}

/**
 * Merge one shell entry into a probe manifest, by `cmd`.
 *
 * Shell entries MERGE (an invocation re-run after a fix should replace its
 * stale record, not accumulate duplicates); http entries APPEND in order,
 * which is why this helper is shell-only. Pure, so the merge semantics are
 * testable without a filesystem.
 */
export function mergeShellProbe(
  existingRaw: string | null,
  entry: { cmd: string; exitCode: number; stdout?: string; stderr?: string; note?: string },
  supersedes?: string
): string {
  let doc: { version: number; entries: Record<string, unknown>[] } = { version: 1, entries: [] };
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as typeof doc;
      if (parsed && Array.isArray(parsed.entries)) doc = { version: 1, entries: parsed.entries };
    } catch {
      // A corrupt manifest is replaced rather than appended to: half a JSON
      // document is not a record anyone can replay.
    }
  }
  if (supersedes && supersedes !== entry.cmd) {
    doc.entries = doc.entries.filter((e) => e['cmd'] !== supersedes);
  }
  const i = doc.entries.findIndex((e) => e['cmd'] === entry.cmd);
  if (i >= 0) doc.entries[i] = entry;
  else doc.entries.push(entry);
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Append one HTTP observation to a probe manifest. Unlike shell commands,
 * HTTP entries are a stateful sequence: POST /items may legitimately appear
 * several times with 201, 400 and 409, so they never merge by route.
 */
export function appendHttpProbe(
  existingRaw: string | null,
  entry: {
    probe: 'http';
    method: string;
    path: string;
    status: number;
    body?: string;
    note?: string;
  }
): string {
  let doc: { version: number; entries: Record<string, unknown>[] } = {
    version: 1,
    entries: [],
  };
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as typeof doc;
      if (parsed && Array.isArray(parsed.entries)) {
        doc = { version: 1, entries: parsed.entries };
      }
    } catch {
      // A corrupt manifest is replaced rather than extended with more
      // plausible-looking data.
    }
  }
  doc.entries.push(entry);
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * RECORD_PROBE — run a command AND write its real result into the probe
 * manifest, in one step.
 *
 * WHY IT EXISTS. The manifest was introduced to replace model-authored prose
 * with a machine-readable record — and was then itself written by the model,
 * which pasted observed output into a `write_file`. Measured on the 2026-08-10
 * round-2 benchmark: the model ABRIDGES long output. In every failing replay
 * the recorded stdout was a strict PREFIX of the real one (371 chars against
 * 2008; 65 against 1029), so a compiled verifier comparing byte-for-byte could
 * never match, and two such false mismatches auto-demoted a working script.
 * `validateProbeManifest` checks structure, not completeness, so nothing
 * noticed. Asking the prompt harder does not fix a transcription problem: the
 * harness already HAS the exact bytes, so it should be the one writing them.
 *
 * The division of labour is deliberate. The MODEL still decides which
 * invocations are evidence — auto-recording every `run_shell` would fill the
 * manifest with `mkdir` and `ls` noise. The MACHINE decides what the record
 * says.
 *
 * Composed on `run_shell` rather than re-implementing it: the process-group
 * kill, the credential-stripped environment and the timeout are load-bearing
 * and must not exist twice.
 */
export function recordProbeTool(opts: BuiltinToolOptions): BuiltinTool {
  const shell = runShellTool(opts);
  return {
    declaration: {
      name: 'record_probe',
      description: [
        `Run a command AND record its real exit code and output into ${PROBE_MANIFEST_FILENAME}.`,
        'Use this INSTEAD of run_shell for every invocation that is evidence the deliverable works',
        '(the documented examples, the error cases). Never transcribe output into the manifest by',
        'hand — this tool writes exactly what the command produced. Entries merge by command, so',
        're-running one after a fix replaces its record. If a corrected probe needs a DIFFERENT',
        'command, pass supersedes with the exact accidental command to remove only that stale entry',
        'after the replacement command has run. FINITE CLI/script commands only: never start a',
        'server here and never use curl/wget; use start_node_server followed by fetch_url with',
        'record=true for HTTP evidence.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description:
              'The whole command line exactly as a user would type it, e.g. "node cli.js data.csv --format json". PREFERRED — this is what gets recorded and replayed.',
          },
          command: { type: 'string', description: 'Alternative to cmd: program alone, as for run_shell.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Positional arguments, with "command".' },
          note: { type: 'string', description: 'Optional one-line reason this invocation is evidence.' },
          supersedes: {
            type: 'string',
            description:
              'Optional exact old cmd to remove after this command runs; use only when correcting an accidental probe whose command changed.',
          },
        },
      },
    },
    async execute(args) {
      // Two accepted shapes. `cmd` (a whole line) is the one the manifest
      // stores and the one models reach for; {command,args} stays for
      // callers written against run_shell. Whichever arrives, the RECORDED
      // cmd is the bare command — never a `bash -c` wrapper, which round 3
      // measured corrupting a compiled verifier's argument extraction.
      const rawLine = typeof args['cmd'] === 'string' ? args['cmd'].trim() : '';
      let command: string;
      let argv: string[];
      let cmd: string;
      let viaShell = false;
      if (rawLine) {
        cmd = rawLine;
        if (commandLineNeedsShell(rawLine)) {
          // Needs interpreter semantics (pipe, redirect, expansion, env).
          // Run through bash, but record the line the user wrote.
          command = 'bash';
          argv = ['-c', rawLine];
          viaShell = true;
        } else {
          const parts = splitCommandLine(rawLine);
          command = parts[0] ?? '';
          argv = parts.slice(1);
          if (!command) throw new Error('record_probe: "cmd" is empty.');
        }
      } else {
        command = expectString(args, 'command');
        const rawArgs = Array.isArray(args['args']) ? (args['args'] as unknown[]) : [];
        argv = rawArgs.map((a) => String(a));
        cmd = renderProbeCmd(command, argv);
      }

      // The contract forbids `; echo EXIT=$?` decorations: they make the
      // recorded exitCode echo's (always 0) and hide the real one inside
      // stdout. Refused mechanically here rather than asked for in a prompt —
      // a decorated cmd once auto-demoted a 30-success compiled verifier.
      // Check the ARGS too, not only the rendered line. `bash -c "… ; echo
      // EXIT=$?"` hides the decoration inside a quoted argument, and
      // DECORATED_CMD_RE is anchored at end-of-string, so the closing quote
      // defeats it. Caught by its own test.
      if (DECORATED_CMD_RE.test(cmd) || argv.some((a) => DECORATED_CMD_RE.test(a))) {
        throw new Error(
          `record_probe: "${cmd}" carries an exit-code echo. Drop it — this tool records the real ` +
            'exit code in the entry\'s "exitCode" field.'
        );
      }

      const shellProgram =
        command === 'bash' && argv[0] === '-c' && typeof argv[1] === 'string'
          ? argv[1]
          : cmd;
      if (
        /^(?:curl|wget)\b/i.test(command) ||
        /(?:^|[;&|]\s*)(?:curl|wget)\b/i.test(shellProgram)
      ) {
        throw new Error(
          `record_probe: "${cmd}" is an HTTP request disguised as a shell probe. ` +
            'Use fetch_url with record=true so the machine records method/path/status/body.'
        );
      }

      // A server process is not a finite probe. This exact mistake recurred
      // across three HTTP runs: record_probe waited 30 seconds, killed the
      // healthy server, and persisted exit=1 plus a dead port. Detect the
      // project's explicit boot contract before spawning and route the model
      // to the lifecycle + machine-recorded HTTP path.
      if (command === 'node' && argv.length === 1 && /\.m?js$/i.test(argv[0] ?? '')) {
        try {
          const source = readFileSync(opts.sandbox.resolve(argv[0]!), 'utf8');
          if (/LISTENING_ON_PORT/.test(source) && /\.listen\s*\(/.test(source)) {
            throw new Error(
              `record_probe: "${cmd}" starts a long-running server, not a finite probe. ` +
                'Use start_node_server, then fetch_url with record=true for each endpoint request.'
            );
          }
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.startsWith('record_probe:') &&
            err.message.includes('long-running server')
          ) {
            throw err;
          }
          // Missing/unreadable commands stay with run_shell, whose error is
          // the authoritative execution result.
        }
      }

      const result = (await shell.execute({ command, args: argv })) as {
        exitCode: number;
        stdout?: string;
        stderr?: string;
        error?: string;
      };

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const entry: { cmd: string; exitCode: number; stdout?: string; stderr?: string; note?: string } = {
        cmd,
        exitCode: result.exitCode,
      };
      // A bound port is different on every run, so recording it guarantees a
      // future replay mismatch. Omitting stdout is the documented signal that
      // only the exit code is comparable for this entry.
      if (!PORT_BEARING_STDOUT_RE.test(stdout)) entry.stdout = stdout;
      if (stderr) entry.stderr = stderr;
      if (typeof args['note'] === 'string' && args['note'].trim()) entry.note = args['note'].trim();

      const path = opts.sandbox.resolve(PROBE_MANIFEST_FILENAME);
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const supersedes =
        typeof args['supersedes'] === 'string' && args['supersedes'].trim()
          ? args['supersedes'].trim()
          : undefined;
      writeFileSync(path, mergeShellProbe(existing, entry, supersedes), 'utf8');
      opts.logger?.info(
        `[tool:record_probe] ${cmd} -> exit ${result.exitCode}, recorded in ${PROBE_MANIFEST_FILENAME}`
      );

      return {
        ...result,
        recorded: true,
        manifest: PROBE_MANIFEST_FILENAME,
        recordedStdoutOmitted: entry.stdout === undefined,
        ranThroughShell: viaShell,
        ...(supersedes ? { superseded: supersedes } : {}),
      };
    },
  };
}

export function defaultBuiltinTools(opts: BuiltinToolOptions): BuiltinTool[] {
  return [
    writeFileTool(opts),
    editFileTool(opts),
    readFileTool(opts),
    listFilesTool(opts),
    runShellTool(opts),
    recordProbeTool(opts),
    startStaticServerTool(opts),
    validateHtmlTool(opts),
    fetchUrlTool(opts),
    startNodeServerTool(opts),
  ];
}
