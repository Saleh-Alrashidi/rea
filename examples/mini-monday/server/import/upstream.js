/**
 * The importers' bounded HTTPS client (SPEC-4 §1). It talks only to the
 * fixed upstream bases (`https://api.monday.com/v2`, `https://api.clickup.com/api`)
 * unless the operator's environment overrides them for tests
 * (`MM_IMPORT_MONDAY_URL` / `MM_IMPORT_CLICKUP_URL`: https, or http on a
 * loopback host); callers pass paths, never URLs. Every request follows no
 * redirects, reads at most 10 MiB, times out after 30 s, honors the caller's
 * abort signal, and retries 429 / 5xx / source-specific hints (monday
 * complexity errors) with `Retry-After`, `X-RateLimit-Reset` or capped
 * exponential backoff, at most 5 attempts. An optional sliding window keeps
 * a source under N requests per minute (ClickUp).
 *
 * The token lives only in the client's closure: it is sent as the
 * `Authorization` header and never appears in a URL, a log line or an error;
 * any upstream text that is put in an error passes through `redact` with
 * every form of it (`secretForms`: as sent, without a "Bearer " scheme,
 * and URL-encoded), which the job registry uses for what a scan keeps.
 */
import { setTimeout as delay } from "node:timers/promises";

/** Bounds of every upstream request; tests may lower them per client. */
export const UPSTREAM_DEFAULTS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
});

const SOURCES = Object.freeze({
  monday: Object.freeze({
    label: "monday.com",
    base: "https://api.monday.com/v2",
    env: "MM_IMPORT_MONDAY_URL",
  }),
  clickup: Object.freeze({
    label: "ClickUp",
    base: "https://api.clickup.com/api",
    env: "MM_IMPORT_CLICKUP_URL",
  }),
});

const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const TOKEN_PATTERN = /^[\x21-\x7e]+(?: [\x21-\x7e]+)?$/;
const MAX_TOKEN_LENGTH = 4096;
const MAX_MESSAGE_LENGTH = 200;
const REDACTED = "[redacted]";
const MIN_CREDENTIAL = 8;
// Shorter waits (backoff between quick retries) are not announced.
const WAIT_NOTICE_MS = 1000;

/**
 * An expected upstream failure. `code` is one of INVALID_TOKEN, ABORTED,
 * UPSTREAM_CONFIG, UPSTREAM_TIMEOUT, UPSTREAM_TOO_LARGE, UPSTREAM_REDIRECT,
 * UPSTREAM_HTTP, UPSTREAM_BAD_JSON, UPSTREAM_UNREACHABLE,
 * UPSTREAM_RATE_LIMITED, or a connector's own code (UPSTREAM_ERROR). The
 * message never contains the token; `status` is the HTTP status or null.
 */
export class UpstreamError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
  }

  toJSON() {
    return { code: this.code, message: this.message, status: this.status };
  }
}

const isLoopback = (hostname) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  LOOPBACK_IPV4.test(hostname);

function sourceSpec(source) {
  if (typeof source === "string" && Object.hasOwn(SOURCES, source)) {
    return SOURCES[source];
  }
  throw new UpstreamError("UPSTREAM_CONFIG", "Unknown import source");
}

/**
 * The base URL of `source` ("monday" | "clickup"): the fixed host, or the
 * environment override. A malformed override fails closed (UPSTREAM_CONFIG)
 * instead of falling back to the real host.
 */
export function upstreamBase(source, env = process.env) {
  const spec = sourceSpec(source);
  const raw = env?.[spec.env];
  if (raw === undefined || raw === "") return new URL(spec.base);
  const url =
    typeof raw === "string" && URL.canParse(raw) ? new URL(raw) : null;
  const secure = url?.protocol === "https:";
  const local = url?.protocol === "http:" && isLoopback(url.hostname);
  if (!url || !(secure || local) || url.username || url.password) {
    throw new UpstreamError(
      "UPSTREAM_CONFIG",
      `${spec.env} must be an https: URL (http: only on a loopback host) without credentials`,
    );
  }
  if (url.search || url.hash) {
    throw new UpstreamError(
      "UPSTREAM_CONFIG",
      `${spec.env} must not have a query or fragment`,
    );
  }
  return url;
}

