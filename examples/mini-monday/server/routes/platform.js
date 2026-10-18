/**
 * Hosted-mode routes for the platform around the server (SPEC-3 §2, §4):
 * `GET /healthz` for health checks and `GET /robots.txt`, which asks
 * crawlers to stay away. Neither carries data; the site gate leaves both
 * open.
 */
import { sendBody } from "./common.js";

const TEXT = "text/plain; charset=utf-8";
const ROBOTS = "User-agent: *\nDisallow: /\n";

/** `GET /healthz`: 200 `ok` while the server answers requests. */
export function getHealthz(_req, res) {
  const headers = { "Cache-Control": "no-store" };
  sendBody(res, { type: TEXT, body: "ok", headers });
}

/** `GET /robots.txt`: disallows everything. */
export function getRobots(_req, res) {
  const headers = { "Cache-Control": "no-cache" };
  sendBody(res, { type: TEXT, body: ROBOTS, headers });
}
