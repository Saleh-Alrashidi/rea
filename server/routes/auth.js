/**
 * Browser sign-in routes of the host server (SPEC-2 §4).
 *
 * Demo mode (`demoLogin`, on unless `MM_DEMO_LOGIN=0`) signs every new
 * browser in as user 1 on `GET /` and offers `GET /auth/demo-users` and
 * `POST /auth/demo-login` to switch users; without demo mode those routes
 * are 404 and `GET /` creates no session. `POST /auth/logout` always ends
 * the session and clears the cookie.
 *
 * Session principals are resolved from the current user record on every
 * request (`server/auth.js`), so role changes and deactivation apply at
 * once.
 */
import path from "node:path";
import { isActive } from "../access.js";
import {
  CONTENT_TYPES,
  clearedSessionCookie,
  fail,
  fromHostApp,
  readIdValue,
  readJsonObject,
  readSessionCookie,
  requireJsonType,
  sendJson,
  sendNoContent,
  sessionCookie,
  sessionPrincipal,
} from "./common.js";
import { sendFile } from "./static.js";

const DEMO_USER_ID = "1";

const requireDemo = (cfg) => {
  if (!cfg.demoLogin) fail(404, "Not found");
};

/** A new session for the demo user, or null when it cannot sign in. */
function demoSession(cfg) {
  try {
    return cfg.auth.createBrowserSession(DEMO_USER_ID);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** `GET /`: the boards app; in demo mode, new browsers sign in as user 1. */
export async function getIndex(req, res, cfg) {
  const headers = { "Cache-Control": "no-store" };
  const sessionId = readSessionCookie(req);
  const known = sessionId !== null && cfg.auth.getBrowserSession(sessionId);
  if (!known && cfg.demoLogin) {
    const id = demoSession(cfg);
    if (id !== null) headers["Set-Cookie"] = sessionCookie(cfg, id);
  }
  const file = path.join(cfg.webRoot, "index.html");
  await sendFile(res, cfg, { file, type: CONTENT_TYPES[".html"], headers });
}

/** `GET /auth/demo-users`: the users of the demo switcher. */
export function getDemoUsers(req, res, cfg) {
  requireDemo(cfg);
  sessionPrincipal(req, cfg, { sameOriginFetch: true });
  const users = cfg.store
    .listUsers()
    .map(({ id, name, role, title, color, status }) => ({
      id,
      name,
      role,
      title,
      color,
      status,
    }));
  sendJson(res, 200, { users });
}

/** `POST /auth/demo-login` `{ user_id }`: switches to an active user. */
export async function postDemoLogin(req, res, cfg) {
  requireDemo(cfg);
  requireJsonType(req);
  sessionPrincipal(req, cfg);
  const { user_id: raw } = await readJsonObject(req);
  const userId = readIdValue(raw);
  const user = userId === null ? null : cfg.store.getUser(userId);
  if (!isActive(user)) fail(400, "Choose an active user");
  const sessionId = readSessionCookie(req);
  const next = cfg.auth.rotateBrowserSession(sessionId, user.id);
  if (next === null) fail(400, "Choose an active user");
  sendNoContent(res, { "Set-Cookie": sessionCookie(cfg, next) });
}

/** `POST /auth/logout`: ends the session (if any) and clears the cookie. */
export function postLogout(req, res, cfg) {
  if (!fromHostApp(req, cfg)) fail(403, "Cross-origin request refused");
  const sessionId = readSessionCookie(req);
  if (sessionId !== null) cfg.auth.endBrowserSession(sessionId);
  sendNoContent(res, { "Set-Cookie": clearedSessionCookie(cfg) });
}
