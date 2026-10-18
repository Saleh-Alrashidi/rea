/**
 * Server-sent events hub (see SPEC.md "server/events.js" and SPEC-2 §4).
 *
 * Two kinds of stream:
 *
 * - board streams (`{ boardId, userId }`): `event: change` messages with
 *   the store change events of one board. With a `userId`, every change
 *   that can move the user's access re-checks it (`server/access.js`), so
 *   a stream ends as soon as its user is deactivated, unshared or the
 *   board becomes inaccessible; `board_deleted` is delivered before the
 *   end.
 * - notification streams (`{ stream: "me", userId }`): `event:
 *   notification` messages with the user's own `notification_created`
 *   (when `access.notificationVisible` allows it, carrying the
 *   notification's `kind`, `url` and `text` rendered for that user, so a
 *   guest reads "Someone" for people outside their directory) and
 *   `notifications_read` events. They end when the user is deactivated.
 *
 * Streams are indexed by board, by user and by browser session, so a
 * change costs work only for the streams it can concern (`streamsFor`):
 * its board's streams, the streams of the users it names, the boards of a
 * changed workspace, and every board stream only for team changes (team
 * grants can sit on any board) or events of unknown scope. Doc and note
 * changes reach no stream. Each board's audience (who of its streams'
 * users can still open it) is computed once per change.
 *
 * A stream opened with a browser session (`sessionId`) ends with that
 * session: `endSession(id)` closes it at once (sign-out, demo switching),
 * and `sessionActive(id)` is asked before each delivery and heartbeat
 * (idle expiry).
 *
 * Each stream gets `: connected` and a heartbeat comment every
 * `heartbeatMs`. Streams are bounded: the hub accepts at most MAX_CLIENTS,
 * one user at most MAX_CLIENTS_PER_USER (so no account can take every
 * slot), and a client whose unsent output grows past MAX_BUFFERED_BYTES (a
 * stalled reader) is disconnected instead of buffering without limit.
 */
import {
  boardAccess,
  directoryName,
  isActive,
  notificationVisible,
  visibleUserIds,
} from "./access.js";
import { renderText } from "./store/activity.js";

const MAX_CLIENTS = 1000;
// Unspecified: enough for many tabs (each holds one inbox and one board stream).
const MAX_CLIENTS_PER_USER = 32;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const NOTIFICATION_EVENTS = new Set([
  "notification_created",
  "notifications_read",
]);
/**
 * How a change of each resource kind can move board access beyond the
 * board and users it names: "none", "workspace" (the boards in it) or
 * "all" (every board). Unlisted kinds count as "all".
 */
const ACCESS_REACH = Object.freeze({
  board: "none",
  form: "none",
  doc: "none",
  note: "none",
  notification: "none",
  workspace: "workspace",
  team: "all",
});

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

// ------------------------------------------------------------------ index

function addTo(map, key, client) {
  if (key === null) return;
  const set = map.get(key);
  if (set) set.add(client);
  else map.set(key, new Set([client]));
}

function removeFrom(map, key, client) {
  const set = key === null ? undefined : map.get(key);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) map.delete(key);
}

/** Streams by board, by user and by browser session. */
function createIndex() {
  const index = {
    all: new Set(),
    boards: new Map(),
    users: new Map(),
    sessions: new Map(),
  };
  return {
    ...index,
    add(client) {
      index.all.add(client);
      if (client.stream === "board") {
        addTo(index.boards, client.boardId, client);
      }
      addTo(index.users, client.userId, client);
      addTo(index.sessions, client.sessionId, client);
    },
    /** Removes `client`; false when it was not indexed. */
    remove(client) {
      if (!index.all.delete(client)) return false;
      removeFrom(index.boards, client.boardId, client);
      removeFrom(index.users, client.userId, client);
      removeFrom(index.sessions, client.sessionId, client);
      return true;
    },
  };
}

/** Board streams of the boards in workspace `workspaceId`. */
function workspaceStreams({ store, index }, workspaceId, found) {
  for (const [boardId, streams] of index.boards) {
    if (store.getBoard(boardId)?.workspace_id !== workspaceId) continue;
    for (const client of streams) found.add(client);
  }
}

