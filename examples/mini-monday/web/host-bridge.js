/**
 * Host side of the `mini-monday/1` bridge.
 *
 * One bridge serves one app iframe. It accepts a message only from that
 * iframe's window and the app's exact origin, validates the request, runs the
 * matching host handler and replies to the app origin (never `"*"`). The bridge
 * owns argument validation for every method; handler failures reach the app as
 * `INTERNAL` without their message or stack.
 */

const PROTOCOL = "mini-monday/1";
const MAX_REQUEST_ID_LENGTH = 100;
const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_LENGTH = 65_536;
const INT32_MAX = 2_147_483_647;
const ID_PATTERN = /^\d{1,20}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const GET_HANDLERS = new Map([
  ["context", "getContext"],
  ["settings", "getSettings"],
  ["sessionToken", "getSessionToken"],
  ["location", "getLocation"],
  ["filter", "getFilter"],
  ["itemIds", "getItemIds"],
]);
const LISTEN_TYPES = new Set(["context", "settings", "events", "filter"]);
const NOTICE_TYPES = new Set(["success", "error", "info"]);
const STORAGE_SEGMENTS = new Set(["global", "instance"]);

/** An expected failure whose message and code are safe to send to the app. */
class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

const badRequest = (message) => new BridgeError(message, "BAD_REQUEST");
const notSupported = (message) => new BridgeError(message, "NOT_SUPPORTED");

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAppOrigin(appOrigin) {
  const hint = 'appOrigin must be an origin such as "https://apps.example"';
  if (typeof appOrigin !== "string") throw new TypeError(hint);
  let url;
  try {
    url = new URL(appOrigin);
  } catch {
    throw new TypeError(hint);
  }
  const httpScheme = url.protocol === "http:" || url.protocol === "https:";
  if (!httpScheme || url.origin !== appOrigin) {
    throw new TypeError(`${hint} (http: or https:, no path or trailing slash)`);
  }
  return appOrigin;
}

function checkOptions({ iframe, handlers, win }) {
  if (typeof iframe !== "object" || iframe === null) {
    throw new TypeError("iframe must be an iframe element");
  }
  if (!("contentWindow" in iframe)) {
    throw new TypeError("iframe must expose contentWindow");
  }
  if (typeof handlers !== "object" || handlers === null) {
    throw new TypeError("handlers must be an object");
  }
  const usable =
    typeof win?.addEventListener === "function" &&
    typeof win?.removeEventListener === "function";
  if (!usable) throw new TypeError("window must support message listeners");
}

async function callHandler(handlers, name, argument) {
  const handler = handlers[name];
  if (typeof handler !== "function") {
    throw notSupported(`The host does not support ${name}`);
  }
  return handler.call(handlers, argument);
}

function readType(args) {
  if (!isPlainObject(args) || typeof args.type !== "string") {
    throw badRequest("args.type must be a string");
  }
  return args.type;
}

