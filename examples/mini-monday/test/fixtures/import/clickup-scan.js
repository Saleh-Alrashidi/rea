/**
 * Shared helpers of the ClickUp connector tests: a fake clock (starting
 * at the fixture's T0, so `X-RateLimit-Reset` epoch seconds make sense),
 * a scan against a fresh fake server (`setup`), one shared full default
 * scan (`fullScan`, validated with `validateSnapshot`) and lookups.
 */
import { after } from "node:test";
import { scan } from "../../../server/import/connectors/clickup.js";
import { validateSnapshot } from "../../../server/import/snapshot.js";
import { T0 } from "./clickup-data.js";
import { startClickUpServer } from "./clickup-server.js";

export function fakeClock(start = T0) {
  const clock = { time: start, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.time += ms;
  };
  return clock;
}

/**
 * A fresh fake server (closed after `t`; `data` replaces the fixture)
 * and `run(extra)` scanning it with a fake clock.
 */
export async function setup(t, { data } = {}) {
  const clock = fakeClock();
  const server = await startClickUpServer({ data, now: clock.now });
  t.after(() => server.close());
  const run = (extra = {}) =>
    scan({
      token: extra.token ?? server.token,
      options: extra.options,
      signal: extra.signal,
      onProgress: extra.onProgress,
      transport: {
        env: { MM_IMPORT_CLICKUP_URL: server.endpoint },
        clock,
        limits: extra.limits,
      },
    });
  return { server, run, clock };
}

let shared = null;
/** One full default scan per test file: `{ server, snapshot, valid, progress, clock }`. */
export function fullScan() {
  shared ??= (async () => {
    const clock = fakeClock();
    const server = await startClickUpServer({ now: clock.now });
    after(() => server.close());
    const progress = [];
    const snapshot = await scan({
      token: server.token,
      onProgress: (event) => progress.push(event),
      transport: { env: { MM_IMPORT_CLICKUP_URL: server.endpoint }, clock },
    });
    const valid = validateSnapshot(snapshot);
    return { server, snapshot, valid, progress, clock };
  })();
  return shared;
}

export const boards = (snapshot) =>
  snapshot.workspaces.flatMap((ws) => ws.boards);
export const boardNamed = (snapshot, name) =>
  boards(snapshot).find((board) => board.name === name);
export const itemOf = (board, id) =>
  board.items.find((item) => item.source_id === id);
export const columnNamed = (board, title) =>
  board.columns.find((column) => column.title === title);
export const docs = (snapshot) => snapshot.workspaces.flatMap((ws) => ws.docs);
export const codes = (snapshot, code) =>
  snapshot.warnings.filter((warning) => warning.code === code);
export const routed = (server, route) =>
  server.requests.filter((request) => request.route === route);
