/**
 * Debounced autosave with optimistic versions, shared by the doc editor
 * and the note editor (no DOM). Edits arrive as patches (`{ title }`,
 * `{ blocks }`, `{ color }` …); later patches override earlier ones until
 * they are saved. One save runs at a time and sends the last known
 * version as `expected_version`, so a write based on stale content is
 * rejected by the server instead of overwriting someone else's changes.
 *
 * Status (`onState(snapshot)`):
 *
 * | status     | meaning                                                      |
 * | ---------- | ------------------------------------------------------------ |
 * | `saved`    | nothing waits to be saved                                    |
 * | `pending`  | edits wait for the debounce (default 800 ms)                 |
 * | `saving`   | a save is in flight (newer edits wait for it)                |
 * | `failed`   | the last save failed; edits are kept and the next `change()` |
 * |            | or `retry()` tries again (`snapshot.error` says why)         |
 * | `conflict` | the server has a newer version (`VERSION_CONFLICT`); nothing |
 * |            | is saved until `rebase()` after the caller reloads           |
 *
 * ```js
 * const autosave = createAutosave({
 *   version: doc.version,
 *   save: (changes, expectedVersion) => updateDoc(id, changes, expectedVersion),
 *   onState: (snapshot) => status.update(snapshot),
 * });
 * autosave.change({ title: "Q3 plan" });     // saved after 800 ms of quiet
 * autosave.change({ pinned: true }, { immediate: true });
 * await autosave.flush();                    // before leaving the page
 * ```
 */

export const AUTOSAVE_DELAY = 800;

const defaultTimers = Object.freeze({
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: (id) => globalThis.clearTimeout(id),
});

/** True for the API's version-conflict failure. */
export function isVersionConflict(error) {
  return error?.code === "VERSION_CONFLICT";
}

/** A save machine: the record's save state plus its timer and save in flight. */
function machine(options) {
  return {
    options,
    delay: options.delay ?? AUTOSAVE_DELAY,
    timers: options.timers ?? defaultTimers,
    status: "saved",
    version: options.version,
    pending: null,
    error: null,
    serverVersion: null,
    timer: null,
    inflight: null,
    disposed: false,
  };
}

function snapshotOf(m) {
  return {
    status: m.status,
    version: m.version,
    error: m.error,
    serverVersion: m.serverVersion,
    unsaved: m.pending !== null || m.inflight !== null,
    pending: m.pending ? { ...m.pending } : null,
  };
}

function emit(m) {
  if (!m.disposed) m.options.onState?.(snapshotOf(m));
}

function cancel(m) {
  if (m.timer === null) return;
  m.timers.clear(m.timer);
  m.timer = null;
}

function schedule(m, wait) {
  cancel(m);
  m.timer = m.timers.set(() => {
    m.timer = null;
    run(m);
  }, wait);
}

function succeeded(m, result, changes) {
  if (Number.isSafeInteger(result?.version)) m.version = result.version;
  m.error = null;
  m.status = m.pending ? "pending" : "saved";
  m.options.onSaved?.(result, changes);
}

function failed(m, error, changes) {
  // Keep the unsaved edits; anything typed meanwhile wins.
  m.pending = { ...changes, ...m.pending };
  m.error = error;
  if (!isVersionConflict(error)) {
    m.status = "failed";
    return;
  }
  m.status = "conflict";
  m.serverVersion = Number.isSafeInteger(error.version) ? error.version : null;
  cancel(m);
}

async function attempt(m, changes) {
  try {
    succeeded(m, await m.options.save(changes, m.version), changes);
  } catch (error) {
    failed(m, error, changes);
  }
}

async function run(m) {
  cancel(m);
  if (m.inflight || m.disposed || !m.pending || m.status === "conflict") return;
  const changes = m.pending;
  m.pending = null;
  m.status = "saving";
  emit(m);
  m.inflight = attempt(m, changes);
  await m.inflight;
  m.inflight = null;
  emit(m);
  // Edits made during the save whose debounce already ran go out now.
  if (m.status === "pending" && m.timer === null) await run(m);
}

function change(m, patch, immediate) {
  if (m.disposed) return;
  m.pending = { ...m.pending, ...patch };
  if (m.status === "conflict") {
    emit(m);
    return;
  }
  if (m.status !== "saving") m.status = "pending";
  emit(m);
  if (!immediate) schedule(m, m.delay);
  else if (m.inflight) cancel(m);
  else run(m);
}

async function flush(m) {
  cancel(m);
  let attempts = 0;
  while (!m.disposed) {
    if (m.inflight) {
      // The save's own continuation (and any follow-up save) runs first.
      await m.inflight;
      continue;
    }
    if (!m.pending || m.status === "conflict") break;
    if (m.status === "failed" && attempts > 0) break;
    attempts += 1;
    await run(m);
  }
  return snapshotOf(m);
}

/**
 * @param {{ version: number,
 *   save: (changes: object, expectedVersion: number) => Promise<{ version: number }>,
 *   delay?: number, timers?: { set: Function, clear: Function },
 *   onState?: (snapshot: object) => void,
 *   onSaved?: (result: object, changes: object) => void }} options
 */
export function createAutosave(options) {
  const m = machine(options);
  return {
    /** Queues `patch`; `immediate` skips the debounce (pin, color). */
    change: (patch, { immediate = false } = {}) => change(m, patch, immediate),
    /**
     * Saves pending edits now and waits until nothing is in flight.
     * Resolves with the final snapshot (also after a failure or conflict).
     */
    flush: () => flush(m),
    /** Tries a failed save again at once. */
    retry() {
      if (m.status === "failed") run(m);
    },
    /**
     * Starts over from `version` after the caller loaded a newer record:
     * unsaved edits are dropped and saving resumes.
     */
    rebase(version) {
      cancel(m);
      Object.assign(m, {
        pending: null,
        version,
        status: "saved",
        error: null,
        serverVersion: null,
      });
      emit(m);
    },
    snapshot: () => snapshotOf(m),
    /** Stops timers and callbacks (call `flush()` first to keep edits). */
    dispose() {
      cancel(m);
      m.disposed = true;
    },
  };
}