/** The streams `event` can concern: to deliver it or to re-check access. */
function streamsFor(hub, event) {
  const { index } = hub;
  const found = new Set();
  const addAll = (streams) => streams?.forEach((client) => found.add(client));
  if (event.board_id !== undefined) addAll(index.boards.get(event.board_id));
  const inboxOnly = NOTIFICATION_EVENTS.has(event.type);
  for (const userId of event.user_ids ?? []) {
    for (const client of index.users.get(userId) ?? []) {
      if (!inboxOnly || client.stream === "me") found.add(client);
    }
  }
  const named = event.board_id !== undefined || event.user_ids !== undefined;
  const kind = event.resource_kind;
  const reach =
    kind === undefined && named ? "none" : (ACCESS_REACH[kind] ?? "all");
  if (reach === "all") index.boards.forEach(addAll);
  if (reach === "workspace") workspaceStreams(hub, event.resource_id, found);
  return found;
}

// -------------------------------------------------------------- decisions

/**
 * What a board stream does with `event`: deliver it, skip it, or close
 * (its user lost access; a deletion of the board is delivered first).
 */
function boardDecision(store, client, { event, memo }) {
  const own = event.board_id === client.boardId;
  if (own && event.type === "board_deleted") return DELIVER_AND_CLOSE;
  if (client.userId !== null) {
    const key = `board\u0000${client.boardId}\u0000${client.userId}`;
    const inAudience = memo(key, () => {
      const user = store.getUser(client.userId);
      const board = store.getBoard(client.boardId);
      return boardAccess(store, user, board) !== null;
    });
    if (!inAudience) return CLOSE;
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

/** The message a notification stream sends: the text as its user reads it. */
function inboxMessage(store, client, event) {
  if (event.type !== "notification_created") {
    return message("notification", event);
  }
  const { kind, text, url } = store.getNotification(event.resource_id);
  const directory = visibleUserIds(store, store.getUser(client.userId));
  const nameOf = (id) => directoryName(store, directory, id);
  const shown = renderText(text, nameOf);
  return message("notification", { ...event, kind, text: shown, url });
}

/** Delivers `change` to one stream, or ends it. */
function deliver(hub, client, change) {
  const { store, sessionActive, send, end } = hub;
  const { memo, event } = change;
  const { sessionId } = client;
  const live =
    sessionId === null ||
    memo(`session\u0000${sessionId}`, () => sessionActive(sessionId));
  if (!live) return end(client);
  const inbox = client.stream === "me";
  const decision = inbox
    ? inboxDecision(store, client, change)
    : boardDecision(store, client, change);
  if (decision.deliver) {
    const text = inbox
      ? memo(`message\u0000${client.userId}`, () =>
          inboxMessage(store, client, event),
        )
      : memo("change", () => message("change", event));
    send(client, text);
  }
  if (decision.close) end(client);
}

/** Delivers one store change to every stream it concerns. */
function dispatch(hub, event) {
  const change = { event, memo: dispatchMemo() };
  for (const client of streamsFor(hub, event)) deliver(hub, client, change);
}

// ---------------------------------------------------------------- streams

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

/** "full", "user" (that user holds too many streams) or null. */
function capacity({ index }, { userId }) {
  if (index.all.size >= MAX_CLIENTS) return "full";
  if (userId === null) return null;
  const open = index.users.get(userId)?.size ?? 0;
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

/** `send`, `drop` and `end` for the streams of `index`. */
function streamOutput(index, onEmpty) {
  const drop = (client) => {
    if (!index.remove(client)) return;
    clearInterval(client.timer);
    if (index.all.size === 0) onEmpty();
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
  return { drop, end, send };
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
  const index = createIndex();
  let unsubscribe = null;
  let closed = false;
  const output = streamOutput(index, () => {
    unsubscribe?.();
    unsubscribe = null;
  });
  const { drop, end, send } = output;
  const hub = { store, index, sessionActive, send, end };
  const onChange = (event) => dispatch(hub, event);
  const refusal = (settings) => (closed ? "closed" : capacity(hub, settings));
  const heartbeat = (client) => {
    const { sessionId } = client;
    if (sessionId !== null && !sessionActive(sessionId)) return end(client);
    send(client, ": heartbeat\n\n");
  };

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
      client.timer = setInterval(() => heartbeat(client), heartbeatMs);
      client.timer.unref?.();
      index.add(client);
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
      for (const client of Array.from(index.sessions.get(sessionId) ?? [])) {
        end(client);
      }
    },
    /** Ends every stream and stops listening to the store. */
    close() {
      closed = true;
      for (const client of Array.from(index.all)) end(client);
    },
    /** Number of open streams. */
    get size() {
      return index.all.size;
    },
  };
}
