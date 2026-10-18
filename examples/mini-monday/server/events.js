/**
 * Server-sent events hub (see SPEC.md "server/events.js" and SPEC-2 §4).
 *
 * Two kinds of stream:
 *
 * - board streams (`{ boardId, userId }`): `event: change` messages with
 *   the store change events of one board. With a `userId`, every store
 *   change re-checks the user's board access (`server/access.js`), so a
 *   stream ends as soon as its user is deactivated, unshared or the board
 *   becomes inaccessible; `board_deleted` is delivered before the end.
 * - notification streams (`{ stream: "me", userId }`): `event:
 *   notification` messages with the user's own `notification_created`
 *   (when `access.notificationVisible` allows it) and `notifications_read`
 *   events. They end when the user is deactivated.
 *
 * Each stream gets `: connected` and a heartbeat comment every
 * `heartbeatMs`. Streams are bounded: the hub accepts at most MAX_CLIENTS,
 * and a client whose unsent output grows past MAX_BUFFERED_BYTES (a
 * stalled reader) is disconnected instead of buffering without limit.
 */
import { boardAccess, isActive, notificationVisible } from "./access.js";

const MAX_CLIENTS = 1000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const NOTIFICATION_EVENTS = new Set([
  "notification_created",
  "notifications_read",
]);

const message = (name, event) =>
  `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;

const SKIP = Object.freeze({ deliver: false, close: false });
const DELIVER = Object.freeze({ deliver: true, close: false });
const CLOSE = Object.freeze({ deliver: false, close: true });
const DELIVER_AND_CLOSE = Object.freeze({ deliver: true, close: true });

/**
 * What a board stream does with `event`: deliver it, skip it, or close
 * (its user lost access; a deletion of the board is delivered first).
 */
function boardDecision(store, client, event) {
  const own = event.board_id === client.boardId;
  if (own && event.type === "board_deleted") return DELIVER_AND_CLOSE;
  if (client.userId !== null) {
    const user = store.getUser(client.userId);
    const board = store.getBoard(client.boardId);
    if (boardAccess(store, user, board) === null) return CLOSE;
  }
  return own ? DELIVER : SKIP;
}

/** What a notification stream does with `event`. */
function inboxDecision(store, client, event) {
  const user = store.getUser(client.userId);
  if (!isActive(user)) return CLOSE;
  const mine =
    NOTIFICATION_EVENTS.has(event.type) &&
    Array.isArray(event.user_ids) &&
    event.user_ids.includes(client.userId);
  if (!mine) return SKIP;
  if (event.type === "notifications_read") return DELIVER;
  const notification = store.getNotification(event.resource_id);
  return notificationVisible(store, user, notification) ? DELIVER : SKIP;
}

function refuse(res, closed) {
  res.writeHead(503, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": "5",
  });
  const text = closed ? "Server is shutting down" : "Too many streams";
  const error = { message: text, extensions: { code: "SERVICE_UNAVAILABLE" } };
  res.end(JSON.stringify({ errors: [error] }));
}

function readOptions({ boardId = null, userId = null, stream = "board" }) {
  if (stream !== "board" && stream !== "me") {
    throw new TypeError(`Unknown stream ${String(stream)}`);
  }
  if (stream === "me" && userId === null) {
    throw new TypeError("A notification stream needs a userId");
  }
  if (stream === "board" && boardId === null) {
    throw new TypeError("A board stream needs a boardId");
  }
  return {
    stream,
    boardId: boardId === null ? null : String(boardId),
    userId: userId === null ? null : String(userId),
  };
}

/**
 * Creates the hub over `store.on(...)` change events.
 * @returns {{ handle(req, res, options): boolean, close(): void,
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
  let closed = false;

  const drop = (client) => {
    if (!clients.delete(client)) return;
    clearInterval(client.timer);
    if (clients.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
  const end = (client) => {
    drop(client);
    client.res.end();
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
    for (const client of Array.from(clients)) {
      const inbox = client.stream === "me";
      const decision = inbox
        ? inboxDecision(store, client, event)
        : boardDecision(store, client, event);
      if (decision.deliver) {
        send(client, message(inbox ? "notification" : "change", event));
      }
      if (decision.close) end(client);
    }
  };

  return {
    /**
     * Starts a stream on `res`: `{ boardId, userId? }` for a board,
     * `{ stream: "me", userId }` for the user's notifications. Returns
     * false (and answers 503) when the hub is closed or full.
     */
    handle(_req, res, options = {}) {
      const settings = readOptions(options);
      if (closed || clients.size >= MAX_CLIENTS) {
        refuse(res, closed);
        return false;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const client = { res, ...settings, timer: null };
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
      for (const client of Array.from(clients)) end(client);
    },
    /** Number of open streams. */
    get size() {
      return clients.size;
    },
  };
}
