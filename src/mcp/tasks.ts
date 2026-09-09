import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { CreateTaskOptions, TaskRequestHandlerExtra, TaskStore, ToolTaskHandler } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { retrievalRegistrationSchema } from '../contracts/retrievalCampaign.js';
import type { RetrievalCampaignStart } from '../cli/retrievalCampaignHost.js';
import { ProjectHttpError } from '../projects/service.js';
import type { Viewer } from '../auth/store.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  RunRejected,
  MAX_GOAL_CHARS,
  cancelRun as cancelOperatorRun,
  onRunFinished,
  onRunOutput,
  runStatus,
  type RunRecordPublic,
  type StartRunInput,
} from './run.js';

/**
 * RUNS ARE MCP TASKS (spec 2025-11-25, SDK experimental).
 *
 * A run takes minutes. A TASK is the protocol's own name for that shape: the
 * tool call answers with a task id, `tasks/get` reports `working` with a
 * status line, `tasks/result` blocks until the terminal result, `tasks/cancel`
 * stops the work. Both start tools ARE tasks; there is no separate "start,
 * then poll" contract and no long-poll — a host that speaks tasks needs no
 * atoma-specific polling logic, and the status tools are plain readers.
 *
 * WHAT A TASK IS HERE. `createTask` calls the very `startRun` /
 * `startProjectRunFromInput` the HTTP routes call, the run is the same record
 * in `run.ts` or the same row in the tenant store, and the result is the same
 * status payload the status tool answers. Cancelling the task cancels the run
 * through the same `cancelRun` / `cancelProjectRun` the cancel tools use.
 *
 * TASKS LIVE WITH THE SESSION. The store is in memory and per session, like
 * the session itself, the event ring and the subscriptions: a restart forgets
 * the task ids, never the runs, which stay reachable by run id through the
 * status tools and the resources. A task's `ttl` is the run's timeout plus a
 * margin, so a host that comes back late still finds the result.
 *
 * THE SDK'S CANCEL ONLY FLIPS THE STORE. `tasks/cancel` marks the task
 * cancelled and nothing more; the store here intercepts that transition and
 * cancels the run behind it. A cancelled task has no result by the SDK's own
 * rule (results are stored once, never on a terminal task), so its final
 * word is `tasks/get`, and the run's own final status stays readable through
 * the status tool.
 *
 * `taskSupport: 'optional'` is the SPEC'S fallback, not a second contract: a
 * host that does not augment the call gets the SDK's own drive and the
 * terminal result when the run ends — a synchronous run, minutes long, over a
 * stream that keeps alive and replays.
 */

/** How long a finished task's result stays readable after the run ends. */
export const TASK_RESULT_GRACE_MS = 10 * 60 * 1000;
/** How often `tasks/result` re-checks a working task, and how often the project watcher reads the store. */
export const TASK_POLL_INTERVAL_MS = 2_000;
/** The status line is model output; it is bounded like every tail. */
const STATUS_LINE_CHARS = 200;

/**
 * The SDK's in-memory store with ONE addition: a hook on the transition to
 * `cancelled`, so `tasks/cancel` reaches the run. Everything else is the
 * reference behaviour — ids, ttl sweeps, the once-only result.
 */
export class SessionTaskStore implements TaskStore {
  private readonly inner = new InMemoryTaskStore();
  private readonly cancelHooks = new Map<string, () => void>();

  onCancel(taskId: string, hook: () => void): void {
    this.cancelHooks.set(taskId, hook);
  }

  createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
    return this.inner.createTask(taskParams, requestId, request, sessionId);
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return this.inner.getTask(taskId, sessionId);
  }

  async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string): Promise<void> {
    await this.inner.storeTaskResult(taskId, status, result, sessionId);
    this.cancelHooks.delete(taskId);
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.inner.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void> {
    await this.inner.updateTaskStatus(taskId, status, statusMessage, sessionId);
    if (status === 'cancelled') {
      const hook = this.cancelHooks.get(taskId);
      this.cancelHooks.delete(taskId);
      hook?.();
    }
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.inner.listTasks(cursor, sessionId);
  }

  /** Clears the ttl timers; called when the session's server closes. */
  close(): void {
    this.inner.cleanup();
    this.cancelHooks.clear();
  }
}

