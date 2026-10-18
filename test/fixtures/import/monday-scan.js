/**
 * Shared helpers of the monday.com connector tests: a fake clock, a scan
 * against a fresh fake server (`setup`), one shared full default scan
 * (`fullScan`, validated with `validateSnapshot`) and snapshot lookups.
 */
import { after } from "node:test";
import { scan } from "../../../server/import/connectors/monday.js";
import { validateSnapshot } from "../../../server/import/snapshot.js";
import { startMondayServer } from "./monday-server.js";

export function fakeClock() {
  const clock = { time: 0, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.time += ms;
  };
  return clock;
}

/**
 * A fresh fake server (closed after `t`, started with `serverOptions`) and
 * `run(extra)` scanning it.
 */
export async function setup(t, serverOptions = {}) {
  const server = await startMondayServer(serverOptions);
  t.after(() => server.close());
  const run = (extra = {}) =>
    scan({
      token: server.token,
      options: extra.options,
      signal: extra.signal,
      onProgress: extra.onProgress,
      transport: {
        env: { MM_IMPORT_MONDAY_URL: server.endpoint },
        clock: extra.clock ?? fakeClock(),
        limits: extra.limits,
      },
    });
  return { server, run };
}

let shared = null;
/** One full default scan per test file: `{ server, snapshot, valid, progress }`. */
export function fullScan() {
  shared ??= (async () => {
    const server = await startMondayServer();
    after(() => server.close());
    const progress = [];
    const snapshot = await scan({
      token: server.token,
      onProgress: (event) => progress.push(event),
      transport: { env: { MM_IMPORT_MONDAY_URL: server.endpoint } },
    });
    const valid = validateSnapshot(snapshot);
    return { server, snapshot, valid, progress };
  })();
  return shared;
}

export const boards = (snapshot) =>
  snapshot.workspaces.flatMap((ws) => ws.boards);
export const boardNamed = (snapshot, name) =>
  boards(snapshot).find((board) => board.name === name);
export const itemOf = (board, id) =>
  board.items.find((item) => item.source_id === id);
export const codes = (snapshot, code) =>
  snapshot.warnings.filter((warning) => warning.code === code);
export const operations = (server) =>
  server.requests.map((r) => r.operationName);
