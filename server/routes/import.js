/**
 * Import routes of the host server (SPEC-4 §5). Every route is for users
 * with the `import_data` capability (admins, `access.can`); others get 403
 * FORBIDDEN. Callers authenticate like the API: a browser session from the
 * host app (its `Origin`, or `Sec-Fetch-Site: same-origin` for GETs) or an
 * API token with `boards:write` (`boards:read` to read jobs). In hosted
 * mode the site gate runs first.
 *
 * - `POST /import/scan`: JSON `{ source: "monday" | "clickup", token,
 *   options? }` (the usual 1 MiB JSON limit), or a raw file:
 *   `Content-Type: application/octet-stream`, `X-Import-Filename` (may be
 *   percent-encoded UTF-8), `X-Import-Kind: csv | xlsx`, optional
 *   `X-Import-Options` (a JSON object), at most 20 MiB. → 202 `{ job_id }`.
 * - `GET /import/jobs/<id>` → the job (its creator only; others 404).
 * - `POST /import/jobs/<id>/cancel` → the job, cancelled or stopping.
 * - `POST /import/run`: JSON `{ scan_job_id, plan }` → 202 `{ job_id }`;
 *   an invalid plan is 400 with `extensions.errors` (`{ path, message }`).
 *
 * At most one running job per admin and two per server (429 with
 * Retry-After). The source token is read from the scan body, handed to the
 * job registry and never echoed, logged or kept (`import/jobs.js`).
 *
 * Connector options: the flags `include_docs`, `include_comments`
 * (ClickUp), `include_updates` and `include_subitems` (monday), `limits`
 * `{ boards ≤ 1,000, items ≤ 100,000, updates ≤ 50,000, docs ≤ 1,000 }`
 * (positive integers; connectors only lower their own defaults with them)
 * and, for files, `column_types` (`{ [column]: "text" | "status" |
 * "people" | "date" | "numbers" }`, at most 200). Anything else is
 * refused, so no caller can hand a connector a URL or a test seam.
 */
import { can } from "../access.js";
import { isPlainObject } from "../input.js";
import { COLUMN_TYPES } from "../store-state.js";
import {
  HttpError,
  fail,
  readJsonObject,
  requestPrincipal,
  requireJsonType,
  sendJson,
} from "./common.js";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const JOB_PATH = /^\/import\/jobs\/([\w-]{22})(\/cancel)?$/;
const TOKEN_SOURCES = Object.freeze(["monday", "clickup"]);
const FILE_KINDS = Object.freeze(["csv", "xlsx"]);
const MAX_TOKEN_LENGTH = 4096;
// Printable ASCII, optionally one space ("Bearer …"); never echoed.
const TOKEN_PATTERN = /^[\x21-\x7e]+(?: [\x21-\x7e]+)?$/;
const MAX_OPTIONS_HEADER = 8 * 1024;
const MAX_FILENAME = 255;
const UNSAFE_FILENAME = /[\p{Cc}/\\]/u;
const MAX_COLUMN_TYPES = 200;
/** The largest `limits` a scan may ask for (the snapshot limits). */
const LIMIT_CAPS = Object.freeze({
  boards: 1_000,
  items: 100_000,
  updates: 50_000,
  docs: 1_000,
});
const FLAGS = Object.freeze([
  "include_docs",
  "include_comments",
  "include_updates",
  "include_subitems",
]);
const BUSY = Object.freeze({
  busy_user: "You already have an import job running",
  busy_server:
    "The server is running as many import jobs as it can; try again soon",
});

/** The importing user: an active user with `import_data` and the scope. */
function importer(req, cfg, { read = false } = {}) {
  const principal = requestPrincipal(req, cfg, { sameOriginFetch: read });
  const scope = read ? "boards:read" : "boards:write";
  if (!principal.scopes.has(scope)) fail(403, `Missing scope ${scope}`);
  const user = cfg.store.getUser(principal.userId);
  if (!can(user, "import_data")) fail(403, "Only admins can import");
  return user;
}

function readColumnTypes(value) {
  const entries = isPlainObject(value) ? Object.entries(value) : null;
  const valid =
    entries !== null &&
    entries.length <= MAX_COLUMN_TYPES &&
    entries.every(([, type]) => COLUMN_TYPES.includes(type));
  if (!valid)
    fail(
      400,
      `column_types maps at most ${MAX_COLUMN_TYPES} columns to ${COLUMN_TYPES.join(", ")}`,
    );
  return Object.fromEntries(entries);
}

const quoted = (key) => JSON.stringify(key.slice(0, 40));

function readLimits(value) {
  if (!isPlainObject(value)) fail(400, "limits must be a JSON object");
  const limits = {};
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(LIMIT_CAPS, key))
      fail(400, `Unknown limit ${quoted(key)}`);
    const max = LIMIT_CAPS[key];
    const valid = Number.isSafeInteger(limit) && limit >= 1 && limit <= max;
    if (!valid) fail(400, `limits.${key} must be an integer from 1 to ${max}`);
    limits[key] = limit;
  }
  return limits;
}

