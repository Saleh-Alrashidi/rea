/**
 * Per-client rate limits of the host server (SPEC-2 §4 public forms,
 * SPEC-3 §2 site sign-in): the one rule that names the client of a
 * request, and the sliding-window limiter the routes count it with.
 *
 * Client IP (SPEC-3 §1 `MM_TRUST_PROXY`): with `cfg.trustProxy` the client
 * is the last `X-Forwarded-For` entry, the hop the platform proxy appended
 * (entries before it are whatever the client sent); otherwise, or when
 * that entry is not an IP address, it is the socket's peer address.
 */
import { isIP } from "node:net";

const MAX_RATE_KEYS = 10_000;

/** The client IP address of `req` for rate limits (see above). */
export function clientIp(req, cfg) {
  const socket = req.socket?.remoteAddress ?? "unknown";
  if (!cfg.trustProxy) return socket;
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string") return socket;
  const last = header.slice(header.lastIndexOf(",") + 1).trim();
  return isIP(last) === 0 ? socket : last.toLowerCase();
}

/**
 * A sliding-window limiter: `take(key)` counts a hit and answers
 * `{ ok: true }`, or `{ ok: false, retryAfter }` (seconds, nothing
 * counted) when `limit` hits are already inside the window; `refund(key)`
 * removes the newest hit of `key` (a counted attempt that turned out not
 * to count). Keys are kept in least recently used order and capped at
 * `maxKeys`.
 */
export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = MAX_RATE_KEYS,
  now = () => Date.now(),
}) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError("limit must be a positive integer");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1)
    throw new TypeError("windowMs must be a positive integer");
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
    refund(key) {
      const recent = hits.get(key);
      if (!recent) return;
      if (recent.length <= 1) hits.delete(key);
      else hits.set(key, recent.slice(0, -1));
    },
  };
}
