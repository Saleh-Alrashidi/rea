/**
 * App storage (part 1). A deleted key keeps a tombstone (`value: null`)
 * with its last version, so a key written again never reuses a version
 * number and stale `previousVersion` values keep conflicting. Storage
 * writes are not board changes and emit no change event.
 */
import { SCOPE_KEY, push, replace, requireCount } from "../store-state.js";

export function storageApi(ctx) {
  const { state } = ctx;
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
      const version = (entry?.version ?? 0) + 1;
      put(entry, { scope, key, value, version });
      return { success: true, version };
    },
    deleteAppStorage(scope, key) {
      const entry = entryOf(scope, key);
      if (liveVersion(entry) !== null) put(entry, { ...entry, value: null });
      return { success: true, version: null };
    },
  };
}
