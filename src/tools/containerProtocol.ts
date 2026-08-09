import type { Tool } from '../core/types.js';

/**
 * The wire between the control plane and a containerised tool worker.
 *
 * ONE definition, imported by both sides — the same rule `src/contracts/`
 * applies to inter-agent shapes. A protocol described twice is a protocol
 * that drifts, and this one has no validator between its ends.
 *
 * Framing is JSON LINES OVER STDIO, deliberately, not HTTP on a port. A port
 * would be something the run could reach, and the entire point of the
 * container is that the run reaches nothing: `docker run --network none`
 * leaves the worker with a loopback interface and no route anywhere else, so
 * `start_node_server` + `fetch_url` still work against the run's OWN server
 * while the control plane is unreachable. Verified before this file existed:
 * loopback serves, `host.docker.internal` does not even resolve.
 *
 * Consequence for the worker: STDOUT IS THE PROTOCOL. Anything a tool logs
 * must go to stderr or it corrupts the stream.
 */

/** Control plane → worker. */
export interface ToolCallRequest {
  readonly id: number;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

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

export type WorkerMessage = WorkerHello | ToolCallResponse;

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
