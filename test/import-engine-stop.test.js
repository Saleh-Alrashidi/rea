/**
 * Import runs that stop, select or repeat (SPEC-4 §4): cancellation
 * between boards, an importer who loses `import_data`, selection and
 * existing target workspaces, invites of existing emails and re-imports
 * as "(imported again)" copies.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { preview, run } from "../server/import/engine.js";
import { finishedText } from "../server/import/report.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";

const kinds = (report) =>
  report.skipped.map((s) => [s.kind, s.source_id, s.reason]);

test("cancelling stops between boards; what was created stays and is reported", async () => {
  const { store, ids } = await seededStore();
  const controller = new AbortController();
  const progress = [];
  const onProgress = (entry) => {
    progress.push(entry);
    // Cancel while the second board is about to start.
    if (entry.done === 1) controller.abort();
  };
  const options = { store, importerId: ids.users.alex, onProgress };
  const report = await run(
    sampleSnapshot(),
    {},
    { ...options, signal: controller.signal },
  );
  assert.equal(report.cancelled, true);
  assert.equal(report.created.boards, 2, "the board that had started finishes");
  assert.deepEqual(
    report.links.map((l) => l.title),
    ["Acme main", "Roadmap", "Hiring"],
  );
  assert.deepEqual(kinds(report).slice(-2), [
    ["doc", "d-1", "cancelled"],
    ["board", "b-old", "cancelled"],
  ]);
  assert.ok(store.getBoard(report.links[1].id), "created boards stay");
  assert.equal(
    store.listWorkspaces().filter((w) => w.name === "Archive").length,
    0,
    "a workspace whose content was not reached is not created",
  );
  const [last] = store.listNotifications(ids.users.alex, { limit: 1 });
  assert.equal(
    last.text,
    "Import from monday.com was stopped after 2 boards, 4 items and 0 docs",
  );
  assert.deepEqual(progress.at(-1), {
    phase: "done",
    done: 4,
    total: 4,
    message: last.text,
  });
});

test("a run cancelled before it starts creates nothing, not even invited users", async () => {
  const { store, ids, events } = await seededStore();
  const controller = new AbortController();
  controller.abort();
  const plan = { users: { "u-new": "invite:member" } };
  const options = {
    store,
    importerId: ids.users.alex,
    signal: controller.signal,
  };
  const report = await run(sampleSnapshot(), plan, options);
  assert.deepEqual(report.created.users, 0);
  assert.equal(store.findUserByEmail("nia@acme.test"), null);
  assert.equal(report.created.boards, 0);
  assert.deepEqual(
    events.map((e) => e.type),
    ["notification_created"],
  );
});

test("an importer who loses import_data midway stops the run", async () => {
  const { store, ids } = await seededStore();
  store.updateUser(ids.users.sam, { role: "admin" });
  const onProgress = (entry) => {
    if (entry.done === 1) store.updateUser(ids.users.sam, { role: "member" });
  };
  const options = { store, importerId: ids.users.sam, onProgress };
  const report = await run(sampleSnapshot(), {}, options);
  assert.equal(report.cancelled, true);
  assert.equal(report.created.boards, 2);
  assert.deepEqual(kinds(report).slice(-2), [
    ["doc", "d-1", "not_allowed"],
    ["board", "b-old", "not_allowed"],
  ]);
});

test("selection and existing targets decide what is created where", async () => {
  const { store, ids } = await seededStore();
  const plan = {
    workspace_map: { "w-main": ids.workspaces.leadership },
    include: { boards: ["b-hiring"], docs: [] },
  };
  const report = await run(sampleSnapshot(), plan, {
    store,
    importerId: ids.users.alex,
  });
  assert.deepEqual(report.created.workspaces, 0);
  assert.deepEqual(
    report.links.map((l) => [l.kind, l.title]),
    [["board", "Hiring"]],
  );
  assert.equal(
    store.getBoard(report.links[0].id).workspace_id,
    ids.workspaces.leadership,
  );
  assert.deepEqual(
    kinds(report).filter(([kind]) => kind !== "user"),
    [
      ["board", "b-roadmap", "excluded"],
      ["doc", "d-1", "excluded"],
      ["board", "b-old", "excluded"],
    ],
  );
  assert.equal(
    store.listWorkspaces().length,
    2,
    "no empty workspace is created",
  );
});

test("inviting an email that exists matches it; invites use the chosen role", async () => {
  const { store, ids } = await seededStore();
  const snapshot = sampleSnapshot();
  snapshot.users[4].email = "noa@example.test";
  snapshot.users.push({
    source_id: "u-guest",
    name: "Gus Guest",
    email: "gus@else.test",
  });
  snapshot.workspaces[0].boards[0].members.push(
    { user_source_id: "u-new", role: "editor" },
    { user_source_id: "u-guest", role: "editor" },
  );
  const plan = {
    users: {
      "u-new": "invite:viewer",
      "u-guest": "invite:guest",
      "u-sam": "skip",
    },
  };
  const report = await run(snapshot, plan, {
    store,
    importerId: ids.users.alex,
  });
  assert.equal(report.created.users, 1);
  const gus = store.findUserByEmail("gus@else.test");
  assert.deepEqual(
    [gus.name, gus.role, gus.status],
    ["Gus Guest", "guest", "active"],
  );
  assert.equal(
    store.getUser(ids.users.noa).role,
    "member",
    "Noa keeps her role",
  );
  const [matched] = report.warnings.filter((w) => w.code === "invite_matched");
  assert.equal(matched.path, "users[4]");
  const roadmap = store.getBoard(
    report.links.find((l) => l.title === "Roadmap").id,
  );
  const roles = Object.fromEntries(roadmap.members.map((m) => [m.id, m.role]));
  assert.equal(roles[ids.users.noa], "editor");
  assert.equal(roles[gus.id], "editor", "guests may join Shareable boards");
  assert.equal(roles[ids.users.sam], undefined, "skipped users get nothing");
});

test("importing a board again makes a new copy and the preview says so", async () => {
  const { store, ids } = await seededStore();
  const options = { store, importerId: ids.users.alex };
  const plan = { include: { boards: ["b-roadmap"], docs: [] } };
  const first = await run(sampleSnapshot(), plan, options);
  const original = store.getBoard(first.links[1].id);
  const again = preview(sampleSnapshot(), options).workspaces[0].boards;
  assert.deepEqual(again[0].reimport, {
    board_id: original.id,
    name: "Roadmap",
    imported_at: original.import.imported_at,
  });
  assert.equal(again[0].import_name, "Roadmap (imported again)");
  assert.equal(again[1].reimport, null, "Hiring was never imported");
  const snapshot = sampleSnapshot();
  snapshot.workspaces[0].boards[0].name = "R".repeat(255);
  const second = await run(snapshot, plan, options);
  const copy = store.getBoard(second.links[1].id);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name.length, 255);
  assert.ok(copy.name.endsWith("R (imported again)"));
  assert.equal(
    store.getBoard(original.id).name,
    "Roadmap",
    "nothing is merged",
  );
  assert.equal(store.countItems(original.id), 3);
  assert.equal(store.countItems(copy.id), 3);
  assert.deepEqual(
    store.listImportedBoards("monday", "b-roadmap").map((b) => b.id),
    [original.id, copy.id],
  );
});

test("the finished notification groups thousands like the done step", () => {
  const report = {
    created: { boards: 46, items: 11_500, docs: 0 },
    cancelled: true,
  };
  assert.equal(
    finishedText(report, "Import from monday.com"),
    "Import from monday.com was stopped after 46 boards, 11,500 items and 0 docs",
  );
});
