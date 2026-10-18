/**
 * Server-sent events hub: streams store change events for one board to each
 * subscribed client (see SPEC.md "server/events.js").
 *
 * Each stream gets `: connected`, a heartbeat comment every `heartbeatMs`,
 * and `event: change` messages for its board. Streams are bounded: the hub
 * accepts at most MAX_CLIENTS streams, and a client whose unsent output
 * grows past MAX_BUFFERED_BYTES (a stalled reader) is disconnected instead of
 * buffering without limit.
 */

const MAX_CLIENTS = 1000;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Creates the hub over `store.on(...)` change events.
 * @returns {{ handle(req, res, { boardId }): boolean, close(): void,
 *   readonly size: number }}
 */
export function createEventHub({ store, heartbeatMs = 25_000 } = {}) {
  if (typeof store?.on !== "function") {
    throw new TypeError("createEventHub requires a store");
  }
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new TypeError("heartbeatMs must be a positive number");
  }
  const clients = new Set();
  let unsubscribe = null;

  const drop = (client) => {
    if (!clients.delete(client)) return;
    clearInterval(client.timer);
    if (clients.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
  const send = (client, text) => {
    if (client.res.writableEnded || client.res.destroyed) return drop(client);
    client.res.write(text);
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      drop(client);
      client.res.destroy();
    }
  };
  const onChange = (event) => {
    const message = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.boardId === event.board_id) send(client, message);
    }
  };
  let closed = false;

  return {
    /**
     * Starts an SSE stream for `boardId` on `res`. Returns false (and
     * answers 503) when the hub is closed or full.
     */
    handle(_req, res, { boardId }) {
      if (closed || clients.size >= MAX_CLIENTS) {
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "5",
        });
        const message = closed ? "Server is shutting down" : "Too many streams";
        const error = { message, extensions: { code: "SERVICE_UNAVAILABLE" } };
        res.end(JSON.stringify({ errors: [error] }));
        return false;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const client = { res, boardId: String(boardId), timer: null };
      client.timer = setInterval(
        () => send(client, ": heartbeat\n\n"),
        heartbeatMs,
      );
      client.timer.unref?.();
      clients.add(client);
      unsubscribe ??= store.on(onChange);
      // The response's "close" fires when the stream ends or the client
      // disconnects; the request's can fire as soon as its body is read.
      const cleanup = () => drop(client);
      res.once("close", cleanup);
      res.once("error", cleanup);
      send(client, ": connected\n\n");
      return true;
    },
    /** Ends every stream and stops listening to the store. */
    close() {
      closed = true;
      for (const client of clients) {
        drop(client);
        client.res.end();
      }
    },
    /** Number of open streams. */
    get size() {
      return clients.size;
    },
  };
}
