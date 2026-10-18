/**
 * HTTP client of the public form page (SPEC-2 §4): `GET /f/<token>/definition`
 * and `POST /f/<token>/submit`. Responses become tagged results here, once,
 * so the page and the renderer read `reason` instead of status codes:
 *
 * | reason         | when                                                  |
 * | -------------- | ----------------------------------------------------- |
 * | `unknown`      | 404: no such form (or its link was regenerated)       |
 * | `closed`       | 403 `FORM_CLOSED`                                     |
 * | `signin`       | 401: an account form needs a signed-in member         |
 * | `rate_limited` | 429: too many responses (`retryAfter` in seconds)     |
 * | `invalid`      | 400 with answer problems (`fields`, `messages`)       |
 * | `unavailable`  | anything else: network failure, 5xx, malformed body   |
 *
 * Requests are same-origin with the session cookie (account forms need
 * it); nothing here reads or stores credentials.
 */

import { normalizeDefinition, splitSubmitErrors } from "./answers.js";

const TOKEN_PATH = /^\/f\/([\w-]{22})\/?$/;

/** The form token of a `/f/<token>` path, or null. */
export function tokenFromPath(pathname) {
  const match = TOKEN_PATH.exec(String(pathname ?? ""));
  return match ? match[1] : null;
}

const firstCode = (body) => body?.errors?.[0]?.extensions?.code;

/** The failure reason for a non-2xx status (shared by both routes). */
function failure(status, body) {
  if (status === 404) return { ok: false, reason: "unknown" };
  if (status === 403 && firstCode(body) === "FORM_CLOSED") {
    return { ok: false, reason: "closed" };
  }
  if (status === 401) return { ok: false, reason: "signin" };
  return { ok: false, reason: "unavailable" };
}

/**
 * The outcome of a definition response.
 * @param {number} status
 * @param {unknown} body parsed JSON (undefined when not JSON)
 * @returns {{ ok: true, definition: object } | { ok: false, reason: string }}
 */
export function definitionOutcome(status, body) {
  if (status !== 200) return failure(status, body);
  const parsed = normalizeDefinition(body);
  return parsed.ok
    ? { ok: true, definition: parsed.value }
    : { ok: false, reason: "unavailable" };
}

function retrySeconds(value) {
  const seconds = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(seconds) && seconds > 0
    ? Math.min(seconds, 3600)
    : 60;
}

/**
 * The outcome of a submit response.
 * @param {number} status
 * @param {unknown} body parsed JSON (undefined when not JSON)
 * @param {{ retryAfter?: string | null }} [headers]
 * @returns {{ ok: true, message: string | null }
 *   | { ok: false, reason: string, fields?: object, messages?: string[],
 *       retryAfter?: number }}
 */
export function submitOutcome(status, body, { retryAfter = null } = {}) {
  if (status === 201 && body?.ok === true) {
    const message = typeof body.message === "string" ? body.message : null;
    return { ok: true, message: message?.trim() || null };
  }
  if (status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfter: retrySeconds(retryAfter),
    };
  }
  if (status === 400) {
    return { ok: false, reason: "invalid", ...splitSubmitErrors(body?.errors) };
  }
  return failure(status, body);
}

async function readBody(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

function formPath(token, action) {
  if (tokenFromPath(`/f/${token}`) === null) {
    throw new TypeError("Invalid form token");
  }
  return `/f/${encodeURIComponent(token)}/${action}`;
}

/**
 * Loads the form behind `token`.
 * @param {string} token
 * @param {{ fetch?: typeof fetch }} [options]
 */
export async function fetchDefinition(
  token,
  { fetch = globalThis.fetch } = {},
) {
  try {
    const response = await fetch(formPath(token, "definition"), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    return definitionOutcome(response.status, await readBody(response));
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Submits answers (`{ [questionId]: string }`) and the honeypot `website`.
 * @param {string} token
 * @param {{ answers: Record<string, string>, website: string }} body
 * @param {{ fetch?: typeof fetch }} [options]
 */
export async function submitAnswers(
  token,
  { answers, website },
  { fetch = globalThis.fetch } = {},
) {
  try {
    const response = await fetch(formPath(token, "submit"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answers, website }),
    });
    return submitOutcome(response.status, await readBody(response), {
      retryAfter: response.headers?.get?.("Retry-After") ?? null,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
