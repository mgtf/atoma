import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import viteConfig, { ATOMA_RELEASE_VERSION } from '../vite.config.js';

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

describe('visualizer release version', () => {
  it('injects the package version into the compiled client', () => {
    expect(ATOMA_RELEASE_VERSION).toBe(packageMetadata.version);
    expect(viteConfig.define?.['__ATOMA_RELEASE_VERSION__']).toBe(
      JSON.stringify(packageMetadata.version)
    );
  });
});
