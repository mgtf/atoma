import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { editFileTool, defaultBuiltinTools } from '../src/tools/builtin.js';

/**
 * Tests for the `edit_file` tool (#6 of the cost review) — targeted
 * str_replace editing so revision cycles stop re-emitting whole files
 * through write_file (full content billed as output tokens on every
 * retouch — the dominant spend of long L1 tool loops).
 */

describe('edit_file', () => {
  let dir: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-edit-'));
    sandbox = new ToolSandbox(dir);
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    writeFileSync(join(dir, rel), content, 'utf8');
  }

  it('replaces a unique exact span', async () => {
    write('app.js', `const port = 3000;\nconsole.log('up');\n`);
    const tool = editFileTool({ sandbox });
    const res = (await tool.execute({
      path: 'app.js',
      old_string: 'const port = 3000;',
      new_string: 'const port = Number(process.env.PORT) || 3000;',
    })) as { ok: boolean; replacements: number };
    expect(res.ok).toBe(true);
    expect(res.replacements).toBe(1);
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe(
      `const port = Number(process.env.PORT) || 3000;\nconsole.log('up');\n`
    );
  });

  it('errors with a coaching message when old_string is not found', async () => {
    write('a.txt', 'hello world');
    const tool = editFileTool({ sandbox });
    await expect(
      tool.execute({ path: 'a.txt', old_string: 'goodbye', new_string: 'x' })
    ).rejects.toThrow(/not found in "a\.txt".*read_file/s);
  });

  it('errors on an ambiguous (multi-match) old_string without replace_all', async () => {
    write('a.txt', 'first context\nfoo\nmiddle\nsecond context\nfoo\nend\n');
    const tool = editFileTool({ sandbox });
    await expect(
      tool.execute({ path: 'a.txt', old_string: 'foo', new_string: 'baz' })
    ).rejects.toThrow(
      /matches 2 times.*replace_all=true.*occurrence 1 near line 2.*first context.*occurrence 2 near line 5.*second context/s
    );
  });

  it('replace_all substitutes every occurrence', async () => {
    write('a.txt', 'foo bar foo');
    const tool = editFileTool({ sandbox });
    const res = (await tool.execute({
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'baz',
      replace_all: true,
    })) as { replacements: number };
    expect(res.replacements).toBe(2);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('baz bar baz');
  });

  it('errors on a missing file (points at write_file)', async () => {
    const tool = editFileTool({ sandbox });
    await expect(
      tool.execute({ path: 'ghost.txt', old_string: 'a', new_string: 'b' })
    ).rejects.toThrow(/no such file.*write_file/s);
  });

  it('is part of the default builtin toolset', () => {
    const names = defaultBuiltinTools({ sandbox }).map((t) => t.declaration.name);
    expect(names).toContain('edit_file');
    // write_file stays — edit_file complements it for revisions.
    expect(names).toContain('write_file');
  });
});
