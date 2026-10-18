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
 *   (when `access.notificationVisible` allows it, carrying the
 *   notification's `kind`, `text` and `url`) and `notifications_read`
 *   events. They end when the user is deactivated.
 *
 * A stream opened with a browser session (`sessionId`) ends with that
 * session: `endSession(id)` closes it at once (sign-out, demo switching),
 * and `sessionActive(id)` is asked before each delivery (idle expiry).
 *
 * Each stream gets `: connected` and a heartbeat comment every
 * `heartbeatMs`. Streams are bounded: the hub accepts at most MAX_CLIENTS,
 * one user at most MAX_CLIENTS_PER_USER (so no account can take every
 * slot), and a client whose unsent output grows past MAX_BUFFERED_BYTES (a
 * stalled reader) is disconnected instead of buffering without limit.
 * Access verdicts are computed once per change and user (and board), not
 * once per stream.
 */
import { boardAccess, isActive, notificationVisible } from "./access.js";

const MAX_CLIENTS = 1000;
// Unspecified: enough for many tabs (each holds one inbox and one board stream).
const MAX_CLIENTS_PER_USER = 32;
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
 * Verdicts for one change event, shared by every stream: `memo(key, get)`
 * computes `get()` once per key.
 */
function dispatchMemo() {
  const values = new Map();
  return (key, get) => {
    if (!values.has(key)) values.set(key, get());
    return values.get(key);
  };
}

/**
 * What a board stream does with `event`: deliver it, skip it, or close
 * (its user lost access; a deletion of the board is delivered first).
 */
function boardDecision(store, client, { event, memo }) {
  const own = event.board_id === client.boardId;
  if (own && event.type === "board_deleted") return DELIVER_AND_CLOSE;
  if (client.userId !== null) {
    const key = `board\u0000${client.userId}\u0000${client.boardId}`;
    const reachable = memo(key, () => {
      const user = store.getUser(client.userId);
      const board = store.getBoard(client.boardId);
      return boardAccess(store, user, board) !== null;
    });
    if (!reachable) return CLOSE;
  }
  return own ? DELIVER : SKIP;
}

/** What a notification stream does with `event`. */
function inboxDecision(store, client, { event, memo }) {
  const user = store.getUser(client.userId);
  if (!isActive(user)) return CLOSE;
  const mine =
    NOTIFICATION_EVENTS.has(event.type) &&
    Array.isArray(event.user_ids) &&
    event.user_ids.includes(client.userId);
  if (!mine) return SKIP;
  if (event.type === "notifications_read") return DELIVER;
  const visible = memo(`inbox\u0000${client.userId}`, () => {
    const notification = store.getNotification(event.resource_id);
    return notificationVisible(store, user, notification);
  });
  return visible ? DELIVER : SKIP;
}

/** The event a notification stream sends: with the visible text. */
function inboxMessage(store, event) {
  if (event.type !== "notification_created") return event;
  const { kind, text, url } = store.getNotification(event.resource_id);
  return { ...event, kind, text, url };
}

const REFUSALS = Object.freeze({
  closed: [503, "SERVICE_UNAVAILABLE", "Server is shutting down"],
  full: [503, "SERVICE_UNAVAILABLE", "Too many streams"],
  user: [429, "RATE_LIMITED", "Too many open streams for this user"],
});

function refuse(res, reason) {
  const [status, code, text] = REFUSALS[reason];
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": "5",
  });
  const error = { message: text, extensions: { code } };
  res.end(JSON.stringify({ errors: [error] }));
}

function readOptions({
  boardId = null,
  userId = null,
  stream = "board",
  sessionId = null,
}) {
  if (stream !== "board" && stream !== "me") {
    throw new TypeError(`Unknown stream ${String(stream)}`);
  }
  if (stream === "me" && userId === null) {
    throw new TypeError("A notification stream needs a userId");
  }
  if (stream === "board" && boardId === null) {
    throw new TypeError("A board stream needs a boardId");
  }
  if (sessionId !== null && typeof sessionId !== "string") {
    throw new TypeError("sessionId must be a string");
  }
  return {
    stream,
    boardId: boardId === null ? null : String(boardId),
    userId: userId === null ? null : String(userId),
    sessionId,
  };
}

/** Delivers one store change to every stream that may see it. */
function dispatch({ store, clients, sessionActive, send, end }, event) {
  const memo = dispatchMemo();
  const change = { event, memo };
  const live = ({ sessionId }) =>
    sessionId === null ||
    memo(`session\u0000${sessionId}`, () => sessionActive(sessionId));
  for (const client of Array.from(clients)) {
    if (!live(client)) {
      end(client);
      continue;
    }
    const inbox = client.stream === "me";
    const decision = inbox
      ? inboxDecision(store, client, change)
      : boardDecision(store, client, change);
    if (decision.deliver && inbox) {
      send(client, message("notification", inboxMessage(store, event)));
    } else if (decision.deliver) {
      send(
        client,
        memo("change", () => message("change", event)),
      );
    }
    if (decision.close) end(client);
  }
}

/** "full", "user" (that user holds too many streams) or null. */
function capacity({ clients }, { userId }) {
  if (clients.size >= MAX_CLIENTS) return "full";
  if (userId === null) return null;
  let open = 0;
  for (const client of clients) if (client.userId === userId) open += 1;
  return open >= MAX_CLIENTS_PER_USER ? "user" : null;
}

function openStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

/**
 * Creates the hub over `store.on(...)` change events. `sessionActive(id)`
 * tells whether a browser session still exists (without extending it).
 * @returns {{ handle(req, res, options): boolean, endSession(id): void,
 *   close(): void, readonly size: number }}
 */
export function createEventHub({
  store,
  heartbeatMs = 25_000,
  sessionActive = () => true,
} = {}) {
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
  const hub = { store, clients, sessionActive, send, end };
  const onChange = (event) => dispatch(hub, event);
  const refusal = (settings) => (closed ? "closed" : capacity(hub, settings));

  return {
    /**
     * Starts a stream on `res`: `{ boardId, userId?, sessionId? }` for a
     * board, `{ stream: "me", userId, sessionId? }` for the user's
     * notifications. Returns false (and answers 503, or 429 when the user
     * already holds MAX_CLIENTS_PER_USER streams) when it cannot.
     */
    handle(_req, res, options = {}) {
      const settings = readOptions(options);
      const reason = refusal(settings);
      if (reason !== null) {
        refuse(res, reason);
        return false;
      }
      openStream(res);
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
    /** Ends the streams opened with browser session `sessionId`. */
    endSession(sessionId) {
      for (const client of Array.from(clients)) {
        if (client.sessionId === sessionId) end(client);
      }
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