/** Connector options (see the module comment); unknown ones are refused. */
export function readOptions(raw, { file }) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) fail(400, "options must be a JSON object");
  const options = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FLAGS.includes(key)) {
      if (typeof value !== "boolean") fail(400, `${key} must be a boolean`);
      options[key] = value;
    } else if (key === "limits") {
      options.limits = readLimits(value);
    } else if (key === "column_types" && file) {
      options.column_types = readColumnTypes(value);
    } else {
      fail(400, `Unknown option ${quoted(key)}`);
    }
  }
  return options;
}

function readToken(value) {
  const valid =
    typeof value === "string" &&
    value.length <= MAX_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(value);
  if (valid) return value;
  // The message never repeats the value.
  return fail(
    400,
    `token must be the API token (printable characters, at most ${MAX_TOKEN_LENGTH})`,
  );
}

function header(req, name) {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim() : "";
}

function readFilename(req) {
  let name = header(req, "x-import-filename");
  try {
    name = name.includes("%") ? decodeURIComponent(name) : name;
  } catch {
    name = "";
  }
  const valid =
    name !== "" && name.length <= MAX_FILENAME && !UNSAFE_FILENAME.test(name);
  return valid
    ? name
    : fail(
        400,
        "X-Import-Filename must name the file (no slashes, at most 255 characters)",
      );
}

function readOptionsHeader(req) {
  const text = header(req, "x-import-options");
  if (text === "") return {};
  if (text.length > MAX_OPTIONS_HEADER)
    fail(400, "X-Import-Options is too long");
  try {
    return readOptions(JSON.parse(text), { file: true });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(400, "X-Import-Options must be a JSON object");
  }
}

/** Reads a raw body of at most MAX_FILE_BYTES. */
function readFileBody(req) {
  const tooLarge = () =>
    new HttpError(413, "Import files are limited to 20 MiB");
  if (Number(req.headers["content-length"]) > MAX_FILE_BYTES) throw tooLarge();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= MAX_FILE_BYTES) return void chunks.push(chunk);
      req.off("data", onData);
      reject(tooLarge());
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
    req.once("close", () => reject(new HttpError(400, "Request aborted")));
  });
}

const contentType = (req) =>
  String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

function started(res, result) {
  if (result.ok) return sendJson(res, 202, { job_id: result.job.id });
  const headers = { "Retry-After": "5" };
  if (Object.hasOwn(BUSY, result.reason))
    fail(429, BUSY[result.reason], { headers });
  if (result.reason === "invalid_plan")
    fail(400, "The import plan is not valid", {
      details: { errors: result.errors },
    });
  fail(404, "Unknown or expired scan job");
}

/** The parts of a scan request after the busy check (see startScan). */
async function scanRequest(req) {
  if (contentType(req) === "application/octet-stream") {
    const kind = header(req, "x-import-kind");
    if (!FILE_KINDS.includes(kind))
      fail(400, "X-Import-Kind must be csv or xlsx");
    const name = readFilename(req);
    const options = readOptionsHeader(req);
    const bytes = await readFileBody(req);
    if (bytes.length === 0) fail(400, "The file is empty");
    return { source: kind, file: { name, kind, bytes }, options };
  }
  requireJsonType(req);
  const body = await readJsonObject(req);
  for (const key of Object.keys(body)) {
    if (!["source", "token", "options"].includes(key))
      fail(400, `Unknown field ${quoted(key)}`);
  }
  if (!TOKEN_SOURCES.includes(body.source))
    fail(
      400,
      'source must be "monday" or "clickup" (send files as application/octet-stream)',
    );
  const token = readToken(body.token);
  return {
    source: body.source,
    token,
    options: readOptions(body.options, { file: false }),
  };
}

/** `POST /import/scan` (see the module comment). */
export async function postImportScan(req, res, cfg) {
  const user = importer(req, cfg);
  // Refuse before reading up to 20 MiB that could not run anyway.
  const reason = cfg.imports.busyReason(user.id);
  if (reason) fail(429, BUSY[reason], { headers: { "Retry-After": "5" } });
  const scan = await scanRequest(req);
  started(res, cfg.imports.startScan({ userId: user.id, ...scan }));
}

/** `POST /import/run` (see the module comment). */
export async function postImportRun(req, res, cfg) {
  const user = importer(req, cfg);
  requireJsonType(req);
  const { scan_job_id: scanJobId, plan = {} } = await readJsonObject(req);
  if (typeof scanJobId !== "string") fail(400, "scan_job_id must be a job ID");
  started(res, cfg.imports.startImport({ userId: user.id, scanJobId, plan }));
}

/** `{ id, cancel }` for `/import/jobs/<id>[/cancel]`, or null. */
export function matchImportJobPath(pathname) {
  const match = JOB_PATH.exec(pathname);
  return match ? { id: match[1], cancel: match[2] !== undefined } : null;
}

/** `GET /import/jobs/<id>` and `POST /import/jobs/<id>/cancel`. */
export function importJobRoute(req, res, cfg, { id, cancel }) {
  const method = cancel ? "POST" : "GET";
  if (req.method !== method)
    throw new HttpError(405, "Method not allowed", {
      headers: { Allow: method },
    });
  const user = importer(req, cfg, { read: !cancel });
  const job = cancel
    ? cfg.imports.cancel(id, user.id)
    : cfg.imports.get(id, user.id);
  if (job === null) fail(404, "Unknown import job");
  sendJson(res, 200, job);
}
