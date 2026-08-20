import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCheckoutDotenv, parseDotenv } from '../src/cli/loadDotenv.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-dotenv-'));
  roots.push(root);
  return root;
}

describe('checkout .env parser', () => {
  it('parses comments, export, quotes, escapes and inline comments', () => {
    expect(
      parseDotenv(`
# ignore
export ATOMA_VIZ_AUTH=1
ATOMA_VIZ_PUBLIC_ORIGIN=http://127.0.0.1:5173 # Vite origin
ATOMA_AUTH_GITHUB_CLIENT_SECRET="s3cr\\"et"
EMPTY=
QUOTED_EMPTY=""
MULTILINE="-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----"
SINGLE='keep\\nraw'
`)
    ).toEqual({
      ATOMA_VIZ_AUTH: '1',
      ATOMA_VIZ_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      ATOMA_AUTH_GITHUB_CLIENT_SECRET: 's3cr"et',
      EMPTY: '',
      QUOTED_EMPTY: '',
      MULTILINE: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----',
      SINGLE: 'keep\\nraw',
    });
  });

  it('accepts a real newline inside double quotes', () => {
    expect(parseDotenv('KEY="a\nb"')).toEqual({ KEY: 'a\nb' });
  });

  it('fills only unset keys and is a no-op when the file is missing', () => {
    const cwd = tempDir();
    const env: NodeJS.ProcessEnv = { ATOMA_VIZ_API_PORT: '9999' };
    expect(applyCheckoutDotenv(env, { cwd })).toBeNull();
    expect(env['ATOMA_VIZ_AUTH']).toBeUndefined();

    writeFileSync(
      join(cwd, '.env'),
      'ATOMA_VIZ_AUTH=1\nATOMA_VIZ_API_PORT=4111\nATOMA_AUTH_GITHUB_CLIENT_ID=from-file\n',
      'utf8'
    );
    expect(applyCheckoutDotenv(env, { cwd })).toBe(join(cwd, '.env'));
    expect(env['ATOMA_VIZ_AUTH']).toBe('1');
    expect(env['ATOMA_VIZ_API_PORT']).toBe('9999');
    expect(env['ATOMA_AUTH_GITHUB_CLIENT_ID']).toBe('from-file');
  });

  it('stays inert under VITEST so process-level harnesses cannot inherit a developer .env', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, '.env'), 'ATOMA_VIZ_AUTH=1\n', 'utf8');
    const env: NodeJS.ProcessEnv = { VITEST: 'true' };
    expect(applyCheckoutDotenv(env, { cwd })).toBeNull();
    expect(env['ATOMA_VIZ_AUTH']).toBeUndefined();
  });
});

describe('operator launchers apply checkout .env; the viz server does not', () => {
  it('keeps the load site on launchers that the operator actually runs', () => {
    expect(readFileSync('scripts/viz-dev.mjs', 'utf8')).toMatch(/applyCheckoutDotenv/);
    expect(readFileSync('src/cli/doctor.ts', 'utf8')).toMatch(/applyCheckoutDotenv/);
    expect(readFileSync('src/cli/auth.ts', 'utf8')).toMatch(/applyCheckoutDotenv/);
    expect(readFileSync('src/viz/server.ts', 'utf8')).not.toMatch(/applyCheckoutDotenv/);
    expect(readFileSync('package.json', 'utf8')).toMatch(
      /"viz": "node --import tsx scripts\/viz-dev\.mjs"/
    );
  });
});
