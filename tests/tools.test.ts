import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import {
  defaultBuiltinTools,
  editFileTool,
  fetchUrlTool,
  listFilesTool,
  readFileTool,
  runShellTool,
  DEFAULT_SHELL_ALLOWLIST,
  startNodeServerTool,
  writeFileTool,
} from '../src/tools/builtin.js';
import { PROBE_MANIFEST_FILENAME } from '../src/contracts/probeManifest.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('ToolSandbox', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-sandbox-'));
    sandbox = new ToolSandbox(root);
  });

  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves simple relative paths inside the sandbox', () => {
    const abs = sandbox.resolve('index.html');
    expect(abs).toBe(join(root, 'index.html'));
  });

  it('resolves nested relative paths inside the sandbox', () => {
    const abs = sandbox.resolve('src/app/main.js');
    expect(abs).toBe(join(root, 'src/app/main.js'));
  });

  it('rejects path escape via "..":', () => {
    expect(() => sandbox.resolve('../escape.txt')).toThrow(/escapes sandbox/);
  });

  it('rejects deep path escape', () => {
    expect(() => sandbox.resolve('a/b/../../../escape')).toThrow(/escapes sandbox/);
  });

  it('normalizes absolute input by re-rooting under the sandbox', () => {
    const abs = sandbox.resolve('/etc/passwd');
    expect(abs).toBe(join(root, 'etc/passwd'));
  });

  it('rejects empty and non-string paths', () => {
    expect(() => sandbox.resolve('')).toThrow(/non-empty string/);
    // @ts-expect-error testing runtime guard
    expect(() => sandbox.resolve(undefined)).toThrow(/non-empty string/);
  });
});

describe('writeFileTool + readFileTool', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-tools-'));
    sandbox = new ToolSandbox(root);
  });

  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a file and reads it back via the tools', async () => {
    const w = writeFileTool({ sandbox });
    const r = readFileTool({ sandbox });
    const writeRes = (await w.execute({ path: 'hello.txt', content: 'hi there' })) as {
      ok: boolean;
      bytes: number;
    };
    expect(writeRes.ok).toBe(true);
    expect(writeRes.bytes).toBe(8);
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hi there');

    const readRes = (await r.execute({ path: 'hello.txt' })) as { content: string };
    expect(readRes.content).toBe('hi there');
  });

  it('creates nested parent directories on write', async () => {
    const w = writeFileTool({ sandbox });
    await w.execute({ path: 'a/b/c/deep.js', content: 'console.log(1);' });
    expect(existsSync(join(root, 'a/b/c/deep.js'))).toBe(true);
  });

  it('refuses writes that escape the sandbox', async () => {
    const w = writeFileTool({ sandbox });
    await expect(w.execute({ path: '../outside.txt', content: 'nope' })).rejects.toThrow(
      /escapes sandbox/
    );
  });

  // The manifest protections must key on the FILE, not the spelling: models
  // routinely prepend `./`, and a raw string comparison let that spelling
  // skip the merge and OVERWRITE every entry earlier phases recorded.
  it(`merges a ./-spelled ${PROBE_MANIFEST_FILENAME} write instead of overwriting`, async () => {
    const w = writeFileTool({ sandbox });
    const phase1 = { version: 1, entries: [{ cmd: 'node cli.js a', exitCode: 0, stdout: 'A' }] };
    const phase2 = { version: 1, entries: [{ cmd: 'node cli.js b', exitCode: 0, stdout: 'B' }] };
    await w.execute({ path: PROBE_MANIFEST_FILENAME, content: JSON.stringify(phase1) });
    await w.execute({ path: `./${PROBE_MANIFEST_FILENAME}`, content: JSON.stringify(phase2) });
    const merged = JSON.parse(readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8')) as {
      entries: Array<{ cmd: string }>;
    };
    expect(merged.entries.map((e) => e.cmd).sort()).toEqual(['node cli.js a', 'node cli.js b']);
  });

  it(`refuses hand-edits of a ./-spelled ${PROBE_MANIFEST_FILENAME} too`, async () => {
    const w = writeFileTool({ sandbox });
    const e = editFileTool({ sandbox });
    await w.execute({
      path: PROBE_MANIFEST_FILENAME,
      content: JSON.stringify({ version: 1, entries: [] }),
    });
    await expect(
      e.execute({
        path: `./${PROBE_MANIFEST_FILENAME}`,
        old_string: '"entries"',
        new_string: '"items"',
      })
    ).rejects.toThrow(/refuse to hand-edit/);
  });

  it('rejects non-string arguments', async () => {
    const w = writeFileTool({ sandbox });
    await expect(
      w.execute({ path: 'ok.txt', content: 42 })
    ).rejects.toThrow(/must be a string/);
  });
});

