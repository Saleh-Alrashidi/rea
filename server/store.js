/**
 * The mini-monday (Worklane) store: `createStore` wires the shared state,
 * change listeners and persistence to the domain modules in
 * `server/store/` (people, workspaces, boards, items, grants, docs, notes,
 * forms, activity, app storage and imports).
 *
 * Records returned by the store are frozen. Every mutator emits one change
 * event `{ type, board_id?, item_id?, group_id?, column_id?, user_ids?,
 * resource_kind?, resource_id? }`, followed by one `notification_created`
 * event per notified user (and, for `deleteTeam`, one `members_changed`
 * event per resource that lost the team's grant), and returns the new or
 * updated record (`importBoard` writes a whole board as one change with
 * one `board_imported` event, SPEC-4 §4). Unknown IDs return null and
 * emit nothing. Expected failures return
 * `{ ok: false, reason, message?, … }` (see `server/store-state.js`);
 * arguments of the wrong type throw a TypeError.
 *
 * The store does not decide who may do what: callers check access with
 * `server/access.js` first. It does keep the data rules that need the whole
 * state (unique emails, last owner and last admin, guest grants, versions).
 */
import path from "node:path";
import { createReader, guardApi } from "./store-state.js";
import { activityApi } from "./store/activity.js";
import { boardApi } from "./store/boards.js";
import { docApi } from "./store/docs.js";
import { formApi } from "./store/forms.js";
import { grantApi } from "./store/grants.js";
import { importApi } from "./store/imports.js";
import { itemApi } from "./store/items.js";
import { noteApi } from "./store/notes.js";
import { peopleApi } from "./store/people.js";
import {
  MAX_DATA_BYTES,
  createPersistence,
  emptyState,
  keepLegacyCopy,
  loadState,
  removeStaleTemps,
} from "./store/persistence.js";
import { seedState } from "./store/seed.js";
import { storageApi } from "./store/storage.js";
import { workspaceApi } from "./store/workspaces.js";

const DOMAINS = [
  peopleApi,
  workspaceApi,
  boardApi,
  itemApi,
  grantApi,
  docApi,
  noteApi,
  formApi,
  activityApi,
  storageApi,
  importApi,
];

/**
 * Creates the store. Removes temp files that interrupted saves of `file`
 * left, then loads `file` when it exists (an invalid file is an error and
 * is never overwritten; a version-2 file is upgraded, copied to
 * `<file>.v2.bak` and saved in the current format); otherwise seeds when
 * `seed` is true and saves the result. `file: null` (or `":memory:"`) keeps data in memory.
 * Writes are debounced (50 ms) and atomic; `flush()` awaits them. `now`
 * returns a Date; `log.error` receives background save and listener errors.
 * `maxDataBytes` (default and at most MAX_DATA_BYTES) bounds what imports
 * may grow the data to.
 */
export async function createStore({
  file = null,
  now = () => new Date(),
  seed = true,
  log = console,
  maxDataBytes = MAX_DATA_BYTES,
} = {}) {
  const memory = file === null || file === ":memory:";
  const target = memory ? null : path.resolve(file);
  if (target) await removeStaleTemps(target);
  const loaded = target ? await loadState(target) : null;
  if (loaded?.upgraded) await keepLegacyCopy(target);
  const state = loaded?.state ?? emptyState();
  const listeners = new Set();
  const ctx = {
    state,
    now: () => now().toISOString(),
    log,
    listeners,
    reader: createReader(state),
    pending: [],
    revision: 0,
    maxDataBytes: Math.min(maxDataBytes, MAX_DATA_BYTES),
  };
  if (!loaded && seed) seedState(ctx);
  const bytes = loaded ? loaded.bytes : 0;
  ctx.persist = createPersistence({ file: target, state, log, bytes });
  // New and upgraded state is saved right away (in the current format).
  if (!loaded || loaded.upgraded) ctx.persist.schedule();
  const on = (listener) => {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    const entry = { listener };
    listeners.add(entry);
    return () => void listeners.delete(entry);
  };
  const flush = () => ctx.persist.flush();
  // Grows with every committed change; readers cache derived views by it.
  const revision = () => ctx.revision;
  const api = Object.assign({}, ...DOMAINS.map((domain) => domain(ctx)));
  return Object.freeze({ ...guardApi(ctx, api), on, flush, revision });
}
