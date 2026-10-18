/**
 * Recently opened boards and docs, remembered per user in this browser (a
 * convenience only: storage may be empty, blocked or cleared). Readers
 * intersect the IDs with records the API returned, so a remembered ID never
 * reveals anything the user can no longer access.
 */

const MAX_RECENT = 12;
const KINDS = new Set(["board", "doc"]);
const ID_PATTERN = /^\d{1,20}$/;

const storageKey = (userId) => `worklane-recent:${userId}`;

function read(userId) {
  try {
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem(storageKey(userId)) ?? "{}",
    );
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Records that `userId` opened the `kind` ("board" | "doc") record `id`. */
export function rememberVisit(userId, kind, id) {
  if (!KINDS.has(kind) || !ID_PATTERN.test(String(id))) return;
  const entries = read(userId);
  const list = Array.isArray(entries[kind]) ? entries[kind] : [];
  entries[kind] = [
    String(id),
    ...list.filter((entry) => entry !== String(id)),
  ].slice(0, MAX_RECENT);
  try {
    globalThis.localStorage?.setItem(
      storageKey(userId),
      JSON.stringify(entries),
    );
  } catch {
    // Not remembered; recency is a convenience.
  }
}

/**
 * Orders `records` (with `id`) most recently opened first; records never
 * opened keep their order after them.
 */
export function byRecency(userId, kind, records) {
  const list = read(userId)[kind];
  const order = new Map(
    (Array.isArray(list) ? list : []).map((id, index) => [String(id), index]),
  );
  return [...records].sort(
    (a, b) =>
      (order.get(String(a.id)) ?? Infinity) -
      (order.get(String(b.id)) ?? Infinity),
  );
}