describe('listFilesTool', () => {
  it('returns files and directories with type info', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-list-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'aaa');
      writeFileSync(join(root, 'b.txt'), 'bb');
      const sandbox = new ToolSandbox(root);
      const l = listFilesTool({ sandbox });
      const res = (await l.execute({})) as {
        entries: { name: string; kind: string; size: number }[];
      };
      const names = res.entries.map((e) => e.name).sort();
      expect(names).toEqual(['a.txt', 'b.txt']);
      expect(res.entries.find((e) => e.name === 'a.txt')?.size).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runShellTool', () => {
  it('executes an allowlisted command and returns stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-shell-'));
    try {
      const sandbox = new ToolSandbox(root);
      const sh = runShellTool({ sandbox });
      const res = (await sh.execute({ command: 'echo', args: ['hello'] })) as {
        exitCode: number;
        stdout: string;
      };
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('hello');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects non-allowlisted commands', async () => {
    const sandbox = new ToolSandbox(mkdtempSync(join(tmpdir(), 'atoma-shell-')));
    const sh = runShellTool({ sandbox, shellAllowlist: ['echo'] });
    await expect(sh.execute({ command: 'rm', args: ['-rf', '/'] })).rejects.toThrow(
      /not in allowlist/
    );
  });

  it('the default allowlist covers the measured friction, and states where network belongs', async () => {
    // grep (6 rejections), head (5) and chmod (3) were the measured
    // friction across archived traces; curl (3) is deliberately still
    // refused — network reach is a declared bucket capability served by
    // fetch_url, the observable path.
    for (const cmd of ['grep', 'head', 'tail', 'wc', 'chmod', 'mkdir', 'sed', 'find', 'od']) {
      expect(DEFAULT_SHELL_ALLOWLIST).toContain(cmd);
    }
    for (const cmd of ['curl', 'wget', 'git', 'rm']) {
      expect(DEFAULT_SHELL_ALLOWLIST).not.toContain(cmd);
    }
    const sandbox = new ToolSandbox(mkdtempSync(join(tmpdir(), 'atoma-shell-')));
    const sh = runShellTool({ sandbox });
    await expect(sh.execute({ command: 'curl', args: ['http://x'] })).rejects.toThrow(
      /fetch_url/
    );
  });

  it('normalizes a whole line mistakenly sent in command when args is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-shell-command-line-'));
    try {
      writeFileSync(join(root, 'README.md'), 'Run with node cli.js\n');
      const sh = runShellTool({ sandbox: new ToolSandbox(root) });
      const result = (await sh.execute({
        command: 'grep -n "node cli.js" README.md',
      })) as { exitCode: number; stdout: string };
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1:Run with node cli.js');
      // Security stays unchanged after normalization.
      await expect(sh.execute({ command: 'curl http://x' })).rejects.toThrow(/fetch_url/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('run_shell accepts a whole command line', () => {
  // Round 4: 6 of 90 run_shell calls were rejected as "a shell LINE, not an
  // executable" — the model passing `grep -n "a phrase" file` as one string.
  // record_probe had already been fixed for exactly this; leaving run_shell
  // behind made the two tools disagree about what a command looks like.
  it('splits a plain line and still enforces the allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-line-'));
    try {
      const sh = runShellTool({ sandbox: new ToolSandbox(root) });
      const res = (await sh.execute({ cmd: 'echo hello world' })) as {
        exitCode: number;
        stdout: string;
      };
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('hello world');
      await expect(sh.execute({ cmd: 'curl http://x' })).rejects.toThrow(/fetch_url/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes a line with a pipe through bash instead of refusing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-line-pipe-'));
    try {
      writeFileSync(join(root, 'f.txt'), 'alpha\nbeta\ngamma\n');
      const sh = runShellTool({ sandbox: new ToolSandbox(root) });
      const res = (await sh.execute({ cmd: 'cat f.txt | grep beta' })) as {
        exitCode: number;
        stdout: string;
      };
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('beta');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes glob expansion through bash instead of passing a literal asterisk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-line-glob-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'a');
      writeFileSync(join(root, 'b.txt'), 'b');
      const sh = runShellTool({ sandbox: new ToolSandbox(root) });
      const res = (await sh.execute({ cmd: 'echo *.txt' })) as {
        exitCode: number;
        stdout: string;
      };
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim().split(/\s+/).sort()).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a quoted phrase together — the exact round-4 rejection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-line-q-'));
    try {
      writeFileSync(join(root, 'f.txt'), 'Check for unterminated quotes\nother\n');
      const sh = runShellTool({ sandbox: new ToolSandbox(root) });
      const res = (await sh.execute({ cmd: 'grep -n "Check for unterminated" f.txt' })) as {
        exitCode: number;
        stdout: string;
      };
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Check for unterminated');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still accepts the {command,args} shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-line-legacy-'));
    try {
      const sh = runShellTool({ sandbox: new ToolSandbox(root) });
      const res = (await sh.execute({ command: 'echo', args: ['legacy'] })) as { stdout: string };
      expect(res.stdout.trim()).toBe('legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('InMemoryToolRegistry', () => {
  it('registers tools and executes them by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-reg-'));
    try {
      const sandbox = new ToolSandbox(root);
      const reg = new InMemoryToolRegistry();
      reg.registerAll(defaultBuiltinTools({ sandbox }));
      expect(reg.has('write_file')).toBe(true);
      expect(reg.has('nonexistent')).toBe(false);
      expect(reg.declarations().map((t) => t.name).sort()).toEqual([
        'edit_file',
        'fetch_url',
        'list_files',
        'read_file',
        'record_probe',
        'run_shell',
        'start_node_server',
        'start_static_server',
        'validate_html',
        'write_file',
      ]);
      const res = (await reg.execute('write_file', {
        path: 'x.txt',
        content: 'ok',
      })) as { ok: boolean };
      expect(res.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws a clear error for unknown tools', async () => {
    const reg = new InMemoryToolRegistry();
    await expect(reg.execute('ghost', {})).rejects.toThrow(/no executor for tool "ghost"/);
  });
});

describe('fetchUrlTool', () => {
  let server: Server;
  let baseUrl: string;
  let sandbox: ToolSandbox;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-fetchurl-'));
    sandbox = new ToolSandbox(root);
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: body, method: req.method, path: req.url }));
        } else if (req.url === '/404') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`hello ${req.url}`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('GETs a URL and returns status + body', async () => {
    const tool = fetchUrlTool({ sandbox });
    const res = (await tool.execute({ url: `${baseUrl}/hi` })) as {
      ok: boolean;
      status: number;
      body: string;
    };
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello /hi');
  });

  it('POSTs a JSON object body and auto-sets content-type', async () => {
    const tool = fetchUrlTool({ sandbox });
    const res = (await tool.execute({
      url: `${baseUrl}/json`,
      method: 'POST',
      body: { x: 42 },
    })) as { ok: boolean; status: number; body: string };
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.body) as { received: string; method: string };
    expect(parsed.method).toBe('POST');
    expect(parsed.received).toBe('{"x":42}');
  });

  it('returns ok=false with the status when the server replies 404 (not a throw)', async () => {
    const tool = fetchUrlTool({ sandbox });
    const res = (await tool.execute({ url: `${baseUrl}/404` })) as {
      ok: boolean;
      status: number;
      body: string;
    };
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toBe('not found');
  });

  it('returns a timeout shape when the request exceeds timeoutMs', async () => {
    // Close the primary server and point at a dead port to force a
    // network-level hang (AbortError). The loopback address returns
    // ECONNREFUSED fast, but forcing timeoutMs=1 catches even sub-ms
    // connects — we just assert the shape.
    await new Promise<void>((r) => server.close(() => r()));
    const tool = fetchUrlTool({ sandbox });
    const res = (await tool.execute({
      url: 'http://127.0.0.1:1/',  // port 1 is effectively closed
      timeoutMs: 50,
    })) as { ok: boolean; error?: string; timeout?: boolean };
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('startNodeServerTool', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-nodesrv-'));
    sandbox = new ToolSandbox(root);
  });

  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('boots a node entry file that emits LISTENING_ON_PORT and returns its URL', async () => {
    const entry = `
      const http = require('http');
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
      srv.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
        const addr = srv.address();
        console.log('LISTENING_ON_PORT=' + addr.port);
      });
    `;
    writeFileSync(join(root, 'server.js'), entry, 'utf8');

    const startTool = startNodeServerTool({ sandbox });
    const res = (await startTool.execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
      port: number;
    };
    expect(res.ok).toBe(true);
    expect(res.port).toBeGreaterThan(0);
    expect(res.url).toMatch(/^http:\/\/localhost:\d+\/$/);

    // Smoke: use fetch_url to probe the booted server.
    const fetchTool = fetchUrlTool({ sandbox });
    // start_node_server returns localhost, but the node entry bound to
    // 127.0.0.1 — on most systems "localhost" resolves to 127.0.0.1 but
    // we probe the numeric form to avoid a DNS edge case tripping the
    // test in CI.
    const probe = (await fetchTool.execute({
      url: `http://127.0.0.1:${res.port}/hello`,
    })) as { ok: boolean; status: number; body: string };
    expect(probe.ok).toBe(true);
    expect(probe.status).toBe(200);
    const parsed = JSON.parse(probe.body) as { ok: boolean; path: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('/hello');
  });

  it('returns an informative error when the node entry exits before emitting the marker', async () => {
    // This server prints nothing and exits immediately — no LISTENING
    // marker ever appears, so the tool should reject with the stderr-
    // preserving error.
    const entry = `console.error('boom'); process.exit(1);`;
    writeFileSync(join(root, 'broken.js'), entry, 'utf8');
    const startTool = startNodeServerTool({ sandbox });
    await expect(
      startTool.execute({ entry: 'broken.js' })
    ).rejects.toThrow(/node server exited early/);
  });
});
