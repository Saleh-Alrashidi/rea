/**
 * Shared parts of the ClickUp connector (SPEC-4 §3.2): GET requests through
 * the bounded upstream client (`../upstream.js`, which owns the token,
 * retries and the 90-per-minute throttle), the guarded read that turns a
 * non-fatal failure into a warning, request paths built only from IDs that
 * cannot leave their path segment, ClickUp's epoch-millisecond times, and
 * the people a scan sees.
 *
 * The helpers every connector shares (warning report, path scopes, scan
 * limits, hex colors) are `common.js`.
 */
import { UpstreamError } from "../upstream.js";
import { SNAPSHOT_LIMITS } from "../snapshot.js";
import { idOf, isObject, str } from "./common.js";

/** Failed requests in a row that end the scan (docs only stop reading). */
export const MAX_FAILURES = 3;
const FATAL = new Set(["INVALID_TOKEN", "ABORTED", "UPSTREAM_CONFIG"]);
// ClickUp's "Team not authorized" codes (OAUTH_023, _026, _027, _029 to
// _045) come with HTTP 401 too: the token works, but not for that team,
// list or task.
const TEAM_NOT_AUTHORIZED = /^OAUTH_0(?:2[367]|29|3\d|4[0-5])$/;
const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EPOCH_MS = /^\d{1,15}$/;
// 9999-12-31T23:59:59.999Z: later times have no YYYY-MM-DD form.
const MAX_EPOCH_MS = 253_402_300_799_999;

/**
 * A ClickUp ID that is safe as a request path segment (letters, digits,
 * `_` and `-`), else null. Rows with other IDs are not requested.
 */
export function pathId(value) {
  const id = idOf(value);
  return id !== null && PATH_ID.test(id) ? id : null;
}

/**
 * Whether a ClickUp answer rejects the token (`createUpstream`'s
 * `tokenRejected`): HTTP 401, unless its ECODE says the token's user may
 * not read that team, list or task (then it is a failed read).
 */
export const tokenRejected = ({ status, json }) =>
  status === 401 && !TEAM_NOT_AUTHORIZED.test(str(json?.ECODE));

/**
 * GET `path` (under the API base, e.g. "/v2/team") with `query` (an object
 * of strings) → the parsed JSON answer. A success resets the count of
 * failed requests in a row.
 */
export async function get(ctx, path, query = null) {
  const search = query ? `?${new URLSearchParams(query)}` : "";
  const { json } = await ctx.client.request({ path: `${path}${search}` });
  ctx.failures = 0;
  return json;
}

/**
 * Runs one read; a non-fatal upstream failure becomes a `read_failed`
 * warning at `path` (→ null) until MAX_FAILURES requests in a row failed.
 * INVALID_TOKEN, ABORTED and UPSTREAM_CONFIG always end the scan.
 */
export async function guarded(ctx, path, what, run) {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof UpstreamError) || FATAL.has(error.code)) throw error;
    ctx.failures += 1;
    if (ctx.failures >= MAX_FAILURES) throw error;
    const message = `${what} could not be read: ${error.message}`;
    ctx.report.add("read_failed", message, path);
    return null;
  }
}

/** ClickUp's epoch milliseconds (number or digit string) → Date, or null. */
function epochDate(value) {
  const text = str(value).trim();
  if (!EPOCH_MS.test(text)) return null;
  const ms = Number(text);
  return ms <= MAX_EPOCH_MS ? new Date(ms) : null;
}

const absent = (value) => value === undefined || value === null || value === "";

// ClickUp stores a due or start date without a time at 4 am in the time
// zone of whoever set it, which the API does not give. That instant plus
// 10 h falls on the day they chose in every zone from UTC−9:30 to UTC+14.
const DATE_ONLY_SHIFT_MS = 10 * 3_600_000;

/**
 * A ClickUp date (epoch ms) as the UTC day "YYYY-MM-DD", or with
 * `dateOnly` (a date without a time) the day it shows (see
 * DATE_ONLY_SHIFT_MS); anything else passes through for the snapshot to
 * report; absent → undefined.
 */
export function dateOf(value, { dateOnly = false } = {}) {
  if (absent(value)) return undefined;
  const date = epochDate(value);
  if (date === null) return value;
  const shift = dateOnly ? DATE_ONLY_SHIFT_MS : 0;
  return new Date(date.getTime() + shift).toISOString().slice(0, 10);
}

/** A ClickUp time (epoch ms) as ISO text; other text passes through. */
export function timeOf(value) {
  if (absent(value)) return null;
  return epochDate(value)?.toISOString() ?? (str(value) || null);
}

/** A snapshot user from ClickUp's `{ id, username, email }`. */
export function userOf(id, raw) {
  const name = typeof raw.username === "string" ? raw.username : null;
  return { source_id: id, name, email: str(raw.email).trim() || null };
}

/**
 * The source ID of a person ClickUp shows (`{ id, username, email }` or
 * an ID). A person with details who is not known yet (not a team member
 * any more, for instance) is added to the snapshot's users, so their
 * assignments can still be mapped.
 */
export function noteUser(ctx, raw) {
  const id = idOf(isObject(raw) ? raw.id : raw);
  if (id === null || ctx.users.has(id) || !isObject(raw)) return id;
  if (ctx.users.size < SNAPSHOT_LIMITS.users) {
    ctx.users.set(id, userOf(id, raw));
  }
  return id;
}
