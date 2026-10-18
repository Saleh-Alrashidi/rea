/**
 * API routes of the host server: `POST /v2` (GraphQL), `GET
 * /v2/get_schema` (public SDL) and `GET /v2/events` (server-sent events for
 * one accessible board, or `stream=me` for the caller's notifications).
 */
import { boardAccess } from "../access.js";
import { GraphQLError } from "../graphql/errors.js";
import { execute } from "../graphql/execute.js";
import { parse } from "../graphql/parse.js";
import { printSchema } from "../graphql/schema.js";
import { resolveApiVersion } from "../versions.js";
import { ID_PATTERN, isPlainObject } from "../input.js";
import {
  HttpError,
  fail,
  readJsonObject,
  readSessionCookie,
  requestPrincipal,
  requireJsonType,
  sendBody,
  sendJson,
  sessionPrincipal,
  tokenPrincipal,
} from "./common.js";

/** API token, browser session, or the app principal of `X-App-Install`. */
function apiPrincipal(req, cfg) {
  const install = req.headers["x-app-install"];
  if (req.headers.authorization !== undefined) {
    if (install !== undefined)
      fail(400, "X-App-Install needs a browser session");
    return tokenPrincipal(req, cfg);
  }
  const principal = sessionPrincipal(req, cfg);
  if (install === undefined) return principal;
  const installId = typeof install === "string" ? install.trim() : "";
  const app = ID_PATTERN.test(installId)
    ? cfg.auth.appPrincipal(principal, installId)
    : null;
  if (!app) fail(403, "Unknown app install");
  return app;
}

function readGraphqlRequest(body) {
  const { query, variables = null, operationName = null } = body;
  if (typeof query !== "string" || query.trim() === "")
    fail(400, "query must be a non-empty string");
  if (variables !== null && !isPlainObject(variables))
    fail(400, "variables must be a JSON object");
  if (operationName !== null && typeof operationName !== "string")
    fail(400, "operationName must be a string");
  return { query, variables: variables ?? {}, operationName };
}

/** Parses and executes one operation; parse errors become `{ errors }`. */
async function runGraphql(cfg, { request, principal, apiVersion }) {
  let document;
  try {
    document = parse(request.query);
  } catch (error) {
    if (error instanceof GraphQLError) return { errors: [error] };
    throw error;
  }
  const { store, hostOrigin, appsOrigin, log } = cfg;
  const requireScope = (scope) => {
    if (!principal.scopes.has(scope)) {
      throw new GraphQLError(`Missing scope ${scope}`, { code: "FORBIDDEN" });
    }
  };
  const context = { store, principal, apiVersion, hostOrigin, appsOrigin };
  Object.assign(context, { log, requireScope });
  const { variables, operationName } = request;
  const run = { schema: cfg.schema, document, variables, operationName };
  return execute({ ...run, context, apiVersion });
}

function apiVersionOf(value) {
  const version = resolveApiVersion(value);
  if (version.ok) return version.value;
  const { message, code } = version.error;
  throw new HttpError(400, message, { code });
}

export async function postGraphql(req, res, cfg) {
  const apiVersion = apiVersionOf(req.headers["api-version"]);
  res.setHeader("API-Version", apiVersion);
  requireJsonType(req);
  const principal = apiPrincipal(req, cfg);
  const request = readGraphqlRequest(await readJsonObject(req));
  const result = await runGraphql(cfg, { request, principal, apiVersion });
  sendJson(res, Object.hasOwn(result, "data") ? 200 : 400, result);
}

export function getSchema(_req, res, cfg, { search }) {
  const apiVersion = apiVersionOf(search.get("version"));
  if ((search.get("format") ?? "sdl") !== "sdl")
    fail(400, 'format must be "sdl"');
  let sdl = cfg.sdl.get(apiVersion);
  if (sdl === undefined) {
    sdl = printSchema(cfg.schema, { apiVersion });
    cfg.sdl.set(apiVersion, sdl);
  }
  const headers = { "API-Version": apiVersion, "Cache-Control": "no-cache" };
  sendBody(res, { type: "text/plain; charset=utf-8", body: sdl, headers });
}

/**
 * `?board_id=<id>` streams one board's changes while the caller can access
 * it (an inaccessible board is 404 like an unknown one); `?stream=me`
 * streams the caller's notification events.
 */
export function getEvents(req, res, cfg, { search }) {
  const principal = requestPrincipal(req, cfg, { sameOriginFetch: true });
  if (!principal.scopes.has("boards:read"))
    fail(403, "Missing scope boards:read");
  const { userId } = principal;
  // The stream ends with the browser session that opened it.
  const sessionId =
    principal.kind === "session" ? readSessionCookie(req) : null;
  const stream = search.get("stream");
  if (stream !== null) {
    if (stream !== "me") fail(400, 'stream must be "me"');
    const options = { stream: "me", userId, sessionId };
    return void cfg.events.handle(req, res, options);
  }
  const boardId = search.get("board_id") ?? "";
  if (!ID_PATTERN.test(boardId)) fail(400, "board_id must be a board ID");
  const { store } = cfg;
  const access = boardAccess(
    store,
    store.getUser(userId),
    store.getBoard(boardId),
  );
  if (access === null) fail(404, "Unknown board");
  cfg.events.handle(req, res, { boardId, userId, sessionId });
}
