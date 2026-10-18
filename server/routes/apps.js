/**
 * App platform routes: session tokens for iframe apps (host server) and,
 * on the apps server, the SDK, `/apps/config.js` and the Status summary
 * app's backend that verifies session tokens.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyJwt } from "../auth.js";
import { isPlainObject } from "../input.js";
import {
  CONTENT_TYPES,
  fail,
  readIdValue,
  readJsonObject,
  requireJsonType,
  sendBody,
  sendJson,
  sessionPrincipal,
} from "./common.js";
import { sendFile } from "./static.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SDK_FILE = path.join(ROOT, "sdk", "mini-monday-sdk.js");
export const STATUS_SUMMARY_PATH = "/apps/status-summary/";

/**
 * `{ install_id }` → a session token for the current user. Installs that
 * are unknown or on boards the user cannot access are both 404.
 */
export async function postSessionToken(req, res, cfg) {
  requireJsonType(req);
  const principal = sessionPrincipal(req, cfg);
  const { install_id: raw } = await readJsonObject(req);
  const installId = readIdValue(raw);
  if (installId === null) fail(400, "install_id must be an install ID");
  const { userId } = principal;
  const issued = cfg.auth.issueSessionToken({ userId, installId });
  if (!issued) fail(404, "Unknown app install");
  sendJson(res, 200, issued);
}

export function getAppsConfig(_req, res, cfg) {
  const body = `export const HOST_ORIGIN = ${JSON.stringify(cfg.hostOrigin)};\n`;
  const headers = { "Cache-Control": "no-store" };
  sendBody(res, { type: CONTENT_TYPES[".js"], body, headers });
}

export function getSdk(_req, res, cfg) {
  const type = CONTENT_TYPES[".js"];
  return sendFile(res, cfg, { file: SDK_FILE, type, csp: cfg.appsCsp });
}

/** The Status summary app's backend: verifies a session token it was given. */
export async function postVerify(req, res, cfg) {
  requireJsonType(req);
  const { sessionToken } = await readJsonObject(req);
  if (typeof sessionToken !== "string")
    fail(400, "sessionToken must be a string");
  const app = cfg.store
    .listApps()
    .find((candidate) => candidate.path.startsWith(STATUS_SUMMARY_PATH));
  if (!app) fail(404, "The Status summary app is not set up");
  const audience = app.client_id;
  const result = verifyJwt(sessionToken, app.client_secret, { audience });
  const payload = result.ok ? result.payload : null;
  const valid = isPlainObject(payload?.dat) && payload.iss === "mini-monday";
  if (!valid) {
    const reason = result.ok ? "malformed" : result.reason;
    return sendJson(res, 401, { ok: false, reason });
  }
  const { user_id, board_id, install_id } = payload.dat;
  const claims = { user_id, board_id, install_id, exp: payload.exp };
  sendJson(res, 200, { ok: true, claims });
}
