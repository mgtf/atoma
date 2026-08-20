/**
 * Fill unset process-env keys from a checkout `.env`.
 *
 * Node never loads dotenv itself. Production injects the process environment
 * (systemd, Docker, the platform). Operator source launchers apply this file
 * so a local `npm run viz` can be GitHub-gated without exporting the shell.
 *
 * Do not call this from `src/viz/server.ts`: process-level tests spawn that
 * file from the repository cwd with a cleaned env, and a developer `.env`
 * with `ATOMA_VIZ_AUTH=1` would close the open-localhost path they assert.
 *
 * Existing keys win. `VITEST` skips the file so harnesses stay hermetic.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ApplyCheckoutDotenvOptions {
  cwd?: string;
  filename?: string;
}

export function parseDotenv(source: string): Record<string, string> {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const out: Record<string, string> = {};
  let i = 0;
  const n = text.length;

  const skipSpace = (): void => {
    while (i < n) {
      const c = text[i];
      if (c !== ' ' && c !== '\t') break;
      i += 1;
    }
  };

  while (i < n) {
    while (i < n) {
      const c = text[i];
      if (c !== '\n' && c !== '\r' && c !== ' ' && c !== '\t') break;
      i += 1;
    }
    if (i >= n) break;
    if (text[i] === '#') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (text.startsWith('export', i)) {
      const after = text[i + 6];
      if (after === ' ' || after === '\t') {
        i += 6;
        skipSpace();
      }
    }
    const keyStart = i;
    const first = text[i];
    if (!first || !/[A-Za-z_]/.test(first)) {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    i += 1;
    while (i < n) {
      const c = text[i];
      if (!c || !/[A-Za-z0-9_]/.test(c)) break;
      i += 1;
    }
    const key = text.slice(keyStart, i);
    skipSpace();
    if (text[i] !== '=') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    i += 1;
    skipSpace();
    let value = '';
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      while (i < n) {
        const c = text[i];
        if (c === undefined) break;
        if (c === '\\' && quote === '"') {
          const next = text[i + 1];
          if (next === 'n') {
            value += '\n';
            i += 2;
            continue;
          }
          if (next === 'r') {
            value += '\r';
            i += 2;
            continue;
          }
          if (next === 't') {
            value += '\t';
            i += 2;
            continue;
          }
          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
          if (next !== undefined) {
            value += next;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
    } else {
      const valueStart = i;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1;
      value = text.slice(valueStart, i).trimEnd();
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    if (KEY.test(key)) out[key] = value;
  }
  return out;
}

export function applyCheckoutDotenv(
  env: NodeJS.ProcessEnv = process.env,
  options: ApplyCheckoutDotenvOptions = {}
): string | null {
  if (env['VITEST']) return null;
  const file = resolve(options.cwd ?? process.cwd(), options.filename ?? '.env');
  if (!existsSync(file)) return null;
  const parsed = parseDotenv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}
