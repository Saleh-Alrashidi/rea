/**
 * Public form routes (SPEC-2 §4):
 *
 * - `GET /f/<token>`: `web/form.html` with the host CSP (never framed);
 *   unknown tokens get the same page with status 404, which then shows
 *   its "form not found" state.
 * - `GET /f/<token>/definition`: the questions, without anything about
 *   the board behind the form.
 * - `POST /f/<token>/submit`: validates the answers with the column
 *   parsers and records the submission (`store.submitForm` creates the
 *   item, counts the response, logs activity and notifies board owners).
 *
 * Access: `public` forms need nothing, `account` forms the session of an
 * active non-guest user (else 401), `closed` forms answer 403
 * FORM_CLOSED. Submissions also need a host `Origin` when one is sent, are
 * limited to RATE_LIMIT per minute per client IP and form (429
 * RATE_LIMITED), and a filled honeypot `website` field is acknowledged
 * with 201 without creating anything.
 */
import path from "node:path";
import { isActive, isGuest } from "../access.js";
import { parseSimpleColumnValue, statusOptions } from "../column-values.js";
import { SUBMIT_MESSAGE } from "../store/forms.js";
import { isPlainObject } from "../input.js";
import {
  CONTENT_TYPES,
  HttpError,
  fail,
  fromHostApp,
  readJsonObject,
  readSessionCookie,
  requireJsonType,
  sendJson,
} from "./common.js";
import { sendFile } from "./static.js";

const FORM_PATH = /^\/f\/([^/]+)(?:\/(definition|submit))?$/;
const TOKEN_PATTERN = /^[\w-]{22}$/;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_KEYS = 10_000;
const METHODS = {
  page: ["GET", "HEAD"],
  definition: ["GET"],
  submit: ["POST"],
};

/**
 * A sliding-window limiter: `take(key)` → `{ ok: true }` or
 * `{ ok: false, retryAfter }` (seconds). Keys are kept in least recently
 * used order and capped at `maxKeys`.
 */
export function createRateLimiter({
  limit = RATE_LIMIT,
  windowMs = RATE_WINDOW_MS,
  maxKeys = MAX_RATE_KEYS,
  now = () => Date.now(),
} = {}) {
  const hits = new Map();
  return {
    take(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
      hits.delete(key);
      if (recent.length >= limit) {
        hits.set(key, recent);
        const retryAfter = Math.ceil((windowMs - (at - recent[0])) / 1000);
        return { ok: false, retryAfter: Math.max(retryAfter, 1) };
      }
      hits.set(key, [...recent, at]);
      for (const oldest of hits.keys()) {
        if (hits.size <= maxKeys) break;
        hits.delete(oldest);
      }
      return { ok: true };
    },
  };
}

/** `{ token, action }` for a `/f/…` path, or null. */
export function matchFormPath(pathname) {
  const match = FORM_PATH.exec(pathname);
  return match ? { token: match[1], action: match[2] ?? "page" } : null;
}

/** The form behind `token` when its board still exists, else null. */
function formOf(cfg, token) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const form = cfg.store.findFormByToken(token);
  return form && cfg.store.getBoard(form.board_id) ? form : null;
}

const closed = () => fail(403, "This form is closed", { code: "FORM_CLOSED" });

/** Applies the form's access rule to the request. */
function checkAccess(req, cfg, form, { sameOriginFetch }) {
  if (form.access === "closed") closed();
  if (form.access !== "account") return;
  const sessionId = readSessionCookie(req);
  const principal =
    sessionId !== null && fromHostApp(req, cfg, { sameOriginFetch })
      ? cfg.auth.getBrowserSession(sessionId)
      : null;
  const user = principal ? cfg.store.getUser(principal.userId) : null;
  if (!isActive(user) || isGuest(user)) {
    fail(401, "Sign in with a Worklane account to use this form");
  }
}

/** The questions with their column type (skipping removed columns). */
function questionsOf(cfg, form) {
  return form.questions.flatMap((question) => {
    const column = cfg.store.getColumn(form.board_id, question.column_id);
    return column ? [{ question, column }] : [];
  });
}