function readText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${name} must be a non-empty string`);
  }
  return value;
}

function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Runs handlers.graphql and returns a `{ data?, errors? }` response. A thrown
 * error carrying `.errors` (a non-2xx GraphQL body from `api.js`) is that
 * response. Errors are copied as JSON so no Error object (or its stack) is
 * structured-cloned into the app.
 */
async function runGraphql(handlers, request) {
  let response;
  try {
    response = await callHandler(handlers, "graphql", request);
  } catch (error) {
    if (!Array.isArray(error?.errors) || error.errors.length === 0) throw error;
    response = { errors: error.errors };
  }
  if (!isPlainObject(response)) {
    throw new Error("graphql handler returned a non-object response");
  }
  const result = {};
  if ("data" in response) result.data = response.data;
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    result.errors = JSON.parse(JSON.stringify(response.errors));
  }
  return result;
}

function graphqlFailure([first]) {
  const message =
    typeof first?.message === "string" ? first.message : "GraphQL error";
  const code = first?.extensions?.code;
  const valid = typeof code === "string" && ERROR_CODE_PATTERN.test(code);
  return new BridgeError(message, valid ? code : "INTERNAL");
}

function toStorageValue(result) {
  if (result === null) return { value: null, version: null };
  const valid =
    isPlainObject(result) &&
    typeof result.value === "string" &&
    Number.isInteger(result.version);
  if (!valid) throw new Error("malformed app_storage response");
  return { value: result.value, version: result.version };
}

function toStorageWrite(result) {
  if (!isPlainObject(result) || typeof result.success !== "boolean") {
    throw new Error("malformed storage write response");
  }
  const write = { success: result.success, version: result.version ?? null };
  if (typeof result.reason === "string") write.reason = result.reason;
  return write;
}

const STORAGE_VARIABLES =
  "$installId: ID!, $segment: StorageSegment!, $key: String!";
const STORAGE_ARGUMENTS =
  "install_id: $installId, segment: $segment, key: $key";
const STORAGE_OPERATIONS = new Map([
  [
    "get",
    {
      field: "app_storage",
      name: "BridgeAppStorageGet",
      query: `query BridgeAppStorageGet(${STORAGE_VARIABLES}) {
  app_storage(${STORAGE_ARGUMENTS}) { key value version }
}`,
      toResult: toStorageValue,
    },
  ],
  [
    "set",
    {
      field: "set_app_storage",
      name: "BridgeAppStorageSet",
      query: `mutation BridgeAppStorageSet(${STORAGE_VARIABLES}, $value: String!, $previousVersion: Int) {
  set_app_storage(${STORAGE_ARGUMENTS}, value: $value, previous_version: $previousVersion) { success version reason }
}`,
      toResult: toStorageWrite,
    },
  ],
  [
    "delete",
    {
      field: "delete_app_storage",
      name: "BridgeAppStorageDelete",
      query: `mutation BridgeAppStorageDelete(${STORAGE_VARIABLES}) {
  delete_app_storage(${STORAGE_ARGUMENTS}) { success version reason }
}`,
      toResult: toStorageWrite,
    },
  ],
]);

function readStorageKey(key) {
  const validLength =
    typeof key === "string" &&
    key.length >= 1 &&
    key.length <= MAX_STORAGE_KEY_LENGTH;
  if (!validLength) {
    throw badRequest(`key must be 1-${MAX_STORAGE_KEY_LENGTH} characters`);
  }
  if (hasControlCharacter(key)) {
    throw badRequest("key must not contain control characters");
  }
  return key;
}

function readStorageWrite({ value, previousVersion }) {
  if (typeof value !== "string" || value.length > MAX_STORAGE_VALUE_LENGTH) {
    const limit = MAX_STORAGE_VALUE_LENGTH;
    throw badRequest(`value must be a string of at most ${limit} characters`);
  }
  if (previousVersion === undefined || previousVersion === null) {
    return { value };
  }
  const validVersion =
    Number.isInteger(previousVersion) &&
    previousVersion >= 0 &&
    previousVersion <= INT32_MAX;
  if (!validVersion) {
    throw badRequest("previousVersion must be a non-negative 32-bit integer");
  }
  return { value, previousVersion };
}

function parseStorageRequest(args) {
  if (!isPlainObject(args)) throw badRequest("storage args must be an object");
  if (!STORAGE_SEGMENTS.has(args.segment)) {
    throw badRequest('segment must be "global" or "instance"');
  }
  const operation = STORAGE_OPERATIONS.get(args.op);
  if (!operation) throw badRequest('op must be "get", "set" or "delete"');
  const variables = { segment: args.segment, key: readStorageKey(args.key) };
  const write = args.op === "set" ? readStorageWrite(args) : {};
  return { operation, variables: { ...variables, ...write } };
}

async function readInstallId(handlers) {
  const context = await callHandler(handlers, "getContext");
  const id = context?.instanceId;
  if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  if (typeof id === "string" && id !== "") return id;
  throw new Error("host context has no instanceId");
}

async function handleStorage({ handlers }, args) {
  const { operation, variables } = parseStorageRequest(args);
  // The install always comes from the host context, never from the app.
  const installId = await readInstallId(handlers);
  const response = await runGraphql(handlers, {
    query: operation.query,
    variables: { installId, ...variables },
    operationName: operation.name,
  });
  const result = response.data?.[operation.field];
  if (response.errors && result == null) {
    throw graphqlFailure(response.errors);
  }
  return operation.toResult(result);
}

async function handleApi({ handlers }, args) {
  if (!isPlainObject(args)) throw badRequest("api args must be an object");
  const { query, variables = null, operationName = null } = args;
  if (typeof query !== "string" || query.trim() === "") {
    throw badRequest("query must be a non-empty string");
  }
  if (variables !== null && !isPlainObject(variables)) {
    throw badRequest("variables must be an object");
  }
  if (operationName !== null && typeof operationName !== "string") {
    throw badRequest("operationName must be a string");
  }
  return runGraphql(handlers, {
    query,
    variables: variables ?? {},
    operationName,
  });
}

async function executeNotice(handlers, params) {
  const message = readText(params.message, "message");
  const type = params.type ?? "info";
  if (!NOTICE_TYPES.has(type)) {
    throw badRequest('type must be "success", "error" or "info"');
  }
  const { timeout } = params;
  const validTimeout =
    timeout === undefined || (Number.isFinite(timeout) && timeout >= 0);
  if (!validTimeout) throw badRequest("timeout must be a non-negative number");
  await callHandler(handlers, "notice", { message, type, timeout });
  return { ok: true };
}

async function executeOpenItemCard(handlers, { itemId }) {
  const id =
    Number.isSafeInteger(itemId) && itemId >= 0 ? String(itemId) : itemId;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw badRequest("itemId must be a numeric ID");
  }
  await callHandler(handlers, "openItemCard", { itemId: id });
  return { ok: true };
}

async function executeConfirm(handlers, params) {
  const request = { message: readText(params.message, "message") };
  for (const name of ["confirmButton", "cancelButton"]) {
    if (params[name] !== undefined) {
      request[name] = readText(params[name], name);
    }
  }
  const confirmed = await callHandler(handlers, "confirm", request);
  return { confirm: confirmed === true };
}

async function executeOpenLinkInTab(handlers, params) {
  if (typeof params.url !== "string") throw badRequest("url must be a string");
  let url;
  try {
    url = new URL(params.url);
  } catch {
    throw badRequest("url must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("url must use http: or https:");
  }
  // Pass the parsed form so the opened URL is exactly the validated one.
  await callHandler(handlers, "openLinkInTab", { url: url.href });
  return { ok: true };
}

const EXECUTE_TYPES = new Map([
  ["notice", executeNotice],
  ["openItemCard", executeOpenItemCard],
  ["confirm", executeConfirm],
  ["openLinkInTab", executeOpenLinkInTab],
  // Usage signal only; the host has nothing to do for it.
  ["valueCreatedForUser", async () => ({ ok: true })],
]);

async function handleExecute({ handlers }, args) {
  const run = EXECUTE_TYPES.get(readType(args));
  if (!run) throw notSupported("Unsupported execute type");
  const params = args.params === undefined ? {} : args.params;
  if (!isPlainObject(params)) throw badRequest("params must be an object");
  return run(handlers, params);
}

async function handleGet({ handlers }, args) {
  const handlerName = GET_HANDLERS.get(readType(args));
  if (!handlerName) throw notSupported("Unsupported get type");
  return callHandler(handlers, handlerName);
}

async function handleSet({ handlers }, args) {
  if (readType(args) !== "settings") {
    throw notSupported("Only settings can be set");
  }
  if (!isPlainObject(args.value)) {
    throw badRequest("settings value must be an object");
  }
  return callHandler(handlers, "setSettings", args.value);
}

function readListenType(args) {
  const type = readType(args);
  if (!LISTEN_TYPES.has(type)) throw notSupported("Unsupported listen type");
  return type;
}

async function handleListen({ subscriptions }, args) {
  subscriptions.add(readListenType(args));
  return { subscribed: true };
}

async function handleUnlisten({ subscriptions }, args) {
  subscriptions.delete(readListenType(args));
  return { subscribed: false };
}

const METHODS = new Map([
  ["get", handleGet],
  ["set", handleSet],
  ["listen", handleListen],
  ["unlisten", handleUnlisten],
  ["execute", handleExecute],
  ["storage", handleStorage],
  ["api", handleApi],
]);

function parseRequest(data) {
  if (!isPlainObject(data) || data.protocol !== PROTOCOL) return null;
  if (data.kind !== "request") return null;
  const { requestId, method } = data;
  const validId =
    typeof requestId === "string" &&
    requestId.length >= 1 &&
    requestId.length <= MAX_REQUEST_ID_LENGTH;
  // Map lookup, so "__proto__" or "constructor" never resolve to a handler.
  const run = typeof method === "string" ? METHODS.get(method) : undefined;
  return validId && run ? { requestId, method, run, args: data.args } : null;
}

function toWireError(error, method) {
  if (error instanceof BridgeError) {
    return { message: error.message, code: error.code };
  }
  globalThis.console?.error?.(`host-bridge: ${method} failed`, error);
  return { message: "Internal error", code: "INTERNAL" };
}

/**
 * Creates the host end of the bridge for one app iframe.
 *
 * @param {{ iframe: { contentWindow: object | null }, appOrigin: string,
 *   handlers: object, window?: object }} options
 * @returns {{ emit(type: string, data: unknown): boolean, destroy(): void }}
 */
export function createHostBridge({
  iframe,
  appOrigin,
  handlers,
  window: win = globalThis.window,
} = {}) {
  const origin = parseAppOrigin(appOrigin);
  checkOptions({ iframe, handlers, win });
  const state = { handlers, subscriptions: new Set() };
  let destroyed = false;

  function post(message) {
    const target = iframe.contentWindow;
    if (destroyed || !target) return false;
    target.postMessage(message, origin);
    return true;
  }

  function reply(requestId, outcome) {
    const base = { protocol: PROTOCOL, kind: "response", requestId };
    try {
      post({ ...base, ...outcome });
    } catch (error) {
      // Typically a DataCloneError from a handler result.
      const failure = toWireError(error, "reply");
      if (outcome.ok) post({ ...base, ok: false, error: failure });
    }
  }

  async function respond({ requestId, method, run, args }) {
    try {
      const data = await run(state, args);
      reply(requestId, { ok: true, data });
    } catch (error) {
      reply(requestId, { ok: false, error: toWireError(error, method) });
    }
  }

  function onMessage(event) {
    const source = iframe.contentWindow;
    if (destroyed || !source || event.source !== source) return;
    if (event.origin !== origin) return;
    const request = parseRequest(event.data);
    if (request) respond(request);
  }

  win.addEventListener("message", onMessage);

  return {
    /** Posts an event when the app listens to `type`; returns whether it did. */
    emit(type, data) {
      if (!state.subscriptions.has(type)) return false;
      return post({ protocol: PROTOCOL, kind: "event", type, data });
    },
    /** Stops handling messages; in-flight requests get no reply. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener("message", onMessage);
      state.subscriptions.clear();
    },
  };
}
