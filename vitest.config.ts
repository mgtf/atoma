import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Isolate the lifecycle ledger: without this, every registry-touching
    // test appends events to the developer's real ./atoma-ledger.jsonl
    // (observed: 575 garbage events after one suite run). Tests that
    // exercise the ledger itself override the var per-test with a temp
    // path; this default only has to keep the noise out of the repo root.
    env: {
      ATOMA_LEDGER_PATH: './node_modules/.atoma-test-ledger.jsonl',
    },
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
  },
});
