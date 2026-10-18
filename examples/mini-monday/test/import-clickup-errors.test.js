/**
 * The ClickUp connector's failure paths and controls (SPEC-4 §1, §3.2)
 * against the fake ClickUp REST API: 429 retries, the 90-per-minute
 * request rate, rejected tokens and redaction, per-list failures,
 * consecutive failures, best-effort docs, scan limits, options, progress
 * and cancellation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLICKUP_PER_MINUTE } from "../server/import/connectors/clickup.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import { clickupFixture } from "./fixtures/import/clickup-data.js";
import {
  boardNamed,
  boards,
  codes,
  docs,
  fullScan,
  itemOf,
  routed,
  setup,
} from "./fixtures/import/clickup-scan.js";

const SPRINT = "Engineering / Sprint 12";
const failure = (promise) =>
  promise.then(
    () => assert.fail("expected the scan to fail"),
    (error) => error,
  );

test("429 answers wait for X-RateLimit-Reset or Retry-After, then retry", async (t) => {
  const { server, run, clock } = await setup(t);
  server.fail({ route: "teams", kind: "rate_limit", seconds: 3 });
  server.fail({
    route: "tasks",
    match: { list: "901101", page: "1" },
    kind: "retry_after",
    seconds: 5,
  });
  const snapshot = await run();
  assert.equal(clock.sleeps[0], 3000, "X-RateLimit-Reset is epoch seconds");
  assert.ok(clock.sleeps.includes(5000), "Retry-After is seconds");
  assert.equal(boardNamed(snapshot, SPRINT).items.length, 230);
  assert.deepEqual(codes(snapshot, "read_failed"), []);
  assert.equal(routed(server, "teams").length, 2);
});

test("requests stay under 90 per minute", async () => {
  const { server, clock } = await fullScan();
  const times = server.requests.map((request) => request.at);
  assert.ok(times.length > 3 * CLICKUP_PER_MINUTE, `${times.length} requests`);
  let most = 0;
  for (const [index, time] of times.entries()) {
    const inWindow = times
      .slice(0, index + 1)
      .filter((at) => at > time - 60_000);
    most = Math.max(most, inWindow.length);
  }
  assert.equal(CLICKUP_PER_MINUTE, 90);
  assert.equal(
    most,
    CLICKUP_PER_MINUTE,
    "the window fills but never overflows",
  );
  assert.ok(
    clock.sleeps.length >= 3 && clock.sleeps.every((ms) => ms <= 60_000),
  );
});

test("rejected tokens fail the scan; the token never leaks", async (t) => {
  const { server, run } = await setup(t);
  const leaks = (value) => JSON.stringify(value).includes(server.token);
  const rejected = async (promise, code) => {
    const error = await failure(promise);
    assert.equal(error.code, code, error.message);
    assert.ok(!error.message.includes(server.token));
    assert.ok(!error.stack.includes(server.token) && !leaks(error));
    return error;
  };
  const wrong = await rejected(
    run({ token: "pk_wrong_token" }),
    "INVALID_TOKEN",
  );
  assert.equal(wrong.status, 401);
  await rejected(run({ token: "" }), "INVALID_TOKEN");
  server.fail({ route: "tasks", match: { page: "2" }, kind: "unauthorized" });
  await rejected(run(), "INVALID_TOKEN");
  server.fail({
    route: "fields",
    match: { list: "901101" },
    kind: "echo_token",
  });
  const progress = [];
  const snapshot = await run({ onProgress: (event) => progress.push(event) });
  const [echoed] = codes(snapshot, "read_failed");
  assert.match(echoed.message, /HTTP 400: Bad request for \[redacted\]/);
  assert.ok(!leaks(snapshot) && !leaks(progress));
  assert.equal(
    boardNamed(snapshot, SPRINT).items.length,
    230,
    "tasks still read",
  );
});

test("a failing list, page or comment read becomes a warning", async (t) => {
  const { server, run } = await setup(t);
  server.fail({ route: "list", match: { list: "901102" }, kind: "not_found" });
  const page = { route: "tasks", match: { list: "901101", page: "1" } };
  server.fail({ ...page, kind: "server_error", times: 5 });
  server.fail({
    route: "fields",
    match: { list: "901103" },
    kind: "slow",
    ms: 1500,
  });
  server.fail({
    route: "comments",
    match: { task: "86d0004" },
    kind: "oversized",
  });
  server.fail({
    route: "space_lists",
    match: { space: "90010002" },
    kind: "html",
  });
  server.fail({ route: "replies", kind: "redirect" });
  const snapshot = await run({ limits: { timeoutMs: 300 } });
  const messages = codes(snapshot, "read_failed").map((w) => [
    w.path,
    w.message,
  ]);
  assert.deepEqual(messages, [
    [
      "workspaces",
      'Folderless lists of "Acme Corp / Leadership" could not be read: ClickUp sent a response that is not JSON',
    ],
    [
      "workspaces[0].boards[0]",
      'Replies to a comment on task "Plan the sprint" could not be read: ClickUp answered with a redirect (HTTP 302), which is not followed',
    ],
    [
      "workspaces[0].boards[0]",
      'Tasks of list "Engineering / Sprint 12" could not be read: ClickUp answered HTTP 500 after 5 attempts: Internal server error',
    ],
    [
      "workspaces[0].boards[1]",
      'The list "Engineering / Backlog" could not be read: ClickUp answered HTTP 404: List not found',
    ],
    [
      "workspaces[0].boards[2]",
      'Custom fields of list "Secret projects / Plans" could not be read: ClickUp did not answer within 0.3 s',
    ],
    [
      "workspaces[0].boards[3]",
      'Comments of task "Triage" could not be read: ClickUp sent a response larger than 10 MiB',
    ],
  ]);
  assert.equal(
    boardNamed(snapshot, SPRINT).items.length,
    100,
    "page 0 is kept",
  );
  assert.equal(
    itemOf(boardNamed(snapshot, SPRINT), "86c0001").updates.length,
    30,
  );
  assert.deepEqual(boardNamed(snapshot, "Engineering / Backlog").items, []);
  assert.equal(boardNamed(snapshot, "Secret projects / Plans").items.length, 1);
  assert.deepEqual(
    itemOf(boardNamed(snapshot, "Inbox"), "86d0004").updates,
    [],
  );
  assert.deepEqual(snapshot.workspaces[1].boards, []);
  assert.ok(validateSnapshot(snapshot).ok);
});

test("three failed requests in a row stop the scan", async (t) => {
  const { server, run } = await setup(t);
  server.fail({ route: "list", kind: "not_found", times: 3 });
  const error = await failure(run());
  assert.equal(error.code, "UPSTREAM_HTTP");
  assert.equal(error.status, 404);
  assert.equal(routed(server, "list").length, 3);
});

test("an answer without workspaces fails the scan", async (t) => {
  const { server, run } = await setup(t);
  server.fail({ route: "teams", kind: "empty" });
  assert.equal((await failure(run())).code, "UPSTREAM_ERROR");
  server.fail({ route: "teams", kind: "html" });
  assert.equal((await failure(run())).code, "UPSTREAM_BAD_JSON");
});

test("docs failures are warnings only", async (t) => {
  const { server, run } = await setup(t);
  server.fail({ route: "docs", match: { team: "9001" }, kind: "unauthorized" });
  const denied = await run();
  assert.deepEqual(docs(denied), []);
  assert.match(
    codes(denied, "read_failed")[0].message,
    /^Docs of "Acme Corp" could not be read: ClickUp rejected the API token \(HTTP 401\)$/,
  );
  assert.equal(
    routed(server, "docs").filter((r) => r.params.team === "9002").length,
    1,
  );
  assert.ok(validateSnapshot(denied).ok);
  const before = routed(server, "pages").length;
  server.fail({ route: "pages", kind: "not_found", times: 3 });
  const broken = await run();
  assert.equal(routed(server, "pages").length - before, 3, "then docs stop");
  assert.deepEqual(
    codes(broken, "read_failed").map((w) => w.message.split(" could not")[0]),
    [
      'Pages of doc "Engineering handbook"',
      'Pages of doc "Secret plan"',
      'Pages of doc "Hiring rubric"',
      "Docs were not read further after 3 failed requests in a row",
    ],
  );
  assert.deepEqual(
    docs(broken).map((d) => [d.title, d.blocks.length]),
    [
      ["Engineering handbook", 0],
      ["Secret plan", 0],
      ["Hiring rubric", 0],
    ],
  );
});

test("scan limits stop reading with warnings", async (t) => {
  const { server, run } = await setup(t);
  const limits = { boards: 2, items: 150, updates: 10, docs: 5 };
  const snapshot = await run({ options: { limits } });
  assert.deepEqual(
    boards(snapshot).map((b) => [b.name, b.items.length]),
    [[SPRINT, 150]],
    "two lists are listed; the item limit ends the scan in the first",
  );
  assert.equal(routed(server, "folder_lists").length, 2, "then listing stops");
  assert.deepEqual(routed(server, "space_lists"), []);
  assert.equal(routed(server, "folders").length, 1);
  assert.deepEqual(
    routed(server, "list").map((r) => r.params.list),
    ["901101"],
  );
  const updates = boards(snapshot).flatMap((b) =>
    b.items.flatMap((i) => i.updates),
  );
  assert.equal(updates.length, 10);
  assert.equal(
    updates.at(-1).body,
    "Comment 30",
    "the latest comments are kept",
  );
  assert.equal(
    routed(server, "comments").length,
    2,
    "then comments are not read",
  );
  assert.equal(docs(snapshot).length, 5);
  assert.equal(routed(server, "docs").length, 1, "no team reads docs after");
  for (const code of [
    "limit_boards",
    "limit_items",
    "limit_updates",
    "limit_docs",
  ]) {
    assert.equal(codes(snapshot, code).length, 1, code);
  }
  assert.match(codes(snapshot, "limit_items")[0].message, /limit of 150 items/);
  assert.equal(routed(server, "tasks").length, 2);
  assert.ok(validateSnapshot(snapshot).ok);
});

test("comment requests count against the update limit", async (t) => {
  const data = clickupFixture();
  delete data.comments["86c0001"];
  const { server, run } = await setup(t, { data });
  const snapshot = await run({ options: { limits: { updates: 3 } } });
  assert.equal(routed(server, "comments").length, 3);
  const [warning] = codes(snapshot, "limit_updates");
  assert.match(warning.message, /^Stopped reading comments after 3 requests/);
  assert.equal(warning.path, "workspaces[0].boards[0]");
  const updates = boards(snapshot).flatMap((b) =>
    b.items.flatMap((i) => i.updates),
  );
  assert.deepEqual(
    updates.map((u) => u.body),
    ["Status changed by automation"],
  );
});

test("options leave out comments, subtasks and docs", async (t) => {
  const { server, run } = await setup(t);
  const options = {
    include_comments: false,
    include_subitems: false,
    include_docs: false,
  };
  const snapshot = await run({ options });
  const sprint = boardNamed(snapshot, SPRINT);
  assert.equal(sprint.items.length, 228, "the two subtasks are left out");
  assert.ok(
    sprint.items.every(
      (i) => i.updates.length === 0 && i.parent_source_id === null,
    ),
  );
  assert.ok(routed(server, "tasks").every((r) => r.query.subtasks === "false"));
  for (const route of ["comments", "replies", "docs", "pages"]) {
    assert.deepEqual(routed(server, route), [], route);
  }
  assert.ok(
    !snapshot.workspaces.some((ws) => ws.source_id.startsWith("team-")),
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
  assert.deepEqual(
    reading.map((event) => [event.done, event.total]),
    [0, 1, 2, 3, 4, 5].map((done) => [done, 6]),
  );
  assert.equal(reading[0].message, `Reading list "${SPRINT}"`);
  assert.deepEqual(progress.at(-1), {
    phase: "done",
    done: 6,
    total: 6,
    message: "Scan finished",
  });
  const { server, run } = await setup(t);
  const controller = new AbortController();
  const onProgress = (event) =>
    event.phase === "items" && event.done === 1 && controller.abort();
  const error = await failure(run({ signal: controller.signal, onProgress }));
  assert.equal(error.code, "ABORTED");
  assert.ok(!routed(server, "list").some((r) => r.params.list === "901102"));
  assert.deepEqual(routed(server, "docs"), []);
  const late = new AbortController();
  const atDocs = (event) => event.phase === "docs" && late.abort();
  const options = { include_comments: false };
  const stopped = run({ signal: late.signal, onProgress: atDocs, options });
  assert.equal(
    (await failure(stopped)).code,
    "ABORTED",
    "docs do not swallow it",
  );
});
