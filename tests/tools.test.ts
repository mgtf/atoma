import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import {
  defaultBuiltinTools,
  writeFileTool,
  readFileTool,
  listFilesTool,
  runShellTool,
} from '../src/tools/builtin.js';

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

  it('rejects non-string arguments', async () => {
    const w = writeFileTool({ sandbox });
    await expect(
      w.execute({ path: 'ok.txt', content: 42 as unknown as string })
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
        'list_files',
        'read_file',
        'run_shell',
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
