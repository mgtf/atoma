import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateHaystackConfig } from '../src/cli/haystackConfig.js';
import { haystackLaunchSchema } from '../src/contracts/retrievalHaystack.js';
import { verifyHaystackLaunch } from '../src/projects/retrievalRuntime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('host Haystack configuration', () => {
  it('generates pins through a real child and detects later model/runtime changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'haystack-config-')); roots.push(root);
    const python = join(root, 'python');
    const runtime = (digest: string) => writeFileSync(python, `#!${process.execPath}\nif(process.env.OPENAI_API_KEY || process.env.HOME || process.env.HF_HUB_OFFLINE !== '1') process.exit(1);\nconsole.log(JSON.stringify({sha256:${JSON.stringify(digest)}}));\n`, { mode: 0o700 });
    runtime('a'.repeat(64));
    const models = join(root, 'models'); mkdirSync(models); writeFileSync(join(models, 'weights'), 'original');
    const config = haystackLaunchSchema.parse(JSON.parse(await generateHaystackConfig([
      '--python', python, '--embedding', models, '--reranker', models, '--query-prefix', '',
    ])));
    await expect(verifyHaystackLaunch(config)).resolves.toBeUndefined();
    writeFileSync(join(models, 'weights'), 'changed');
    await expect(verifyHaystackLaunch(config)).rejects.toThrow('model content changed');
    runtime('b'.repeat(64));
    await expect(verifyHaystackLaunch(config)).rejects.toThrow('Python package identity changed');
  });
  it('refuses partial hybrid settings and unknown options', async () => {
    await expect(generateHaystackConfig(['--python', '/missing', '--embedding', '/models'])).rejects.toThrow('Hybrid mode requires');
    await expect(generateHaystackConfig(['--unknown'])).rejects.toThrow();
  });
});
