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
      // The ledger is a TABLE in the store now (src/core/ledger.ts), so the
      // isolation pin had to follow it from a file path to a DB path. Same
      // reason as before: without it, every registry-touching test appends
      // lifecycle events to the developer's real store (observed: 575 garbage
      // events after one suite run). AtomRegistry no longer needs this — it
      // writes through its own handle, so a `:memory:` fixture is isolated by
      // construction — but SkillRegistry has no store handle and still
      // resolves a default.
      ATOMA_LEDGER_DB: './node_modules/.atoma-test-ledger.db',
      // Same isolation story for the prefilter decision cache — and OFF, not
      // just relocated: mock-driven tests enqueue prefilter responses and
      // assert exact LLM call counts, so a shared cache would make test
      // order change which calls fire. Cache tests re-enable it per-test.
      ATOMA_PREFILTER_CACHE: '0',
    },
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
  },
});
