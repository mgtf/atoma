import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { defaultBuiltinTools, unescapeJsonish } from '../src/tools/builtin.js';

/**
 * `edit_file`'s most common failure, and why naming it was not enough.
 *
 * The error already said "common cause: WRONG ESCAPING". The model read that
 * and re-sent the same broken span. Measured over the last 40 runs on
 * 2026-08-09: 9 of 10 `old_string not found` failures carried two-character
 * `\n` sequences where the file has real newlines — six runs across two
 * consecutive days, which is exactly the threshold CLAUDE.md sets for acting
 * on a friction signature.
 *
 * So when the defect is PROVABLE for the call in hand — un-escaping the
 * argument matches exactly once — the tool now returns the verbatim bytes to
 * copy instead of a description of the class. A diagnosis the model has to
 * act on from memory is weaker than the span it needs.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): ToolSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-edit-'));
  dirs.push(dir);
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c, 'utf8');
  return new ToolSandbox(dir);
}

function editTool(sandbox: ToolSandbox) {
  return defaultBuiltinTools({ sandbox }).find((t) => t.declaration.name === 'edit_file')!;
}

describe('unescapeJsonish', () => {
  it('undoes exactly one level of the sequences seen in real failures', () => {
    expect(unescapeJsonish('a\\nb')).toBe('a\nb');
    expect(unescapeJsonish('say \\"hi\\"')).toBe('say "hi"');
    expect(unescapeJsonish('a\\tb')).toBe('a\tb');
    expect(unescapeJsonish('back\\\\slash')).toBe('back\\slash');
  });

  it('leaves a clean string alone', () => {
    expect(unescapeJsonish('real\nnewline')).toBe('real\nnewline');
  });
});

describe('edit_file diagnoses a provable double-escape', () => {
  // Shape taken from a real failing call (run 2026-08-09T04-39, index.html).
  const css = [
    '<style>',
    '        .toggle.active::after {',
    "            content: '✓';",
    '        }',
    '</style>',
  ].join('\n');

  it('names the defect AND hands back the span to copy', async () => {
    const sandbox = workspace({ 'index.html': css });
    const broken = "        .toggle.active::after {\\n            content: '✓';\\n        }";
    let err = '';
    try {
      await editTool(sandbox).execute({
        path: 'index.html',
        old_string: broken,
        new_string: 'x',
      });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toMatch(/DOUBLE-ESCAPED/);
    // The point of the change: the fix is IN the message, not described.
    expect(err).toContain('---8<---');
    expect(err).toContain(".toggle.active::after {\n            content: '✓';");
    await sandbox.cleanup();
  });

  it('falls back to a non-double-escape message when un-escaping does not resolve it', async () => {
    const sandbox = workspace({ 'index.html': css });
    let err = '';
    try {
      await editTool(sandbox).execute({
        path: 'index.html',
        old_string: 'a span that is simply absent',
        new_string: 'x',
      });
    } catch (e) {
      err = (e as Error).message;
    }
    // The span resembles nothing in the file, so there are no real bytes to
    // hand back and re-reading IS the right advice. What must not happen is a
    // double-escape claim the evidence does not support.
    expect(err).toMatch(/no region of the file resembles it/);
    expect(err).toMatch(/read_file/);
    expect(err).not.toMatch(/DOUBLE-ESCAPED/);
    await sandbox.cleanup();
  });

  it('does not claim a double-escape when the un-escaped span is ambiguous', async () => {
    // Two matches after un-escaping = we cannot prove which one was meant, so
    // handing one back would be a guess dressed as a diagnosis.
    const sandbox = workspace({ 'f.txt': 'a\nb\n---\na\nb\n' });
    let err = '';
    try {
      await editTool(sandbox).execute({ path: 'f.txt', old_string: 'a\\nb', new_string: 'x' });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).not.toMatch(/DOUBLE-ESCAPED/);
    await sandbox.cleanup();
  });

  it('a correct edit still just works', async () => {
    const sandbox = workspace({ 'f.txt': 'hello\nworld\n' });
    const r = (await editTool(sandbox).execute({
      path: 'f.txt',
      old_string: 'hello\nworld',
      new_string: 'bonjour\nmonde',
    })) as { ok?: boolean };
    expect(r.ok).not.toBe(false);
    await sandbox.cleanup();
  });
});
