import type { EventStore, EventId, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * THE REPLAY BUFFER BEHIND ONE SESSION'S SSE STREAMS.
 *
 * The Streamable HTTP transport answers a request on an SSE stream and keeps a
 * standalone GET stream for server-initiated notifications. Both can be cut
 * by a proxy, a laptop lid or a flaky link while a run is in flight. With an
 * event store the transport stamps every frame with an id, and a client that
 * reconnects with `Last-Event-ID` gets the frames it missed — including the
 * RESPONSE to the request whose stream died — instead of a lost call it has to
 * repeat.
 *
 * ONE STORE PER SESSION, IN MEMORY, BOUNDED TWICE AND EVICTED PER STREAM.
 * Sessions are memory-only and idle-swept (`http.ts`), so the buffer dies with
 * the session it serves and a restart forgets it, exactly like the session id.
 *
 * EVICTION IS NOT GLOBALLY FIFO, AND THAT IS THE POINT. A session's streams
 * are not equals: the standalone stream carries the run log, one
 * `notifications/message` per output chunk of the child's stdout
 * (`tasks.ts#attachRunLogging`), while a tool call's response is a single
 * frame on a stream of its own. Under one global queue the log evicts the very
 * response the replay exists to preserve — the chatty stream starves the quiet
 * one. So a frame is dropped from the LONGEST stream, oldest first, and a
 * quiet stream keeps its frames however loud its neighbour is.
 *
 * TWO BOUNDS, BECAUSE A FRAME IS NOT AN AVERAGE. The log frame carries the
 * child's chunk VERBATIM and a pipe read is up to 64 KiB, so a count alone
 * would let one session hold tens of megabytes. The byte bound is what makes
 * the session ceiling in `http.ts` a memory bound as well as a count.
 *
 * A cursor that fell off replays nothing rather than something wrong, and
 * `evictions()` is what says that depth was lost rather than never used.
 * Nothing here is a second body — a frame is the transport's own message,
 * stored verbatim and replayed verbatim.
 */
export const MCP_EVENT_STORE_CAPACITY = 512;
/** Per session. 64 KiB is one pipe read, so this is ~64 worst-case log frames. */
export const MCP_EVENT_STORE_MAX_BYTES = 4 * 1024 * 1024;

interface StoredEvent {
  readonly eventId: EventId;
  readonly streamId: StreamId;
  readonly message: JSONRPCMessage;
  /** What this frame costs the session, weighed once at store time. */
  readonly bytes: number;
  /** Insertion order, so a tie between two streams is broken by age, not by id spelling. */
  readonly seq: number;
}

/**
 * What the host needs to know about the stream a `Last-Event-ID` names: whether
 * its call is still unanswered, and since when the store has seen it.
 */
export interface StreamState {
  readonly streamId: StreamId;
  /** When the stream's first frame was stored: the call began no later. */
  readonly firstStoredMs: number;
  /** A JSON-RPC response was stored on it: nothing more will ever be sent there. */
  readonly answered: boolean;
}

/** A response closes the call its stream answers; a notification or a request does not. */
function isResponse(message: JSONRPCMessage): boolean {
  return 'id' in message && ('result' in message || 'error' in message);
}

/** The frame's own weight. A malformed message counts as nothing rather than throwing on the hot path. */
function frameBytes(message: JSONRPCMessage): number {
  try {
    return Buffer.byteLength(JSON.stringify(message) ?? '');
  } catch {
    return 0;
  }
}

export class SessionEventStore implements EventStore {
  /** One queue per stream, oldest first. An empty queue is deleted, so the map follows live streams. */
  private readonly streams = new Map<StreamId, StoredEvent[]>();
  private readonly byId = new Map<EventId, StoredEvent>();
  /** One entry per stream holding frames, deleted with its last frame. */
  private readonly states = new Map<StreamId, { firstStoredMs: number; answered: boolean }>();
  private counter = 0;
  private stored = 0;
  private bytes = 0;
  private dropped = 0;

  constructor(
    private readonly capacity: number = MCP_EVENT_STORE_CAPACITY,
    private readonly maxBytes: number = MCP_EVENT_STORE_MAX_BYTES,
    private readonly now: () => number = () => Date.now()
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`event store capacity must be a positive integer (got ${String(capacity)})`);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error(`event store byte budget must be a positive integer (got ${String(maxBytes)})`);
  }

  size(): number {
    return this.stored;
  }

  /** Frames dropped to stay inside either bound: replay depth this session actually lost. */
  evictions(): number {
    return this.dropped;
  }

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    this.counter += 1;
    // Monotonic per store: the id orders frames without parsing anything.
    const eventId = `${this.counter.toString(36).padStart(8, '0')}`;
    const stored: StoredEvent = { eventId, streamId, message, bytes: frameBytes(message), seq: this.counter };
    let queue = this.streams.get(streamId);
    if (!queue) {
      queue = [];
      this.streams.set(streamId, queue);
    }
    const state = this.states.get(streamId) ?? { firstStoredMs: this.now(), answered: false };
    if (isResponse(message)) state.answered = true;
    this.states.set(streamId, state);
    queue.push(stored);
    this.byId.set(eventId, stored);
    this.stored += 1;
    this.bytes += stored.bytes;
    while ((this.stored > this.capacity || this.bytes > this.maxBytes) && this.evictOne()) {
      // Bounded by `stored`: every turn removes one frame, and an empty store
      // satisfies both bounds. A single frame larger than the whole budget
      // evicts itself — the honest outcome is no replay, not an unbounded session.
    }
    return Promise.resolve(eventId);
  }

  /** The oldest frame of the LONGEST stream; equal lengths go to the older frame. */
  private evictOne(): boolean {
    let victim: StoredEvent[] | null = null;
    for (const queue of this.streams.values()) {
      const head = queue[0];
      if (!head) continue;
      const best = victim?.[0];
      if (!best || queue.length > victim!.length || (queue.length === victim!.length && head.seq < best.seq)) victim = queue;
    }
    const gone = victim?.shift();
    if (!gone) return false;
    this.byId.delete(gone.eventId);
    this.stored -= 1;
    this.bytes -= gone.bytes;
    this.dropped += 1;
    if (victim!.length === 0) {
      this.streams.delete(gone.streamId);
      this.states.delete(gone.streamId);
    }
    return true;
  }

  /** The stream `eventId` belongs to, while the ring still holds it. */
  streamState(eventId: EventId): StreamState | undefined {
    const streamId = this.byId.get(eventId)?.streamId;
    const state = streamId === undefined ? undefined : this.states.get(streamId);
    return streamId === undefined || !state ? undefined : { streamId, ...state };
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this.byId.get(eventId)?.streamId);
  }

  async replayEventsAfter(lastEventId: EventId, { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }): Promise<StreamId> {
    const anchor = this.byId.get(lastEventId);
    const queue = anchor ? this.streams.get(anchor.streamId) : undefined;
    if (!anchor || !queue) {
      // The cursor fell off the ring or never existed: nothing to replay. An
      // empty stream id is what the SDK's own reference store answers here;
      // the client keeps its connection and asks again from where it stands.
      return '';
    }
    for (const event of queue.slice(queue.indexOf(anchor) + 1)) await send(event.eventId, event.message);
    return anchor.streamId;
  }
}
