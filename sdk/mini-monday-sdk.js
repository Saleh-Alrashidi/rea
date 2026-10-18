/**
 * mini-monday iframe-app SDK (bridge protocol `mini-monday/1`).
 *
 * The SDK talks to exactly one host origin. Requests are posted to
 * `window.parent` with that origin as the target (never `"*"`), and incoming
 * messages are accepted only when both `event.source` and `event.origin` match
 * the host. Each request carries a `crypto.randomUUID()` ID; a response settles
 * only the pending request with that ID, and events reach only the `listen`
 * callbacks registered for their type.
 *
 * Argument validation (storage keys, execute params, …) is owned by the host
 * bridge, which answers with `BAD_REQUEST`; the SDK forwards arguments as given.
 */

export const PROTOCOL = "mini-monday/1";

// setTimeout clamps larger delays, so they would fire immediately.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Builds an Error with a protocol error code. */
function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const destroyedError = () =>
  codedError("mini-monday client was destroyed", "DESTROYED");

function logError(message, error) {
  globalThis.console?.error?.(message, error);
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function parseHostOrigin(hostOrigin) {
  const hint = 'hostOrigin must be an origin such as "https://host.example"';
  if (typeof hostOrigin !== "string") {
    throw new TypeError(hint);
  }
  let url;
  try {
    url = new URL(hostOrigin);
  } catch {
    throw new TypeError(hint);
  }
  const httpScheme = url.protocol === "http:" || url.protocol === "https:";
  if (!httpScheme || url.origin !== hostOrigin) {
    throw new TypeError(`${hint} (http: or https:, no path or trailing slash)`);
  }
  return hostOrigin;
}

function checkOptions({ timeoutMs, win }) {
  const validTimeout =
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= MAX_TIMEOUT_MS;
  if (!validTimeout) {
    throw new TypeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  const usable =
    isObject(win) &&
    typeof win.addEventListener === "function" &&
    typeof win.removeEventListener === "function" &&
    win.parent != null &&
    typeof win.parent.postMessage === "function";
  if (!usable) {
    throw new TypeError("window must be a browser window with a parent");
  }
}

function responseError(message) {
  if (message.ok !== false) {
    return codedError("Malformed response from host", "BAD_RESPONSE");
  }
  const { error } = message;
  const text =
    typeof error?.message === "string" ? error.message : "Request failed";
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  return codedError(text, code);
}

/**
 * Owns the message listener, pending requests and listen subscriptions.
 */
function createChannel({ origin, timeoutMs, win }) {
  const parent = win.parent;
  const pending = new Map();
  const listeners = new Map();
  let destroyed = false;

  function settle(message) {
    const entry =
      typeof message.requestId === "string"
        ? pending.get(message.requestId)
        : undefined;
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.data);
    else entry.reject(responseError(message));
  }

  function deliver(message) {
    const entries =
      typeof message.type === "string" ? listeners.get(message.type) : null;
    if (!entries) return;
    // Snapshot: listeners added by a callback start with the next event.
    for (const entry of Array.from(entries)) {
      try {
        entry.callback(message.data);
      } catch (error) {
        logError(`mini-monday SDK: "${message.type}" listener failed`, error);
      }
    }
  }

  function onMessage(event) {
    if (event.source !== parent || event.origin !== origin) return;
    const { data } = event;
    if (!isObject(data) || data.protocol !== PROTOCOL) return;
    if (data.kind === "response") settle(data);
    else if (data.kind === "event") deliver(data);
  }

  function request(method, args) {
    if (destroyed) return Promise.reject(destroyedError());
    const requestId = globalThis.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        const text = `mini-monday request "${method}" timed out after ${timeoutMs} ms`;
        reject(codedError(text, "TIMEOUT"));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      const message = { protocol: PROTOCOL, kind: "request", requestId };
      try {
        parent.postMessage({ ...message, method, args }, origin);
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function sendQuietly(method, args) {
    request(method, args).catch((error) => {
      if (error?.code !== "DESTROYED") {
        logError(`mini-monday SDK: ${method} "${args.type}" failed`, error);
      }
    });
  }

  function subscribe(type, callback) {
    if (typeof type !== "string" || type === "") {
      throw new TypeError("listen type must be a non-empty string");
    }
    if (typeof callback !== "function") {
      throw new TypeError("listen callback must be a function");
    }
    if (destroyed) throw destroyedError();
    let entries = listeners.get(type);
    if (!entries) {
      entries = new Set();
      listeners.set(type, entries);
      sendQuietly("listen", { type });
    }
    // One entry per call, so the same callback may be registered twice.
    const entry = { callback };
    entries.add(entry);
    return () => {
      if (!entries.delete(entry) || entries.size > 0) return;
      if (listeners.get(type) !== entries) return;
      listeners.delete(type);
      sendQuietly("unlisten", { type });
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    win.removeEventListener("message", onMessage);
    listeners.clear();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(destroyedError());
    }
    pending.clear();
  }

  win.addEventListener("message", onMessage);
  return { request, subscribe, destroy };
}

function createStorage(request, segment) {
  return {
    getItem: (key) => request("storage", { segment, op: "get", key }),
    setItem(key, value, options = {}) {
      const args = { segment, op: "set", key, value };
      const previousVersion = options?.previousVersion;
      if (previousVersion !== undefined) args.previousVersion = previousVersion;
      return request("storage", args);
    },
    deleteItem: (key) => request("storage", { segment, op: "delete", key }),
  };
}

function apiError(errors) {
  const [first] = errors;
  const message =
    typeof first?.message === "string"
      ? first.message
      : "GraphQL request failed";
  const error = new Error(message);
  error.errors = errors;
  const code = first?.extensions?.code;
  if (typeof code === "string") error.code = code;
  return error;
}

/**
 * Creates an SDK client bound to one host origin.
 *
 * @param {{ hostOrigin: string, timeoutMs?: number, window?: object }} options
 * @returns {{
 *   get(type: string): Promise<unknown>,
 *   set(type: string, value: object): Promise<unknown>,
 *   listen(type: string, callback: (data: unknown) => void): () => void,
 *   execute(type: string, params?: object): Promise<unknown>,
 *   api(query: string, options?: object): Promise<{ data: unknown, errors?: object[] }>,
 *   storage: object,
 *   destroy(): void,
 * }}
 */
export function createClient({
  hostOrigin,
  timeoutMs = 30_000,
  window: win = globalThis.window,
} = {}) {
  const origin = parseHostOrigin(hostOrigin);
  checkOptions({ timeoutMs, win });
  const channel = createChannel({ origin, timeoutMs, win });
  const { request } = channel;

  return {
    get: (type) => request("get", { type }),
    set: (type, value) => request("set", { type, value }),
    listen: (type, callback) => channel.subscribe(type, callback),
    execute: (type, params = {}) => request("execute", { type, params }),
    async api(query, options = {}) {
      const { variables, operationName } = options ?? {};
      const args = { query };
      if (variables !== undefined) args.variables = variables;
      if (operationName !== undefined) args.operationName = operationName;
      const response = await request("api", args);
      const failed =
        isObject(response) &&
        Array.isArray(response.errors) &&
        response.errors.length > 0 &&
        response.data == null;
      if (failed) throw apiError(response.errors);
      return response;
    },
    storage: {
      ...createStorage(request, "global"),
      instance: createStorage(request, "instance"),
    },
    destroy: channel.destroy,
  };
}
