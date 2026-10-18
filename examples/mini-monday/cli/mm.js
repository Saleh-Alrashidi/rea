#!/usr/bin/env node
/**
 * mm: a small command-line client for the mini-monday GraphQL API.
 *
 * Transport rules (SPEC.md "CLI"): https: endpoints always verify server
 * certificates (--ca-file adds one trusted CA to the default set; it never
 * replaces or weakens verification); plain http: is allowed only for loopback
 * hosts; --read-only refuses every document that is not a query before
 * anything is sent; each request has a deadline and responses are capped at
 * 10 MiB. Text that came from the server is escaped before it reaches the
 * terminal so it cannot inject control sequences.
 */
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { parse } from "../server/graphql/parse.js";
import {
  cell,
  escapeTerminal,
  isObject,
  jsonText,
  table,
  tryJson,
} from "./terminal.js";

const DEFAULT_ENDPOINT = "http://localhost:4100/v2";
const DEFAULT_TIMEOUT_MS = 15_000;
// setTimeout clamps larger delays to 1 ms, so they cannot be honored.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 4096;
const MAX_PAGES = 1000;
const MAX_ITEMS_PAGE = 500;
// Item pages stay well inside the server's 5,000 resolved-field budget.
const ITEMS_FIELD_BUDGET = 3000;
const BOARDS_PAGE_LIMIT = 100;
const USER_AGENT = "mini-monday-cli/0.1.0";

/** A CLI failure with its exit code and any GraphQL errors to report. */
class CliError extends Error {
  constructor(message, { exitCode = 1, errors = [] } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.errors = errors;
  }
}

/** A command-line usage error (exit code 2). */
export class UsageError extends CliError {
  constructor(message) {
    super(message, { exitCode: 2 });
    this.name = "UsageError";
  }
}

const refused = (message) => new CliError(message, { exitCode: 3 });

const HELP = `Usage: mm <command> [args] [options]

Commands:
  me                                     Show the current user
  boards                                 List boards (id, name, items)
  items <boardId>                        List all items with status and owner
  create-item <boardId> <name> [--group <id>]   Create an item
  set-status <boardId> <itemId> <label>  Set the "status" column by label
  query <graphql> [--variables <json>]   Run a raw GraphQL document
  schema [--api-version <v>]             Print the schema SDL

Options:
  --endpoint <url>   Default $MM_ENDPOINT or ${DEFAULT_ENDPOINT}
  --token <token>    Default $MM_TOKEN (preferred over this visible argument)
  --api-version <v>  API version, for example 2026-01
  --read-only        Refuse anything that is not a query (or =true|=false)
  --ca-file <path>   Also trust this CA certificate (PEM) for https:
  --json             Print raw JSON
  --timeout <ms>     Per-request timeout (default ${DEFAULT_TIMEOUT_MS})
  --help             Show this help

Exit codes: 0 success, 1 API/HTTP error, 2 usage error, 3 refused (read-only).
`;

const TOKEN_WARNING =
  "mm: warning: --token is visible to other local processes and may be kept " +
  "in shell history; prefer the MM_TOKEN environment variable.\n";

// ------------------------------------------------------------------ parsing

function parseTimeout(raw) {
  const value = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
  if (value >= 1 && value <= MAX_TIMEOUT_MS) return value;
  throw new UsageError(`--timeout must be 1-${MAX_TIMEOUT_MS} milliseconds`);
}

function parseVariables(raw) {
  const value = tryJson(raw);
  if (isObject(value) && !Array.isArray(value)) return value;
  throw new UsageError("--variables must be a JSON object");
}

function parseApiVersion(raw) {
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  throw new UsageError("--api-version must look like YYYY-MM");
}

// `parse` marks a value option; `commands` limits an option to those commands.
const identity = (raw) => raw;
const OPTIONS = new Map([
  ["endpoint", { parse: identity }],
  ["token", { parse: identity }],
  ["api-version", { parse: parseApiVersion }],
  ["read-only", {}],
  ["ca-file", { parse: identity }],
  ["json", {}],
  ["timeout", { parse: parseTimeout }],
  ["help", {}],
  ["group", { parse: identity, commands: ["create-item"] }],
  ["variables", { parse: parseVariables, commands: ["query"] }],
]);

const COMMANDS = new Map([
  ["me", { args: [], run: runMe }],
  ["boards", { args: [], run: runBoards }],
  ["items", { args: ["boardId"], run: runItems }],
  ["create-item", { args: ["boardId", "name"], run: runCreateItem }],
  ["set-status", { args: ["boardId", "itemId", "label"], run: runSetStatus }],
  ["query", { args: ["graphql"], run: runQuery }],
  ["schema", { args: [], run: runSchema }],
]);

