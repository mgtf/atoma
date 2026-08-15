import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatRunStatsEpilogue,
  parseRunStatsEpilogue,
  type RunStats,
} from '../src/contracts/runStats.js';
import { parseRunLog, terminateRunProcessGroup } from '../src/cli/burnin.js';

/**
 * The signal-cancel accounting hole (2026-08-15, from the wedging
 * investigation): teardown closed the trace with the run's REAL totals but
 * printed no machine epilogue, so `parseRunLog` read outcome 'error' with
 * null economics — the trace and the CSV disagreed about the same run's
 * cost. Both overnight 2026-08-14 'error' rows were exactly this (operator
 * SIGTERMs at 817s/$0.377 and 27s/$0.060). Teardown now emits the epilogue
 * with the first-class outcome 'cancelled'.
 */

const cancelledStats: RunStats = {
  outcome: 'cancelled',
  costUsd: 0.1234,
  llmCalls: 3,
  opusCalls: 0,
  sonnetCalls: 0,
  haikuCalls: 0,
  otherCalls: 3,
  deterministicPhases: 0,
  escalations: 0,
  learnedSkills: 0,
  learnedEventSkills: 0,
  promotions: 0,
  refusals: 0,
  compileErrors: 0,
  demotions: 0,
  dispatchFallbacks: 0,
};

describe('cancelled runs keep their economics', () => {
  it('the epilogue round-trips outcome "cancelled" and parseRunLog prefers it', () => {
    const line = formatRunStatsEpilogue(cancelledStats);
    expect(parseRunStatsEpilogue(line)?.outcome).toBe('cancelled');
    const parsed = parseRunLog('shutting down sandbox children...\n' + line);
    expect(parsed.outcome).toBe('cancelled');
    expect(parsed.costUsd).toBe(0.1234);
    expect(parsed.llmCalls).toBe(3);
  });

  /**
   * The real boundary: a REAL runner child, killed mid-flight through the
   * SAME primitive the burn-in harness and the MCP server use
   * (terminateRunProcessGroup → SIGTERM to the group). A local ollama stub
   * completes exactly one LLM call and hangs the second, so the kill lands
   * with paid usage on the books and one call in flight — the overnight
   * shape. Asserts the CSV side (parseRunLog on captured output) and the
   * trace side agree on outcome and cost.
   */
  it('a SIGTERMed child leaves a parseable "cancelled" epilogue whose cost matches its trace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-cancel-epilogue-'));
    const runsDir = join(root, 'runs');
    const hangingSockets: Socket[] = [];
    let calls = 0;
    let signalSecondCall: () => void = () => {};
    const secondCallInFlight = new Promise<void>((resolve) => {
      signalSecondCall = resolve;
    });
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls++;
        if (calls === 1) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              model: 'stub-model',
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: '{"outcome":"escalate"}' },
              done: true,
              prompt_eval_count: 100,
              eval_count: 50,
            })
          );
        } else {
          // Hang: keep the socket open so the child is mid-await when killed.
          hangingSockets.push(res.socket!);
          if (calls === 2) signalSecondCall();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const child = spawn(
      join('node_modules', '.bin', 'tsx'),
      [join('src', 'cli', 'build-app.ts'), 'regression: cancel mid-flight'],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ATOMA_LLM: 'ollama',
          OLLAMA_BASE_URL: `http://127.0.0.1:${port}`,
          OLLAMA_MODEL: 'stub-model',
          ATOMA_DB_PATH: join(root, 'atoma.db'),
          ATOMA_SKILLS_DIR: join(root, 'skills'),
          ATOMA_RUNS_DIR: runsDir,
          ATOMA_BUILD_WORKSPACE: join(root, 'workspace'),
          // Generous deadline: neither the advisory abort nor the watchdog
          // may fire — this test is about the SIGNAL path only.
          ATOMA_BUILD_TIMEOUT_MS: '120000',
        },
      }
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

    try {
      // One call paid, one in flight — now kill the group like the harness does.
      await secondCallInFlight;
      // Generous grace: teardown must get to print before SIGKILL escalation.
      await terminateRunProcessGroup(child.pid!, 15_000, 5_000);
      await exited;

      const stats = parseRunLog(output);
      expect(stats.outcome).toBe('cancelled');
      expect(stats.llmCalls).toBe(1);
      expect(stats.costUsd).not.toBeNull();

      const traceName = readdirSync(runsDir).find(
        (name) => name.endsWith('.json') && name !== 'index.json'
      );
      expect(traceName).toBeDefined();
      const trace = JSON.parse(readFileSync(join(runsDir, traceName!), 'utf8')) as {
        cancelled?: boolean;
        totals?: { calls: number; costUsd: number };
      };
      expect(trace.cancelled).toBe(true);
      // THE invariant: trace and CSV never disagree about one run's cost.
      expect(trace.totals?.calls).toBe(stats.llmCalls);
      expect(Number((trace.totals?.costUsd ?? NaN).toFixed(4))).toBe(stats.costUsd);
    } finally {
      for (const socket of hangingSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
