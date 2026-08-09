/**
 * Container-side tool worker.
 *
 * Runs INSIDE the run's container and is the only thing there: it holds a
 * `ToolSandbox` rooted at the mounted workspace, registers the ordinary
 * builtins, and serves tool invocations over stdio. The control plane — the
 * supervise loop, the LLM calls, the atom registry and the skill store —
 * stays outside and reaches it through `ContainerToolExecutor`.
 *
 * The split exists because `run_shell`'s child is not jailed to the
 * workspace: it is spawned with `cwd` and nothing more, so in a single
 * process the stores are always one filesystem walk away. Moving the tool
 * layer into a container with only the workspace mounted, and no network
 * route out, is what makes that walk find nothing.
 *
 * STDOUT IS THE PROTOCOL. The logger below writes to stderr for exactly that
 * reason; a builtin that printed to stdout would corrupt the stream.
 */
import { createInterface } from 'node:readline';
import { ToolSandbox } from './sandbox.js';
import { defaultBuiltinTools } from './builtin.js';
import { InMemoryToolRegistry } from './registry.js';
import { encodeMessage, type ToolCallRequest } from './containerProtocol.js';
import type { Logger } from '../core/types.js';

const stderrLogger: Logger = {
  debug: (m, meta) => process.stderr.write(`[worker] ${m} ${meta ? JSON.stringify(meta) : ''}\n`),
  info: (m, meta) => process.stderr.write(`[worker] ${m} ${meta ? JSON.stringify(meta) : ''}\n`),
  warn: (m, meta) => process.stderr.write(`[worker:warn] ${m} ${meta ? JSON.stringify(meta) : ''}\n`),
  error: (m, meta) => process.stderr.write(`[worker:error] ${m} ${meta ? JSON.stringify(meta) : ''}\n`),
};

export function startWorker(root: string): void {
  const sandbox = new ToolSandbox(root);
  const registry = new InMemoryToolRegistry();
  registry.registerAll(defaultBuiltinTools({ sandbox, logger: stderrLogger }));

  process.stdout.write(
    encodeMessage({ ready: true, tools: registry.declarations(), root: sandbox.root })
  );

  // Requests are handled CONCURRENTLY and answered by id: the control plane
  // may pipeline, and a long `run_shell` must not head-of-line block a
  // `read_file` behind it. Ordering is the caller's business — that is what
  // the id is for.
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: ToolCallRequest;
    try {
      req = JSON.parse(trimmed) as ToolCallRequest;
    } catch {
      return; // not ours; the caller will time out on its id
    }
    void (async (): Promise<void> => {
      try {
        const result = await registry.execute(req.name, req.args ?? {});
        process.stdout.write(encodeMessage({ id: req.id, ok: true, result }));
      } catch (err) {
        process.stdout.write(
          encodeMessage({ id: req.id, ok: false, error: (err as Error).message })
        );
      }
    })();
  });

  // The container dies with its stdin. `sandbox.cleanup()` reaps tracked
  // children (servers the run started, headless Chrome) so the container can
  // exit instead of hanging on a live handle; the process-level SIGKILL
  // handler in sandbox.ts remains the backstop for the hard path.
  rl.on('close', () => {
    void sandbox.cleanup().finally(() => process.exit(0));
  });
}

// Entry point when the image runs this file directly.
if (process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1])) {
  startWorker(process.env['ATOMA_WORKER_ROOT'] ?? '/workspace');
}
