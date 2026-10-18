/**
 * The private site gate (SPEC-3 §2). When a site password is configured,
 * every host request needs a site session (a browser session made by
 * `POST /signin`) except the open routes, the sign-in and public-form
 * assets, public forms (which keep their own access rules) and API calls
 * with a valid API token. Everything else is redirected to
 * `/signin?next=<path>` (GET/HEAD navigations) or answered with 401
 * SITE_LOCKED.
 *
 * Sign-in compares SHA-256 digests of the password with
 * `crypto.timingSafeEqual`, answers a wrong password with 401
 * SITE_PASSWORD_INVALID after a fixed delay, and counts attempts per
 * client IP (`clientIp`): FAILURE_LIMIT failures within FAILURE_WINDOW_MS
 * → 429 RATE_LIMITED with `Retry-After`. An attempt is counted when it
 * starts (so parallel guesses cannot overtake the limit) and refunded
 * when it succeeds. Site sessions are browser sessions with an idle time
 * of SITE_SESSION_IDLE_MS (`startServers` sets it); signing out ends them.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CONTENT_TYPES,
  fail,
  fromHostApp,
  readJsonObject,
  readSessionCookie,
  requireJsonType,
  sendJson,
  sessionCookie,
} from "./common.js";
import { matchFormPath } from "./forms.js";
import { clientIp, createRateLimiter } from "./rate-limit.js";
import { sendFile } from "./static.js";

export const SITE_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SITE_PASSWORD_MIN_LENGTH = 12;
export const FAILURE_LIMIT = 5;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_DELAY_MS = 300;
/** The seed admin: every site sign-in starts a session for this user. */
const SITE_USER_ID = "1";
const MAX_NEXT_LENGTH = 2048;
const NEXT_BASE = "http://next.invalid";
// Raw: no whitespace (URL parsers drop tabs and newlines) or backslash.
// Decoded: still no control character or backslash.
const UNSAFE_RAW = /[\p{Cc}\s\\]/u;
const UNSAFE_DECODED = /[\p{Cc}\\]/u;

/** `METHOD /path` of the routes anyone may use. */
const OPEN_ROUTES = new Set(
  ["/signin", "/healthz", "/robots.txt"].flatMap((route) => [
    `GET ${route}`,
    `HEAD ${route}`,
  ]),
);
OPEN_ROUTES.add("POST /signin");
/** `METHOD /path` of the routes a valid API token opens. */
const TOKEN_ROUTES = new Set(["POST /v2", "GET /v2/events"]);

/** The stylesheets `web/signin.html` links and its script. */
export const SIGNIN_ASSETS = Object.freeze([
  "/styles/tokens.css",
  "/styles/base.css",
  "/styles/components.css",
  "/styles/signin.css",
  "/signin.js",
]);
/** What `web/form.html` loads: its stylesheets and every module it imports. */
export const FORM_ASSETS = Object.freeze([
  "/styles/tokens.css",
  "/styles/base.css",
  "/styles/components.css",
  "/styles/forms.css",
  "/form-page.js",
  "/dom.js",
  "/ui/board/values.js",
  "/ui/components/button.js",
  "/ui/components/icon.js",
  "/ui/components/labels.js",
  "/ui/forms/answers.js",
  "/ui/forms/fields.js",
  "/ui/forms/public-api.js",
  "/ui/forms/renderer.js",
  "/ui/shell/theme.js",
]);
// Raw request paths: an encoded spelling of an asset is not open.
const OPEN_ASSETS = new Set([...SIGNIN_ASSETS, ...FORM_ASSETS]);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest();

/** Why `value` cannot be the site password, or null when it can. */
export function sitePasswordProblem(value) {
  if (typeof value !== "string") return "must be a string";
  const length = Array.from(value).length;
  return length >= SITE_PASSWORD_MIN_LENGTH
    ? null
    : `must be at least ${SITE_PASSWORD_MIN_LENGTH} characters long`;
}

/**
 * The gate's state for `cfg.gate`: `verify(candidate)` compares in
 * constant time, `failures` counts sign-in attempts per client and
 * `failureDelayMs` is the wait before a wrong-password answer.
 */
export function createGate({
  password,
  now,
  failureDelayMs = FAILURE_DELAY_MS,
}) {
  const problem = sitePasswordProblem(password);
  if (problem !== null) throw new TypeError(`The site password ${problem}`);
  const digest = sha256(password);
  const failures = createRateLimiter({
    limit: FAILURE_LIMIT,
    windowMs: FAILURE_WINDOW_MS,
    now,
  });
  const verify = (candidate) => timingSafeEqual(sha256(candidate), digest);
  return Object.freeze({ verify, failures, failureDelayMs });
}