/** The capability a server declares to accept task-augmented `tools/call`, and to list and cancel. */
export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } } as const;

type ToolResult = CallToolResult;

function jsonResult(payload: unknown): ToolResult {
  const structured =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? { structuredContent: payload as Record<string, unknown> } : {};
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...structured };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A status line for `tasks/get`: bounded, and honest that it is model output. */
function statusLine(prefix: string, tail: string): string {
  const line = tail.replace(/\s+/g, ' ').trim().slice(-STATUS_LINE_CHARS);
  return line.length > 0 ? `${prefix} — untrusted model output: ${line}` : prefix;
}

/** Fire-and-forget store updates: a task that vanished (ttl, cancel) must never throw into a listener. */
function quietly(work: () => Promise<unknown>): void {
  void work().catch(() => {});
}

/**
 * Shared skeleton: `getTask` and `getTaskResult` read the store, and every
 * handler's `createTask` is the start followed by a lifecycle watcher. A
 * domain refusal becomes a task that is created and fails at once with an
 * `isError` result, so a host drives one path.
 */
function handlerWith<Args extends z.ZodRawShape>(createTask: ToolTaskHandler<Args>['createTask']): ToolTaskHandler<Args> {
  const getTask = async (_args: unknown, extra: TaskRequestHandlerExtra) => ({ ...(await extra.taskStore.getTask(extra.taskId)) });
  const getTaskResult = async (_args: unknown, extra: TaskRequestHandlerExtra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
  return { createTask, getTask, getTaskResult } as ToolTaskHandler<Args>;
}

export interface RunTaskHost {
  readonly store: SessionTaskStore;
  /** Told when a run started here should be followed by the session's logging. */
  readonly follow: (runId: string) => void;
  /** Registered cleanups run when the session's server closes. */
  readonly cleanups: (() => void)[];
}

export const BENCHMARK_RUN_INPUT = { registration: retrievalRegistrationSchema };

/** Registered campaigns use the same task/cancellation protocol as runs. */
export function benchmarkRunTaskHandler(host: RunTaskHost, start: RetrievalCampaignStart): ToolTaskHandler<typeof BENCHMARK_RUN_INPUT> {
  return handlerWith<typeof BENCHMARK_RUN_INPUT>(async (args, extra) => {
    const task = await extra.taskStore.createTask({
      ttl: args.registration.spec.maxWallMs + TASK_RESULT_GRACE_MS, pollInterval: TASK_POLL_INTERVAL_MS,
    });
    const abort = new AbortController();
    host.store.onCancel(task.taskId, () => abort.abort());
    await extra.taskStore.updateTaskStatus(task.taskId, 'working', `campaign ${args.registration.spec.id} validating`);
    // A disconnected session stops observing; it does not cancel the campaign.
    let observing = true;
    host.cleanups.push(() => { observing = false; });
    const progress = (message: string) => {
      if (observing) quietly(() => extra.taskStore.updateTaskStatus(task.taskId, 'working', message));
    };
    void Promise.resolve().then(() => start(args.registration, abort.signal, progress)).then(
      report => { if (observing) quietly(() => extra.taskStore.storeTaskResult(task.taskId,
        report.reason === 'completed' ? 'completed' : 'failed', jsonResult(report))); },
      error => { if (observing) quietly(() => extra.taskStore.storeTaskResult(task.taskId, 'failed',
        errorResult(`campaign refused or aborted: ${String(error).slice(0, 1000)}`))); }
    );
    return { task: await extra.taskStore.getTask(task.taskId) };
  });
}

/* -------------------------------------------------------------- operator */

/** The start tools' arguments, defined once here and imported by the catalogue. */
export const OPERATOR_RUN_INPUT = {
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  family: z.string().optional(),
  timeoutMs: z.number().int().positive().optional().describe(`Default ${DEFAULT_RUN_TIMEOUT_MS}.`),
  keepWorkspace: z.boolean().optional(),
  learnSkills: z.boolean().optional(),
  promoteSkills: z.boolean().optional(),
  directSkills: z.boolean().optional(),
  container: z.boolean().optional(),
  egress: z.boolean().optional(),
};

export const PROJECT_RUN_INPUT = {
  projectId: z.string().min(1),
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  idempotencyKey: z.string().min(1).max(200).optional().describe('Idempotency key; the same key returns the same run.'),
};

/**
 * `atoma_operator_run_start`: the watcher turns each output chunk into the
 * task's status line and the run's end into the task's result — the
 * `atoma_operator_run_status` payload.
 */
export function operatorRunTaskHandler(
  host: RunTaskHost,
  start: (args: StartRunInput) => Promise<RunRecordPublic>
): ToolTaskHandler<typeof OPERATOR_RUN_INPUT> {
  return handlerWith<typeof OPERATOR_RUN_INPUT>(async (args, extra) => {
    const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const task = await extra.taskStore.createTask({ ttl: timeoutMs + TASK_RESULT_GRACE_MS, pollInterval: TASK_POLL_INTERVAL_MS });
    let record: RunRecordPublic;
    try {
      record = await start(args);
    } catch (error) {
      if (error instanceof RunRejected) {
        await extra.taskStore.storeTaskResult(task.taskId, 'failed', errorResult(`refused: ${error.message}`));
        return { task: await extra.taskStore.getTask(task.taskId) };
      }
      throw error;
    }
    host.follow(record.runId);
    host.store.onCancel(task.taskId, () => void cancelOperatorRun({ runId: record.runId }));
    const unhookOutput = onRunOutput((update) => {
      if (update.runId !== record.runId) return;
      quietly(() => extra.taskStore.updateTaskStatus(task.taskId, 'working', statusLine(`run ${record.runId} running, ${update.chunks} chunks`, update.tail)));
    });
    const unhookFinish = onRunFinished((finished) => {
      if (finished.runId !== record.runId) return;
      unhookOutput();
      unhookFinish();
      const status = finished.status === 'finished' ? 'completed' : 'failed';
      quietly(() => extra.taskStore.storeTaskResult(task.taskId, status, jsonResult(runStatus({ runId: record.runId }))));
    });
    host.cleanups.push(unhookOutput, unhookFinish);
    await extra.taskStore.updateTaskStatus(task.taskId, 'working', `run ${record.runId} started (${record.family})`);
    return { task: await extra.taskStore.getTask(task.taskId) };
  });
}

/* --------------------------------------------------------------- project */

export interface ProjectRunTaskDeps {
  readonly viewer: () => Viewer;
  readonly service: {
    startProjectRunFromInput(viewer: Viewer, projectId: string, body: unknown): Promise<unknown>;
    projectRunStatus(viewer: Viewer, projectId: string, projectRunId: string): unknown;
    cancelProjectRun(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown>;
  };
  /** Injectable clock for the poller; production uses `setTimeout`. */
  readonly pollMs?: number;
}

const PROJECT_TERMINAL = new Set(['delivered', 'failed', 'cancelled']);

/**
 * `atoma_run_start`: the watcher reads the tenant store once every
 * `pollInterval` — the truth about a project run lives there, not in this
 * process — and ends the task when the run reaches a terminal status, with
 * the `atoma_run_status` payload as the result. The poll stops with the task
 * (result stored, cancelled, swept) or with the session.
 */
export function projectRunTaskHandler(host: RunTaskHost, deps: ProjectRunTaskDeps): ToolTaskHandler<typeof PROJECT_RUN_INPUT> {
  const pollMs = deps.pollMs ?? TASK_POLL_INTERVAL_MS;
  return handlerWith<typeof PROJECT_RUN_INPUT>(async (args, extra) => {
    const task = await extra.taskStore.createTask({ ttl: DEFAULT_RUN_TIMEOUT_MS + TASK_RESULT_GRACE_MS, pollInterval: pollMs });
    const viewer = deps.viewer();
    let started: { projectRunId: string; status: string };
    try {
      started = (await deps.service.startProjectRunFromInput(viewer, args.projectId, {
        goal: args.goal,
        idempotencyKey: args.idempotencyKey ?? `mcp-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      })) as { projectRunId: string; status: string };
    } catch (error) {
      if (error instanceof ProjectHttpError) {
        await extra.taskStore.storeTaskResult(task.taskId, 'failed', errorResult(`refused (${error.status}): ${error.message}`));
        return { task: await extra.taskStore.getTask(task.taskId) };
      }
      throw error;
    }
    const runId = started.projectRunId;
    host.store.onCancel(task.taskId, () => void deps.service.cancelProjectRun(viewer, args.projectId, runId).catch(() => {}));
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    const stop = (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    host.cleanups.push(stop);
    let lastStatus = started.status;
    const tick = (): void => {
      if (stopped) return;
      let snapshot: { status: string } | null = null;
      try {
        snapshot = deps.service.projectRunStatus(viewer, args.projectId, runId) as { status: string };
      } catch {
        // The run row vanished or the viewer lost access: the task cannot follow it any more.
        stop();
        quietly(() => extra.taskStore.storeTaskResult(task.taskId, 'failed', errorResult(`run ${runId} is no longer readable`)));
        return;
      }
      if (snapshot.status !== lastStatus) {
        lastStatus = snapshot.status;
        quietly(() => extra.taskStore.updateTaskStatus(task.taskId, 'working', `run ${runId} ${snapshot.status}`));
      }
      if (PROJECT_TERMINAL.has(snapshot.status)) {
        stop();
        quietly(() => extra.taskStore.storeTaskResult(task.taskId, snapshot.status === 'delivered' ? 'completed' : 'failed', jsonResult(snapshot)));
        return;
      }
      timer = setTimeout(tick, pollMs);
      timer.unref();
    };
    await extra.taskStore.updateTaskStatus(task.taskId, 'working', `run ${runId} ${started.status}`);
    timer = setTimeout(tick, pollMs);
    timer.unref();
    return { task: await extra.taskStore.getTask(task.taskId) };
  });
}

/* --------------------------------------------------------------- logging */

/**
 * `notifications/message` for the runs a session started. The session's
 * client sets the level it wants (`logging/setLevel`) and the SDK filters by
 * it; without a level, everything at `info` and above goes out. Each chunk is
 * one message under the logger `atoma.run.<runId>`, and the run's end is one
 * `notice`. Only runs THIS session started are followed: a session that never
 * started a run hears nothing about the machine's other runs.
 */
export function attachRunLogging(server: McpServer, cleanups: (() => void)[]): (runId: string) => void {
  const followed = new Set<string>();
  const sessionId = (): string | undefined => server.server.transport?.sessionId;
  cleanups.push(
    onRunOutput((update) => {
      if (!followed.has(update.runId)) return;
      void server
        .sendLoggingMessage(
          { level: 'info', logger: `atoma.run.${update.runId}`, data: { runId: update.runId, chunk: update.chunk, chunks: update.chunks, untrusted: true } },
          sessionId()
        )
        .catch(() => {});
    }),
    onRunFinished((record) => {
      if (!followed.delete(record.runId)) return;
      void server
        .sendLoggingMessage(
          { level: 'notice', logger: `atoma.run.${record.runId}`, data: { runId: record.runId, status: record.status, ...(record.trace ? { trace: record.trace } : {}) } },
          sessionId()
        )
        .catch(() => {});
    })
  );
  return (runId) => followed.add(runId);
}