/**
 * The URL of `path` under `base`. `path` is "" or starts with "/", may
 * carry a query, and must stay under the base path (no "..", "//", "#",
 * backslashes or whitespace, even percent-encoded).
 */
export function upstreamUrl(base, path = "") {
  const basePath = base.pathname.replace(/\/$/, "");
  const bad =
    typeof path !== "string" ||
    (path !== "" && !path.startsWith("/")) ||
    /\/\/|\.\.|[#\\\s]/.test(path);
  const url = bad ? null : new URL(`${base.origin}${basePath}${path}`);
  const inside =
    url &&
    url.origin === base.origin &&
    (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) &&
    !/%2e|%2f|%5c/i.test(url.pathname);
  if (!inside) {
    throw new UpstreamError("UPSTREAM_CONFIG", "Invalid upstream path");
  }
  return url;
}

/**
 * The texts token `token` can appear as, longest first: the header value
 * as sent (trimmed), the credential after its scheme ("Bearer abc…" →
 * "abc…"; the token format allows one space) when it has at least
 * MIN_CREDENTIAL characters (shorter parts would redact ordinary words),
 * and their URL-encoded forms.
 */
export function secretForms(token) {
  if (typeof token !== "string" || token.trim() === "") return [];
  const sent = token.trim();
  const credential = sent.slice(sent.indexOf(" ") + 1);
  const parts =
    credential.length >= MIN_CREDENTIAL ? [sent, credential] : [sent];
  const forms = parts.flatMap((form) => [form, encodeURIComponent(form)]);
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/** `text` with every form of `secret` (see `secretForms`) replaced. */
export function redact(text, secret) {
  let out = String(text ?? "");
  for (const form of secretForms(secret)) out = out.split(form).join(REDACTED);
  return out;
}

function checkToken(token, spec) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new UpstreamError(
      "INVALID_TOKEN",
      `A ${spec.label} API token is required`,
    );
  }
  const trimmed = token.trim();
  if (trimmed.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(trimmed)) {
    throw new UpstreamError(
      "INVALID_TOKEN",
      `The ${spec.label} API token has an invalid format`,
    );
  }
  return trimmed;
}

/** Throws ABORTED when `signal` has been aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new UpstreamError("ABORTED", "The import was cancelled");
  }
}

function bounded(limits) {
  const out = { ...UPSTREAM_DEFAULTS };
  for (const key of Object.keys(UPSTREAM_DEFAULTS)) {
    const value = limits?.[key];
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  out.maxAttempts = Math.max(1, Math.floor(out.maxAttempts));
  return out;
}

/**
 * A client for one scan. Options: `source` ("monday" | "clickup"), `token`,
 * `signal`, `tokenRejected(response)` (default: HTTP 401; such answers,
 * `{ status, headers, json }`, become INVALID_TOKEN without retrying, so a
 * source can tell a rejected token from other refusals by their body),
 * `onWait({ seconds, reason, status, perMinute })` (told before each wait
 * of a second or more: `reason` "throttle" for the per-minute budget,
 * "rate_limit" for a 429 or retry hint, "retry" for a 5xx), `perMinute`
 * (request budget per sliding
 * minute, or null), and test seams `env`, `limits` (lower UPSTREAM_DEFAULTS)
 * and `clock` ({ now(), sleep(ms, signal) }). Throws INVALID_TOKEN for a
 * missing or malformed token and UPSTREAM_CONFIG for a bad override.
 *
 * `request({ method, path, headers, body, retryHint })` → Promise of
 * `{ status, headers, json }` for a 2xx JSON answer. `body` is sent as JSON;
 * `retryHint(response)` may return `{ afterSeconds: number | null }` to
 * retry a response the status alone would accept (monday complexity
 * errors). `safeMessage(text)` redacts, strips control characters and
 * shortens upstream text for warnings.
 */
