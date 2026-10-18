/**
 * App storage (part 1). A deleted key keeps a tombstone (`value: null`)
 * with its last version, so a key written again never reuses a version
 * number and stale `previousVersion` values keep conflicting. Storage
 * writes are not board changes and emit no change event.
 *
 * Retention is bounded per segment (scope key): at most MAX_LIVE_KEYS live
 * keys (more → `storage_full`) and MAX_TOMBSTONES tombstones. Older
 * tombstones fold into the segment's floor entry (key "", which no real
 * key can be): new keys start above it, so versions stay unique per key.
 */
import {
  SCOPE_KEY,
  failure,
  push,
  removeWhere,
  replace,
  requireCount,
} from "../store-state.js";

// Unspecified: bounds that keep one app from growing the data file forever.
export const MAX_LIVE_KEYS = 1000;
export const MAX_TOMBSTONES = 1000;
const FLOOR_KEY = "";

export function storageApi(ctx) {
  const { state } = ctx;
  const inScope = (scope) => state.storage.filter((e) => e.scope === scope);
  const entryOf = (scope, key) => {
    if (typeof scope !== "string" || !SCOPE_KEY.test(scope)) {
      throw new TypeError("scopeKey must be install:<id> or app:<id>");
    }
    if (typeof key !== "string") throw new TypeError("key must be a string");
    return state.storage.find((e) => e.scope === scope && e.key === key);
  };
  const put = (entry, next) => {
    if (entry) replace(state.storage, entry, next);
    else push(state.storage, next);
    ctx.persist.schedule();
  };
  const liveVersion = (entry) =>
    entry === undefined || entry.value === null ? null : entry.version;
  /** Folds the oldest tombstones past MAX_TOMBSTONES into the floor. */
  const compact = (scope) => {
    const entries = inScope(scope);
    const dead = entries.filter((e) => e.value === null && e.key !== FLOOR_KEY);
    if (dead.length <= MAX_TOMBSTONES) return;
    const dropped = new Set(dead.slice(0, dead.length - MAX_TOMBSTONES));
    const floor = entries.find((e) => e.key === FLOOR_KEY);
    const versions = [...dropped].map((e) => e.version);
    const version = Math.max(floor?.version ?? 0, ...versions);
    removeWhere(state.storage, (e) => dropped.has(e));
    put(floor, { scope, key: FLOOR_KEY, value: null, version });
  };
  const full = (scope) =>
    inScope(scope).filter((e) => e.value !== null).length >= MAX_LIVE_KEYS;
  return {
    getAppStorage(scope, key) {
      const entry = entryOf(scope, key);
      const version = liveVersion(entry);
      return version === null ? null : { value: entry.value, version };
    },
    setAppStorage(scope, key, value, previousVersion = null) {
      const entry = entryOf(scope, key);
      if (typeof value !== "string") throw new TypeError("value must be text");
      if (previousVersion !== null) requireCount(previousVersion, "version", 0);
      const current = liveVersion(entry);
      if (previousVersion !== null && previousVersion !== current) {
        return { success: false, version: current, reason: "version_conflict" };
      }
      if (current === null && full(scope)) {
        return failure("storage_full", {
          message: `App storage holds at most ${MAX_LIVE_KEYS} keys per segment`,
        });
      }
      const base = entry?.version ?? entryOf(scope, FLOOR_KEY)?.version ?? 0;
      const version = base + 1;
      put(entry, { scope, key, value, version });
      return { success: true, version };
    },
    deleteAppStorage(scope, key) {
      const entry = entryOf(scope, key);
      if (liveVersion(entry) !== null) {
        put(entry, { ...entry, value: null });
        compact(scope);
      }
      return { success: true, version: null };
    },
  };
}
