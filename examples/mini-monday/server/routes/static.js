/**
 * Static files of both servers (`web/` on the host, `apps/<app>/` on the
 * apps server) with the path rules of SPEC.md: the path is decoded once,
 * `..`/`.` segments, dotfiles, empty segments, NUL and backslashes are
 * refused, only known extensions are served and the real path must stay
 * inside the real root.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CONTENT_TYPES, HttpError, fail, sendBody } from "./common.js";

/** Maps a raw URL path to `{ file, type }` under `root`, or null. */
async function resolveStatic(root, rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "Malformed percent-encoding in the path");
  }
  const segments = decoded.split("/").slice(1);
  const safe = (segment) =>
    segment !== "" &&
    !segment.startsWith(".") &&
    !segment.includes("\\") &&
    !segment.includes("\0");
  const extension = path.extname(decoded).toLowerCase();
  if (!segments.every(safe) || !Object.hasOwn(CONTENT_TYPES, extension)) {
    return null;
  }
  try {
    const real = await realpath(path.resolve(root, ...segments));
    const info = await stat(real);
    const inside = real.startsWith(`${root}${path.sep}`);
    return inside && info.isFile()
      ? { file: real, type: CONTENT_TYPES[extension] }
      : null;
  } catch {
    return null;
  }
}

/** Sends a file with `csp` (default: the host CSP) and `no-cache`. */
export async function sendFile(res, cfg, options) {
  const { file, type, headers = {}, csp, status = 200 } = options;
  const body = await readFile(file);
  const policy = { "Content-Security-Policy": csp ?? cfg.hostCsp };
  const cache = { "Cache-Control": "no-cache" };
  const all = { ...cache, ...policy, ...headers };
  sendBody(res, { status, type, body, headers: all });
}

/** Static fallback: 404 for unknown files, 405 for non-GET methods. */
export function staticRoute({ root, prefix = "", minSegments = 1, csp }) {
  return async (req, res, cfg, { pathname }) => {
    const rest = pathname.slice(prefix.length);
    const deep = rest.split("/").length - 1 >= minSegments;
    const found =
      pathname.startsWith(`${prefix}/`) && deep
        ? await resolveStatic(cfg[root], rest)
        : null;
    if (!found) fail(404, "Not found");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const headers = { Allow: "GET, HEAD" };
      throw new HttpError(405, "Method not allowed", { headers });
    }
    await sendFile(res, cfg, { ...found, csp: cfg[csp] });
  };
}