/** Reads one option at argv[index]; returns the index of its last word. */
function readOption(argv, index, given) {
  const match = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(argv[index]);
  const spec = match ? OPTIONS.get(match[1]) : undefined;
  // Only the name is echoed, so a mistyped "--tokn=<secret>" stays private.
  if (!spec) {
    throw new UsageError(`unknown option ${cell(argv[index].split("=")[0])}`);
  }
  const [, name, inline] = match;
  if (given.has(name)) throw new UsageError(`--${name} was given twice`);
  if (!spec.parse) {
    if (inline !== undefined && inline !== "true" && inline !== "false") {
      throw new UsageError(`--${name} accepts only =true or =false`);
    }
    given.set(name, inline !== "false");
    return index;
  }
  const raw = inline ?? argv[index + 1];
  if (raw === undefined || (inline === undefined && raw.startsWith("--"))) {
    const hint = `use --${name}=<value> for a value starting with "--"`;
    throw new UsageError(`--${name} requires a value (${hint})`);
  }
  if (raw === "") throw new UsageError(`--${name} must not be empty`);
  given.set(name, spec.parse(raw));
  return inline === undefined ? index + 1 : index;
}

function checkCommand(command, positionals, given) {
  const help = given.get("help") === true;
  if (command === null && help) return;
  if (command === null) throw new UsageError("missing command");
  const spec = COMMANDS.get(command);
  if (!spec) throw new UsageError(`unknown command ${cell(command)}`);
  for (const name of given.keys()) {
    const allowed = OPTIONS.get(name).commands;
    if (allowed && !allowed.includes(command)) {
      throw new UsageError(`--${name} is not valid for ${command}`);
    }
  }
  if (help) return;
  const { args } = spec;
  if (positionals.length > args.length) {
    throw new UsageError(`too many arguments for ${command}`);
  }
  const missing = args.find(
    (_, i) => positionals[i] === undefined || positionals[i].trim() === "",
  );
  if (missing) throw new UsageError(`${command} requires a <${missing}>`);
}

/**
 * Parses command-line words (without the node and script paths). Options
 * accept `--name value` and `--name=value`; flags are bare (true) or
 * `=true|false`; `--` ends options. Unknown, repeated, misplaced or invalid
 * options and missing or extra positionals throw UsageError.
 * @param {string[]} argv
 * @returns {{ command: string | null, positionals: string[],
 *   options: Record<string, unknown> }}
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
    throw new UsageError("arguments must be an array of strings");
  }
  const words = [];
  const given = new Map();
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (optionsEnded || !arg.startsWith("-") || arg === "-") words.push(arg);
    else if (arg === "--") optionsEnded = true;
    else index = readOption(argv, index, given);
  }
  const [command = null, ...positionals] = words;
  checkCommand(command, positionals, given);
  const options = { readOnly: false, json: false, help: false };
  for (const [name, value] of given) {
    options[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return { command, positionals, options };
}

/**
 * Accepts https: URLs, and http: URLs only for loopback hosts (`localhost`,
 * 127.0.0.0/8, `[::1]`). Rejects other schemes and embedded credentials.
 * @param {string | URL} url
 * @returns {URL} the parsed endpoint
 * @throws {UsageError}
 */
export function assertSafeEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError("endpoint must be an absolute http: or https: URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UsageError("endpoint must not contain credentials");
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol !== "http:") {
    throw new UsageError("endpoint must use https: (or http: for loopback)");
  }
  // WHATWG URL parsing already normalized IPv4 forms such as 127.1 or 0x7f.1.
  const { hostname } = parsed;
  const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (ipv4Loopback || hostname === "localhost" || hostname === "[::1]") {
    return parsed;
  }
  throw new UsageError(
    `refusing plain http: to non-loopback host ${cell(hostname)}: the token ` +
      "and data would travel unencrypted. Use an https: endpoint (with " +
      "--ca-file for a private CA).",
  );
}

/**
 * Returns the operation type of a GraphQL document, parsed with the server's
 * parser: "mutation" when any operation is a mutation, else "query" when one
 * is a query, else null (including unparseable documents).
 * @param {string} query
 * @returns {"query" | "mutation" | null}
 */
