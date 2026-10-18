/**
 * The monday.com connector's failure paths and controls (SPEC-4 §1, §3.1)
 * against the fake monday GraphQL API: complexity and rate-limit retries,
 * rejected tokens and redaction, per-board failures (GraphQL errors,
 * timeouts, oversized answers), consecutive failures, scan limits,
 * options, progress and cancellation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "../server/import/connectors/monday.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import {
  boardNamed,
  boards,
  codes,
  fakeClock,
  fullScan,
  operations,
  setup,
} from "./fixtures/import/monday-scan.js";
import { mondayFixture } from "./fixtures/import/monday-data.js";
import { startMondayServer } from "./fixtures/import/monday-server.js";

test("complexity and rate-limit errors wait and retry", async (t) => {
  const { server, run } = await setup(t);
  server.fail({ operation: "WorklaneUsers", kind: "budget", seconds: 4 });
  server.fail({
    operation: "WorklaneItems",
    match: { board: "101" },
    kind: "complexity",
    seconds: 2,
  });
  server.fail({
    operation: "WorklaneNextItems",
    kind: "complexity_legacy",
    seconds: 3,
  });
  server.fail({ operation: "WorklaneDocs", kind: "rate_limit", seconds: 5 });
  const clock = fakeClock();
  const snapshot = await run({ clock });
  assert.deepEqual(clock.sleeps, [4000, 2000, 3000, 5000]);
  assert.equal(boardNamed(snapshot, "Roadmap").items.length, 455);
  assert.equal(snapshot.users.length, 120);
  assert.equal(codes(snapshot, "read_failed").length, 0);
});

test("rejected tokens fail the scan; the token never leaks", async (t) => {
  const { server, run } = await setup(t);
  const leaks = (value) => JSON.stringify(value).includes(server.token);
  const failure = async (promise, code) => {
    const error = await promise.then(
      () => assert.fail("expected failure"),
      (e) => e,
    );
    assert.equal(error.code, code, error.message);
    assert.ok(
      !error.message.includes(server.token) &&
        !error.stack.includes(server.token),
    );
    assert.ok(!leaks(error));
  };
  const env = { MM_IMPORT_MONDAY_URL: server.endpoint };
  await failure(
    scan({ token: "wrong-token", transport: { env } }),
    "INVALID_TOKEN",
  );
  await failure(scan({ transport: { env } }), "INVALID_TOKEN");
  server.fail({ operation: "WorklaneAccount", kind: "forbidden" });
  await failure(run(), "INVALID_TOKEN");
  server.fail({ operation: "WorklaneItems", kind: "unauthorized" });
  await failure(run(), "INVALID_TOKEN");
  server.fail({ operation: "WorklaneAccount", kind: "graphql_error" });
  await failure(run(), "UPSTREAM_ERROR");
  const progress = [];
  const snapshot = await run({ onProgress: (event) => progress.push(event) });
  assert.ok(!leaks(snapshot) && !leaks(progress));
});

test("huge boards stay within the snapshot's member, group and column limits", async (t) => {
  const data = mondayFixture();
  const big = data.boards.find((board) => board.id === "107");
  big.subscribers = Array.from({ length: 1001 }, (_, n) => ({
    id: `${n + 1}`,
  }));
  big.groups = Array.from({ length: 501 }, (_, n) => ({
    id: `g${n}`,
    title: `Group ${n}`,
    color: "#579bfc",
  }));
  const extra = Array.from({ length: 500 }, (_, n) => ({
    id: `extra${n}`,
    title: `Extra ${n}`,
    type: "text",
    settings_str: "{}",
  }));
  big.columns = [...big.columns, ...extra];
  const server = await startMondayServer({ data });
  t.after(() => server.close());
  const env = { MM_IMPORT_MONDAY_URL: server.endpoint };
  const snapshot = await scan({ token: server.token, transport: { env } });
  const board = boardNamed(snapshot, "Broken board");
  assert.equal(board.members.length, 1000);
  assert.equal(board.groups.length, 500);
  assert.equal(board.columns.length, 500);
  assert.deepEqual(board.items[0].values, { text: "hello" });
  for (const code of ["members_capped", "groups_capped", "columns_capped"]) {
    const [warning] = codes(snapshot, code);
    assert.match(warning.message, /: 1$/, code);
  }
  assert.ok(validateSnapshot(snapshot).ok);
});

test("a failing board becomes a warning and the scan goes on", async (t) => {
  const { server, run } = await setup(t);
  const items = { operation: "WorklaneItems" };
  server.fail({
    ...items,
    match: { board: "107" },
    kind: "graphql_error",
    message: "Board is locked",
  });
  server.fail({ ...items, match: { board: "108" }, kind: "slow", ms: 6000 });
  server.fail({ ...items, match: { board: "200" }, kind: "oversized" });
  // Ample for every other answer, even on a loaded machine.
  const snapshot = await run({ limits: { timeoutMs: 1200 } });
  const failed = codes(snapshot, "read_failed");
  const message = (name) =>
    failed.find((w) => w.message.includes(`"${name}"`))?.message;
  assert.match(
    message("Broken board"),
    /could not be fully read: Board is locked/,
  );
  assert.match(message("Orphan board"), /did not answer within 1\.2 s/);
  assert.match(message("Team board 1"), /larger than 10 MiB/);
  for (const name of ["Broken board", "Orphan board", "Team board 1"]) {
    assert.deepEqual(boardNamed(snapshot, name).items, [], name);
  }
  assert.equal(boardNamed(snapshot, "Team board 2").items.length, 1);
  assert.ok(validateSnapshot(snapshot).ok);
});

test("three failed requests in a row stop the scan", async (t) => {
  const { server, run } = await setup(t);
  server.fail({ operation: "WorklaneItems", kind: "slow", ms: 1500, times: 3 });
  const error = await run({ limits: { timeoutMs: 100 } }).catch((e) => e);
  assert.equal(error.code, "UPSTREAM_TIMEOUT");
});

test("scan limits stop reading with warnings", async (t) => {
  const { server, run } = await setup(t);
  const limits = { boards: 3, items: 250, updates: 2, docs: 1 };
  const snapshot = await run({ options: { limits } });
  const names = boards(snapshot).map((board) => board.name);
  assert.deepEqual(names, ["Roadmap"], "item limit reached in the first board");
  assert.equal(boardNamed(snapshot, "Roadmap").items.length, 250);
  const updates = boards(snapshot).flatMap((b) =>
    b.items.flatMap((i) => i.updates),
  );
  assert.equal(updates.length, 2);
  for (const code of [
    "limit_boards",
    "limit_items",
    "limit_updates",
    "limit_docs",
  ]) {
    assert.equal(codes(snapshot, code).length, 1, code);
  }
  assert.match(codes(snapshot, "limit_items")[0].message, /limit of 250 items/);
  const [first, second] = server.requests.filter((r) =>
    r.operationName.endsWith("Items"),
  );
  assert.deepEqual(
    [first.variables.updates, second.variables.updates],
    [true, false],
  );
  assert.equal(second.variables.limit, 48);
  assert.equal(snapshot.workspaces.flatMap((ws) => ws.docs).length, 1);
});

test("options leave out updates, subitems and docs", async (t) => {
  const { server, run } = await setup(t);
  const options = {
    include_updates: false,
    include_subitems: false,
    include_docs: false,
  };
  const snapshot = await run({ options });
  const roadmap = boardNamed(snapshot, "Roadmap");
  assert.equal(roadmap.items.length, 453);
  assert.ok(
    roadmap.items.every(
      (i) => i.updates.length === 0 && i.parent_source_id === null,
    ),
  );
  assert.ok(!operations(server).some((op) => op.startsWith("WorklaneDoc")));
  const reads = server.requests.filter((r) =>
    r.operationName.endsWith("Items"),
  );
  assert.ok(
    reads.every(
      (r) => r.variables.updates === false && r.variables.subitems === false,
    ),
  );
  assert.deepEqual(server.errors, []);
});

test("progress reports each phase; aborting stops the scan", async (t) => {
  const { progress } = await fullScan();
  const phases = [...new Set(progress.map((event) => event.phase))];
  assert.deepEqual(phases, [
    "account",
    "users",
    "workspaces",
    "boards",
    "items",
    "docs",
    "done",
  ]);
  const reading = progress.filter((event) => event.phase === "items");
  assert.equal(reading.length, 29);
  assert.deepEqual([reading[0].done, reading[0].total], [0, 29]);
  assert.match(reading[0].message, /Reading board "Roadmap"/);
  const { server, run } = await setup(t);
  const controller = new AbortController();
  const onProgress = (event) => event.phase === "items" && controller.abort();
  const error = await run({ signal: controller.signal, onProgress }).catch(
    (e) => e,
  );
  assert.equal(error.code, "ABORTED");
  assert.ok(!operations(server).includes("WorklaneDocs"));
});