/**
 * The same-site path `value` names, or "/": it must start with exactly one
 * "/" (also once percent-decoded), hold no backslash, whitespace or
 * control character (nor, decoded, a backslash or control character),
 * stay on this origin and not be the sign-in page.
 */
export function sanitizeNext(value) {
  if (typeof value !== "string" || value.length > MAX_NEXT_LENGTH) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (UNSAFE_RAW.test(value) || UNSAFE_DECODED.test(decoded)) return "/";
  if (decoded.startsWith("//")) return "/";
  const url = new URL(value, NEXT_BASE);
  if (url.origin !== NEXT_BASE || url.pathname === "/signin") return "/";
  return value;
}

/** A top-level page load (as opposed to fetch, XHR, SSE or a subresource). */
function isNavigation(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const mode = req.headers["sec-fetch-mode"];
  if (mode !== undefined) return mode === "navigate";
  return String(req.headers.accept ?? "").includes("text/html");
}

function isOpen(req, { pathname }) {
  if (OPEN_ROUTES.has(`${req.method} ${pathname}`)) return true;
  const read = req.method === "GET" || req.method === "HEAD";
  // Public forms apply their own public/account/closed rules.
  return (
    (read && OPEN_ASSETS.has(pathname)) || matchFormPath(pathname) !== null
  );
}

const hasSiteSession = (req, cfg) => {
  const sessionId = readSessionCookie(req);
  return sessionId !== null && cfg.auth.getBrowserSession(sessionId) !== null;
};

const tokenOpens = (req, cfg, { pathname }) =>
  TOKEN_ROUTES.has(`${req.method} ${pathname}`) &&
  req.headers.authorization !== undefined &&
  cfg.auth.authenticateApiToken(req.headers.authorization) !== null;

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Content-Length": 0,
  });
  res.end();
}

/**
 * Runs before every host route: true lets the request through; otherwise
 * the request is answered here (a redirect, and false) or refused (throws
 * 401 SITE_LOCKED). Without `cfg.gate` everything passes.
 */
export function guard(req, res, cfg, target) {
  if (!cfg.gate || isOpen(req, target)) return true;
  if (hasSiteSession(req, cfg) || tokenOpens(req, cfg, target)) return true;
  if (!isNavigation(req)) {
    fail(401, "Sign in to this Worklane site first", { code: "SITE_LOCKED" });
  }
  redirect(res, `/signin?next=${encodeURIComponent(sanitizeNext(req.url))}`);
  return false;
}

/** `GET /signin`: the sign-in page, or `next` when already signed in. */
export async function getSignin(req, res, cfg, { search }) {
  if (hasSiteSession(req, cfg)) {
    return redirect(res, sanitizeNext(search.get("next")));
  }
  const file = path.join(cfg.webRoot, "signin.html");
  const headers = { "Cache-Control": "no-store" };
  await sendFile(res, cfg, { file, type: CONTENT_TYPES[".html"], headers });
}

/** Ends the request's old session and starts a site session for user 1. */
function startSiteSession(req, cfg) {
  const previous = readSessionCookie(req);
  if (previous !== null) cfg.auth.endBrowserSession(previous);
  try {
    return cfg.auth.createBrowserSession(SITE_USER_ID);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return fail(403, "The site's admin account (user 1) is deactivated");
  }
}

/** `POST /signin` `{ password, next }` → `{ next }` and a session cookie. */
export async function postSignin(req, res, cfg) {
  const { gate } = cfg;
  requireJsonType(req);
  if (!fromHostApp(req, cfg)) fail(403, "Cross-origin request refused");
  const client = clientIp(req, cfg);
  const attempt = gate.failures.take(client);
  if (!attempt.ok) {
    const headers = { "Retry-After": String(attempt.retryAfter) };
    fail(429, "Too many sign-in attempts; try again later", { headers });
  }
  const { password, next } = await readJsonObject(req);
  if (typeof password !== "string") fail(400, "password must be a string");
  if (!gate.verify(password)) {
    await delay(gate.failureDelayMs);
    fail(401, "That password is not right", { code: "SITE_PASSWORD_INVALID" });
  }
  gate.failures.refund(client);
  const cookie = sessionCookie(cfg, startSiteSession(req, cfg));
  sendJson(res, 200, { next: sanitizeNext(next) }, { "Set-Cookie": cookie });
}
