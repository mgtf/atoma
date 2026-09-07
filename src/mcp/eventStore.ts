import type { EventStore, EventId, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * THE REPLAY BUFFER BEHIND ONE SESSION'S SSE STREAMS.
 *
 * The Streamable HTTP transport answers a request on an SSE stream and keeps a
 * standalone GET stream for server-initiated notifications. Both can be cut
 * by a proxy, a laptop lid or a flaky link while a long-poll (`waitMs`) or a
 * run is in flight. With an event store the transport stamps every frame with
 * an id, and a client that reconnects with `Last-Event-ID` gets the frames it
 * missed — including the RESPONSE to the request whose stream died — instead
 * of a lost call it has to repeat.
 *
 * ONE STORE PER SESSION, IN MEMORY, BOUNDED. Sessions are memory-only and
 * idle-swept (`http.ts`), so the buffer dies with the session it serves and a
 * restart forgets it, exactly like the session id. The cap is a ring: the
 * oldest frames go first, and a cursor that fell off the ring replays nothing
 * rather than something wrong. Nothing here is a second body — a frame is the
 * transport's own message, stored verbatim and replayed verbatim.
 */
export const MCP_EVENT_STORE_CAPACITY = 512;

interface StoredEvent {
  readonly eventId: EventId;
  readonly streamId: StreamId;
  readonly message: JSONRPCMessage;
}

export class SessionEventStore implements EventStore {
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Map<EventId, StoredEvent>();
  private counter = 0;

  constructor(private readonly capacity: number = MCP_EVENT_STORE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`event store capacity must be a positive integer (got ${String(capacity)})`);
  }

  size(): number {
    return this.events.length;
  }

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    this.counter += 1;
    // Monotonic per store: the id orders frames without parsing anything.
    const eventId = `${this.counter.toString(36).padStart(8, '0')}`;
    const stored: StoredEvent = { eventId, streamId, message };
    this.events.push(stored);
    this.byId.set(eventId, stored);
    while (this.events.length > this.capacity) {
      const evicted = this.events.shift();
      if (evicted) this.byId.delete(evicted.eventId);
    }
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this.byId.get(eventId)?.streamId);
  }

  async replayEventsAfter(lastEventId: EventId, { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }): Promise<StreamId> {
    const anchor = this.byId.get(lastEventId);
    if (!anchor) {
      // The cursor fell off the ring or never existed: nothing to replay. An
      // empty stream id is what the SDK's own reference store answers here;
      // the client keeps its connection and asks again from where it stands.
      return '';
    }
    const start = this.events.indexOf(anchor) + 1;
    for (const event of this.events.slice(start)) {
      if (event.streamId === anchor.streamId) await send(event.eventId, event.message);
    }
    return anchor.streamId;
  }
}
