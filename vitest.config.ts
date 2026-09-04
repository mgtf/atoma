import { defineConfig } from 'vitest/config';
import type { Reporter, TestModule, TestRunEndReason, TestSpecification, Vitest } from 'vitest/node';
import type { SerializedError } from 'vitest';

/**
 * Every test file vitest QUEUED must come back with a result. A worker that
 * dies without reporting shrinks the suite while the run stays green — the
 * gate then says "passed" about files it never executed (measured on a
 * Windows host, 2026-08-30: 237 of 238 collected files reported and the
 * missing file's 31 tests silently did not run). Vitest propagates an error
 * thrown by a user reporter out of `start()`, which is what turns the
 * mismatch into a red run. Comparing against `onTestRunStart`'s own queue —
 * rather than a directory glob — keeps filtered invocations
 * (`vitest run tests/one.test.ts`) honest for free.
 */
export class DiscoveryReporter implements Reporter {
  private queued: string[] = [];
  private sharded = false;

  onInit(vitest: Vitest): void {
    // `--shard` hands the FULL pre-shard specification list to
    // onTestRunStart and then, by design, only this shard's modules to
    // onTestRunEnd — a mismatch that is deliberate narrowing, not loss.
    // Nothing in this repo shards today; the guard keeps the reporter from
    // reddening a healthy shard the day something does.
    this.sharded = vitest.config.shard != null;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.queued = specifications.map((specification) => specification.moduleId);
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason
  ): void {
    if (this.sharded || reason === 'interrupted') return;
    const reported = new Set(testModules.map((module) => module.moduleId));
    const missing = this.queued.filter((moduleId) => !reported.has(moduleId));
    if (missing.length === 0) return;
    const message =
      `${missing.length} queued test file(s) never reported a result: ${missing.join(', ')}`;
    if (reason === 'failed') {
      // The run is already red; name the dropped files without burying the
      // failure that made it red.
      console.error(`discovery: ${message}`);
      return;
    }
    throw new Error(`discovery: ${message}`);
  }
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default', new DiscoveryReporter()],
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