export function operationType(query) {
  let document;
  try {
    document = parse(query);
  } catch {
    return null;
  }
  const types = document.definitions
    .filter((definition) => definition.kind === "OperationDefinition")
    .map((definition) => definition.operation);
  if (types.includes("mutation")) return "mutation";
  return types.includes("query") ? "query" : null;
}

// ---------------------------------------------------------------- transport

const transportError = (message, code) =>
  Object.assign(new Error(message), { code });

/**
 * Sends one HTTP request with a deadline and a response size cap; resolves
 * `{ status, body }` with a UTF-8 body. Certificate verification uses Node's
 * defaults; `ctx.ca` (the default CAs plus --ca-file) only extends trust.
 */
function send(ctx, { url, method, headers, body }) {
  const all = { "user-agent": USER_AGENT, ...headers };
  if (body !== undefined) all["content-length"] = Buffer.byteLength(body);
  // agent: false uses one connection, so nothing keeps the process alive.
  const options = { method, headers: all, agent: false };
  if (ctx.ca) options.ca = ctx.ca;
  const transport = url.protocol === "https:" ? https : http;
  // Settling is first-wins, so late events after a failure are harmless.
  const { promise, resolve, reject } = Promise.withResolvers();
  const req = transport.request(url, options);
  const fail = (error) => {
    reject(error);
    req.destroy();
  };
  const tooLarge = () =>
    fail(transportError("response exceeds 10 MiB; aborted", "TOO_LARGE"));
  const timeout = `request timed out after ${ctx.timeoutMs} ms`;
  const onTimeout = () => fail(transportError(timeout, "TIMEOUT"));
  const timer = setTimeout(onTimeout, ctx.timeoutMs);
  req.on("error", fail);
  req.on("response", (res) => {
    if (Number(res.headers["content-length"]) > MAX_RESPONSE_BYTES) {
      return tooLarge();
    }
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) tooLarge();
      else chunks.push(chunk);
    });
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({ status: res.statusCode, body: text });
    });
    res.on("error", fail);
    res.on("close", () => {
      if (!res.complete) fail(new Error("connection closed early"));
    });
  });
  req.end(body);
  return promise.finally(() => clearTimeout(timer));
}

function errorsOf(payload) {
  const errors = payload?.errors;
  return Array.isArray(errors) && errors.length > 0 ? errors : null;
}

/** Returns a JSON object body; anything else (or non-2xx sans errors) fails. */
function readPayload({ status, body }, { allowErrors = true } = {}) {
  const payload = tryJson(body);
  const errors = errorsOf(payload);
  const ok = status >= 200 && status < 300;
  if (isObject(payload) && (ok || (allowErrors && errors))) return payload;
  const message = `unexpected HTTP ${status} response from the server`;
  throw new CliError(message, { errors: errors ?? [] });
}

