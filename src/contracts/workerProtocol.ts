import { z } from 'zod';
import type { Tool } from '../core/types.js';

/** Shared NDJSON wire: legacy stdio or a private launcher-issued Unix socket. */

/** Control plane → worker. */
export const WORKER_FRAME_BYTES = 32 * 1024 * 1024;
export const toolCallRequestSchema = z.object({
  id: z.number().int().positive(), name: z.string().min(1), args: z.record(z.string(), z.unknown()),
}).strict();
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;
/** Worker → control plane, one per request, id-matched. */
export interface ToolCallResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  /** Present iff `ok` is false. The executor rethrows it locally. */
  readonly error?: string;
}

/**
 * Worker → control plane, exactly once, before any response.
 *
 * The worker announces what it can do rather than the control plane assuming
 * it: the image decides which tools exist (a Chromium-less image has no
 * business claiming `validate_html`), and a declaration mismatch would
 * otherwise surface as a puzzling mid-run failure.
 */
export interface WorkerHello {
  readonly ready: true;
  readonly tools: Tool[];
  /** Sandbox root inside the container, for diagnostics. */
  readonly root: string;
}

export type WorkerMessage = WorkerHello | ToolCallResponse | { readonly log: string };

/** Serialise one message as a single stdout line. */
export function encodeMessage(msg: WorkerMessage | ToolCallRequest): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Split a growing buffer into complete lines, returning the parsed messages
 * and whatever partial tail remains.
 *
 * A tool result can be a whole file, so a response routinely spans several
 * chunks; treating each chunk as a message loses data silently. Unparseable
 * lines are DROPPED rather than thrown on: the worker's stderr is separate,
 * but a stray stdout write from a dependency must degrade to a lost line,
 * never to a dead run. The caller times out on the missing id instead.
 */
export function drainLines(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf('\n');
    if (nl === -1) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* not ours — drop it, see docstring */
    }
  }
  return { messages, rest };
}

export function isWorkerHello(m: unknown): m is WorkerHello {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { ready?: unknown }).ready === true &&
    Array.isArray((m as { tools?: unknown }).tools)
  );
}

export function isToolCallResponse(m: unknown): m is ToolCallResponse {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as { id?: unknown }).id === 'number' &&
    typeof (m as { ok?: unknown }).ok === 'boolean'
  );
}