function sendPage(res, cfg, status) {
  const file = path.join(cfg.webRoot, "form.html");
  const headers = { "Cache-Control": "no-store" };
  return sendFile(res, cfg, {
    file,
    type: CONTENT_TYPES[".html"],
    headers,
    status,
  });
}

function getDefinition(req, res, cfg, form) {
  checkAccess(req, cfg, form, { sameOriginFetch: true });
  const questions = questionsOf(cfg, form).map(({ question, column }) => {
    const { id, label, help, required } = question;
    const entry = { id, label, help, required, type: column.type };
    if (column.type !== "status") return entry;
    return { ...entry, options: statusOptions(column).map((o) => o.label) };
  });
  sendJson(res, 200, {
    title: form.title,
    description: form.description,
    accent_color: form.accent_color,
    submit_message: form.submit_message ?? SUBMIT_MESSAGE,
    questions,
  });
}

/** Parses the answers into `{ name, values }` or a list of errors. */
function readAnswers(cfg, form, answers) {
  const errors = [];
  const fields = { name: null, values: {} };
  const problem = (question, message) =>
    errors.push({
      message,
      extensions: { code: "BAD_USER_INPUT", question_id: question.id },
    });
  for (const { question, column } of questionsOf(cfg, form)) {
    const raw = Object.hasOwn(answers, question.id)
      ? answers[question.id]
      : null;
    if (raw !== null && typeof raw !== "string") {
      problem(question, `${question.label}: answers must be text`);
      continue;
    }
    if ((raw ?? "").trim() === "") {
      if (question.required) problem(question, `${question.label} is required`);
      continue;
    }
    const parsed = parseSimpleColumnValue(column, raw, { getUser: () => null });
    if (!parsed.ok) problem(question, `${question.label}: ${parsed.message}`);
    else if (column.type === "name") fields.name = parsed.value;
    else if (parsed.value !== null) fields.values[column.id] = parsed.value;
  }
  return { errors, fields };
}

function storeFailure(result) {
  if (result === null) fail(404, "Unknown form");
  if (result.reason === "form_closed") closed();
  const message = result.message ?? "The response could not be recorded";
  fail(400, message, { code: "BAD_USER_INPUT" });
}

async function postSubmit(req, res, cfg, form) {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== cfg.hostOrigin) {
    fail(403, "Cross-origin request refused");
  }
  requireJsonType(req);
  checkAccess(req, cfg, form, { sameOriginFetch: false });
  const client = req.socket.remoteAddress ?? "unknown";
  const allowed = cfg.formLimiter.take(`${client}|${form.id}`);
  if (!allowed.ok) {
    const headers = { "Retry-After": String(allowed.retryAfter) };
    fail(429, "Too many responses; try again in a minute", { headers });
  }
  const body = await readJsonObject(req);
  const message = form.submit_message ?? SUBMIT_MESSAGE;
  const { website = "", answers = {} } = body;
  if (website !== "" && website !== null) {
    return sendJson(res, 201, { ok: true, message });
  }
  if (!isPlainObject(answers)) {
    fail(400, "answers must be an object", { code: "BAD_USER_INPUT" });
  }
  const { errors, fields } = readAnswers(cfg, form, answers);
  if (errors.length > 0) return sendJson(res, 400, { errors });
  const result = cfg.store.submitForm(form.id, fields);
  if (result === null || result.ok === false) storeFailure(result);
  sendJson(res, 201, { ok: true, message });
}

/** Handles every `/f/…` request matched by `matchFormPath`. */
export async function formRoute(req, res, cfg, { token, action }) {
  const methods = METHODS[action];
  if (!methods.includes(req.method)) {
    const headers = { Allow: methods.join(", ") };
    throw new HttpError(405, "Method not allowed", { headers });
  }
  const form = formOf(cfg, token);
  if (action === "page") return sendPage(res, cfg, form ? 200 : 404);
  if (!form) fail(404, "Unknown form");
  if (action === "definition") return getDefinition(req, res, cfg, form);
  return postSubmit(req, res, cfg, form);
}