export function createUpstream(options = {}) {
  const spec = sourceSpec(options.source);
  const secret = checkToken(options.token, spec);
  const state = {
    spec,
    secret,
    base: upstreamBase(options.source, options.env ?? process.env),
    bounds: bounded(options.limits),
    signal: options.signal ?? null,
    rejected:
      typeof options.tokenRejected === "function"
        ? options.tokenRejected
        : (response) => response.status === 401,
    perMinute: Number.isInteger(options.perMinute) ? options.perMinute : null,
    onWait: typeof options.onWait === "function" ? options.onWait : null,
    window: [],
    now: options.clock?.now ?? Date.now,
    sleep:
      options.clock?.sleep ?? ((ms, signal) => delay(ms, null, { signal })),
  };
  return Object.freeze({
    label: spec.label,
    request: (request) => requestWithRetries(state, request ?? {}),
    safeMessage: (text) => safeMessage(state, text),
  });
}

function safeMessage(state, text) {
  const clean = redact(text, state.secret)
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return clean.length > MAX_MESSAGE_LENGTH
    ? `${clean.slice(0, MAX_MESSAGE_LENGTH)}…`
    : clean;
}

async function pause(state, ms, wait) {
  throwIfAborted(state.signal);
  const delayMs = Math.max(0, Math.ceil(ms));
  if (delayMs >= WAIT_NOTICE_MS && state.onWait) {
    const seconds = Math.ceil(delayMs / 1000);
    state.onWait({ seconds, perMinute: state.perMinute, ...wait });
  }
  try {
    await state.sleep(delayMs, state.signal ?? undefined);
  } catch (error) {
    throwIfAborted(state.signal);
    throw error;
  }
  throwIfAborted(state.signal);
}

async function throttle(state) {
  if (state.perMinute === null || state.perMinute < 1) return;
  const prune = () => {
    const cutoff = state.now() - 60_000;
    while (state.window.length > 0 && state.window[0] <= cutoff) {
      state.window.shift();
    }
  };
  prune();
  while (state.window.length >= state.perMinute) {
    const ms = state.window[0] + 60_000 - state.now();
    await pause(state, ms, { reason: "throttle", status: null });
    prune();
  }
  state.window.push(state.now());
}

async function requestWithRetries(state, request) {
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(state.signal);
    await throttle(state);
    const response = await attemptOnce(state, request);
    const wait = retryDelay(state, response, request.retryHint, attempt);
    if (wait === null) return finish(state, response);
    if (attempt >= state.bounds.maxAttempts) throw exhausted(state, response);
    const { status } = response;
    const reason = status >= 500 ? "retry" : "rate_limit";
    await pause(state, wait, { reason, status });
  }
}

async function attemptOnce(
  state,
  { method = "GET", path = "", headers, body },
) {
  const url = upstreamUrl(state.base, path);
  const timeout = AbortSignal.timeout(state.bounds.timeoutMs);
  const signal = state.signal
    ? AbortSignal.any([state.signal, timeout])
    : timeout;
  const sent = new Headers(headers ?? {});
  sent.set("Accept", "application/json");
  sent.set("Authorization", state.secret);
  if (body !== undefined && !sent.has("Content-Type")) {
    sent.set("Content-Type", "application/json");
  }
  const init = { method, headers: sent, redirect: "manual", signal };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const response = await fetch(url, init);
    const bytes = await readCapped(state, response);
    return {
      status: response.status,
      headers: response.headers,
      json: parseJson(bytes),
    };
  } catch (error) {
    throw transportError(state, error, timeout);
  }
}

function tooLarge(state) {
  const mib = Math.round((state.bounds.maxBytes / 1024 / 1024) * 100) / 100;
  return new UpstreamError(
    "UPSTREAM_TOO_LARGE",
    `${state.spec.label} sent a response larger than ${mib} MiB`,
  );
}