/** Posts a GraphQL document; resolves the `{ data, errors? }` body. */
async function graphql(ctx, query, variables) {
  // Fail closed: anything that is not provably a query is refused.
  const type = ctx.options.readOnly ? operationType(query) : "query";
  if (type !== "query") {
    const what = type === "mutation" ? "a mutation" : "a non-query document";
    throw refused(`read-only mode refused ${what}; nothing was sent`);
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${ctx.token}`,
  };
  if (ctx.options.apiVersion) headers["api-version"] = ctx.options.apiVersion;
  const body = JSON.stringify({ query, variables });
  const request = { url: ctx.endpoint, method: "POST", headers, body };
  return readPayload(await send(ctx, request));
}

/** Runs a GraphQL document and returns `data`, throwing on any error. */
async function fetchData(ctx, query, variables) {
  const payload = await graphql(ctx, query, variables);
  const errors = errorsOf(payload);
  if (!errors && payload.data != null) return payload.data;
  throw new CliError("GraphQL request failed", { errors: errors ?? [] });
}

/** Writes `value` as JSON with --json, else the text from `render()`. */
function output(ctx, value, render) {
  ctx.stdout.write(ctx.options.json ? jsonText(value) : render());
}

// ----------------------------------------------------------------- commands

const firstText = (values, type) =>
  values.find((value) => value.type === type)?.text ?? null;

async function runMe(ctx) {
  const query = "query CliMe { me { id name email is_admin } }";
  const { me } = await fetchData(ctx, query);
  const admin = me.is_admin ? "yes" : "no";
  const fields = { ID: me.id, Name: me.name, Email: me.email, Admin: admin };
  output(ctx, me, () => table(Object.entries(fields)));
}

async function runBoards(ctx) {
  const query =
    "query CliBoards($limit: Int!, $page: Int!) " +
    "{ boards(limit: $limit, page: $page) { id name items_count } }";
  const boards = new Map();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const variables = { limit: BOARDS_PAGE_LIMIT, page };
    const data = await fetchData(ctx, query, variables);
    const before = boards.size;
    for (const board of data.boards) boards.set(board.id, board);
    // A page without new boards means the server ignored `page`: stop.
    if (data.boards.length < BOARDS_PAGE_LIMIT || boards.size === before) break;
  }
  const list = [...boards.values()];
  const rows = list.map((board) => [board.id, board.name, board.items_count]);
  output(ctx, list, () => table([["ID", "NAME", "ITEMS"], ...rows]));
}

const ITEMS_BOARD_QUERY =
  "query CliItemsBoard($board: ID!) " +
  "{ boards(ids: [$board]) { id name columns { id } } }";
const ITEMS_QUERY =
  "query CliItems($board: ID!, $limit: Int!, $cursor: String) " +
  "{ boards(ids: [$board]) { items_page(limit: $limit, " +
  "cursor: $cursor) { cursor items { id name group { id title } " +
  "column_values { id type text } } } } }";

/** Items per page for `columnCount` columns, within ITEMS_FIELD_BUDGET. */
function itemsPageLimit(columnCount) {
  // Each item resolves 6 fields plus 3 per column value.
  const fit = Math.floor(ITEMS_FIELD_BUDGET / (6 + 3 * columnCount));
  return Math.min(MAX_ITEMS_PAGE, Math.max(1, fit));
}

async function runItems(ctx) {
  const [boardId] = ctx.positionals;
  const missing = () => new CliError(`board ${cell(boardId)} was not found`);
  const variables = { board: boardId };
  const [board] = (await fetchData(ctx, ITEMS_BOARD_QUERY, variables)).boards;
  if (!board) throw missing();
  // The column count sets how many items fit in one request.
  const limit = itemsPageLimit(board.columns.length);
  const items = [];
  const cursors = new Set();
  let cursor = null;
  do {
    if (cursors.size >= MAX_PAGES) throw new CliError("too many item pages");
    const pageVariables = { board: boardId, limit, cursor };
    const [page] = (await fetchData(ctx, ITEMS_QUERY, pageVariables)).boards;
    if (!page) throw missing();
    items.push(...page.items_page.items);
    cursor = page.items_page.cursor ?? null;
    if (cursors.has(cursor)) throw new CliError("the server repeated a cursor");
    cursors.add(cursor);
  } while (cursor !== null);
  const rows = items.map((item) => [
    item.id,
    item.name,
    item.group?.title,
    firstText(item.column_values, "status"),
    firstText(item.column_values, "people"),
  ]);
  const title = `${cell(board.name)}: ${items.length} item(s)\n`;
  const header = ["ID", "NAME", "GROUP", "STATUS", "OWNER"];
  const value = { id: board.id, name: board.name, items };
  output(ctx, value, () => title + table([header, ...rows]));
}

async function runCreateItem(ctx) {
  const query =
    "mutation CliCreateItem($board: ID!, $group: String, $name: String!) " +
    "{ create_item(board_id: $board, group_id: $group, item_name: $name) " +
    "{ id name group { id title } } }";
  const [board, name] = ctx.positionals;
  const variables = { board, name };
  if (ctx.options.group !== undefined) variables.group = ctx.options.group;
  const { create_item: item } = await fetchData(ctx, query, variables);
  const group = item.group ? ` in group ${cell(item.group.title)}` : "";
  const text = `Created item ${cell(item.id)} ${cell(item.name)}${group}\n`;
  output(ctx, item, () => text);
}

async function runSetStatus(ctx) {
  const query =
    "mutation CliSetStatus($board: ID!, $item: ID!, $label: String) " +
    "{ change_simple_column_value(board_id: $board, item_id: $item, " +
    'column_id: "status", value: $label) ' +
    '{ id name column_values(ids: ["status"]) { id type text } } }';
  const [board, item, label] = ctx.positionals;
  const data = await fetchData(ctx, query, { board, item, label });
  const updated = data.change_simple_column_value;
  const status = cell(firstText(updated.column_values, "status"));
  const text = `Item ${cell(updated.id)} ${cell(updated.name)}: ${status}\n`;
  output(ctx, updated, () => text);
}

async function runQuery(ctx) {
  const payload = await graphql(ctx, ctx.positionals[0], ctx.options.variables);
  ctx.stdout.write(jsonText(payload));
  const errors = errorsOf(payload);
  if (errors) throw new CliError("GraphQL request failed", { errors });
}

async function runSchema(ctx) {
  // An absolute path keeps the endpoint origin and drops its query string.
  const path = `${ctx.endpoint.pathname.replace(/\/+$/, "")}/get_schema`;
  const url = new URL(path, ctx.endpoint);
  const { apiVersion } = ctx.options;
  if (apiVersion) url.searchParams.set("version", apiVersion);
  url.searchParams.set("format", "sdl");
  const headers = { accept: "text/plain" };
  const response = await send(ctx, { url, method: "GET", headers });
  if (response.status !== 200) readPayload(response, { allowErrors: false });
  const sdl = escapeTerminal(response.body, { keepLayout: true });
  const text = sdl.endsWith("\n") ? sdl : `${sdl}\n`;
  output(ctx, { sdl: response.body }, () => text);
}

// --------------------------------------------------------------------- main

function readToken(raw, command) {
  if (raw === undefined || raw === "") {
    // The schema endpoint is public, so it is sent without a token.
    if (command === "schema") return null;
    throw new UsageError("no API token: set MM_TOKEN or pass --token");
  }
  if (/^[\x21-\x7e]+$/.test(raw) && raw.length <= MAX_TOKEN_LENGTH) return raw;
  throw new UsageError("the API token contains invalid characters");
}

async function loadCa(path, endpoint) {
  if (endpoint.protocol !== "https:") {
    throw new UsageError("--ca-file applies only to https: endpoints");
  }
  const pem = await readFile(path, "utf8").catch((error) => {
    throw new UsageError(`cannot read --ca-file (${cell(error.code)})`);
  });
  try {
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error("PEM");
    // Parses the first certificate so a wrong file fails here, clearly.
    new X509Certificate(pem);
  } catch {
    throw new UsageError("--ca-file must contain a PEM certificate");
  }
  // `ca` replaces the trust store, so keep the default CAs and add this one.
  const defaults = tls.getCACertificates?.("default") ?? tls.rootCertificates;
  return [...defaults, pem];
}

async function createContext({ command, positionals, options }, io) {
  const source = options.endpoint ?? (io.env.MM_ENDPOINT || DEFAULT_ENDPOINT);
  const endpoint = assertSafeEndpoint(source);
  if (options.token !== undefined) io.stderr.write(TOKEN_WARNING);
  const token = readToken(options.token ?? io.env.MM_TOKEN, command);
  const ca = options.caFile ? await loadCa(options.caFile, endpoint) : null;
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  return { endpoint, token, ca, options, positionals, timeoutMs, ...io };
}

const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET_ISSUER)/;
const TLS_HINT =
  "mm: the server certificate was not accepted; use --ca-file <pem> to " +
  "trust a private CA (verification is never disabled)";

function report(error, stderr) {
  const lines = (error?.errors ?? []).map((entry) => {
    const code = entry?.extensions?.code;
    const suffix = typeof code === "string" ? ` [${cell(code)}]` : "";
    return `mm: ${escapeTerminal(entry?.message ?? "error")}${suffix}`;
  });
  if (lines.length === 0) {
    lines.push(`mm: ${escapeTerminal(error?.message ?? error)}`);
  }
  if (error instanceof UsageError) lines.push('Run "mm --help" for usage.');
  if (TLS_CODE.test(error?.code)) lines.push(TLS_HINT);
  stderr.write(`${lines.join("\n")}\n`);
  return error instanceof CliError ? error.exitCode : 1;
}

/**
 * Runs the CLI and resolves the exit code: 0 success, 1 API/HTTP error,
 * 2 usage error, 3 refused by read-only mode.
 * @param {string[]} argv command-line words without node and script paths
 * @param {{ env?: object, stdout?: { write(text: string): unknown },
 *   stderr?: { write(text: string): unknown } }} [io]
 * @returns {Promise<number>}
 */
export async function main(
  argv,
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const args = parseArgs(argv);
    if (args.options.help) {
      stdout.write(HELP);
      return 0;
    }
    const ctx = await createContext(args, { env, stdout, stderr });
    await COMMANDS.get(args.command).run(ctx);
    return 0;
  } catch (error) {
    return report(error, stderr);
  }
}

// import.meta.main is false when this module is imported (by tests).
if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  // A reader that stops early (`mm items 4 | head -1`) ends the output; it
  // is not a failure of the command.
  process.stdout.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
    process.exit(process.exitCode ?? 0);
  });
  process.exitCode = await main(process.argv.slice(2));
}