async function readCapped(state, response) {
  const { maxBytes } = state.bounds;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(state);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(state);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** Parsed JSON, or undefined when the body is empty or not JSON. */
function parseJson(bytes) {
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function transportError(state, error, timeout) {
  if (error instanceof UpstreamError) return error;
  if (state.signal?.aborted) {
    return new UpstreamError("ABORTED", "The import was cancelled");
  }
  const { label } = state.spec;
  if (timeout.aborted) {
    const seconds = Math.round(state.bounds.timeoutMs / 100) / 10;
    return new UpstreamError(
      "UPSTREAM_TIMEOUT",
      `${label} did not answer within ${seconds} s`,
    );
  }
  // Only a system error code is reported: fetch messages may quote headers.
  const code = error?.cause?.code ?? error?.code;
  const detail = typeof code === "string" && /^[A-Z_]{2,40}$/.test(code);
  return new UpstreamError(
    "UPSTREAM_UNREACHABLE",
    `Could not reach ${label}${detail ? ` (${code})` : ""}`,
  );
}

/** Seconds to wait from `Retry-After` (seconds or date) or `X-RateLimit-Reset`. */
export function headerDelaySeconds(headers, nowMs = Date.now()) {
  const retryAfter = headers?.get?.("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, (date - nowMs) / 1000);
  }
  const reset = headers?.get?.("x-ratelimit-reset")?.trim();
  if (!reset || !/^\d+$/.test(reset)) return null;
  const value = Number(reset);
  if (value < 1e9) return value; // a delay in seconds
  const resetMs = value > 1e11 ? value : value * 1000; // epoch ms or seconds
  return Math.max(0, (resetMs - nowMs) / 1000);
}

function retryDelay(state, response, retryHint, attempt) {
  const { status } = response;
  if (state.rejected(response) || (status >= 300 && status < 400)) {
    return null;
  }
  const hint = typeof retryHint === "function" ? retryHint(response) : null;
  if (!hint && !RETRY_STATUSES.has(status)) return null;
  const hinted =
    hint?.afterSeconds ?? headerDelaySeconds(response.headers, state.now());
  const ms =
    Number.isFinite(hinted) && hinted >= 0
      ? hinted * 1000
      : state.bounds.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(ms, state.bounds.maxDelayMs);
}

/** The upstream's own error text in common JSON shapes, or "". */
function upstreamText(json) {
  const first = Array.isArray(json?.errors) ? json.errors[0] : undefined;
  const candidates = [
    first?.message,
    first,
    json?.error_message,
    json?.err,
    json?.error,
    json?.message,
  ];
  return candidates.find((value) => typeof value === "string") ?? "";
}

function httpError(state, code, response, summary) {
  const detail = safeMessage(state, upstreamText(response.json));
  const message = detail ? `${summary}: ${detail}` : summary;
  return new UpstreamError(code, message, { status: response.status });
}

function exhausted(state, response) {
  const { label } = state.spec;
  const attempts = state.bounds.maxAttempts;
  if (
    response.status === 429 ||
    (response.status >= 200 && response.status < 300)
  ) {
    return httpError(
      state,
      "UPSTREAM_RATE_LIMITED",
      response,
      `${label} was still rate limiting after ${attempts} attempts`,
    );
  }
  return httpError(
    state,
    "UPSTREAM_HTTP",
    response,
    `${label} answered HTTP ${response.status} after ${attempts} attempts`,
  );
}

function finish(state, response) {
  const { status } = response;
  const { label } = state.spec;
  if (state.rejected(response)) {
    const message = `${label} rejected the API token (HTTP ${status})`;
    throw new UpstreamError("INVALID_TOKEN", message, { status });
  }
  if (status >= 300 && status < 400) {
    const message = `${label} answered with a redirect (HTTP ${status}), which is not followed`;
    throw new UpstreamError("UPSTREAM_REDIRECT", message, { status });
  }
  if (status < 200 || status >= 300) {
    throw httpError(
      state,
      "UPSTREAM_HTTP",
      response,
      `${label} answered HTTP ${status}`,
    );
  }
  if (response.json === undefined) {
    const message = `${label} sent a response that is not JSON`;
    throw new UpstreamError("UPSTREAM_BAD_JSON", message, { status });
  }
  return response;
}
