/**
 * The store side of imports (SPEC-4 §4, `server/store/imports.js`): one
 * all-or-nothing batch per board, grants and people values checked by the
 * access rules, the `import_finished` notification, and `Board.import`
 * surviving a save and a reload.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import { seededStore } from "./import-engine-fixtures.js";

/** A small valid `importBoard` spec into `workspaceId` by `importerId`. */
function spec({ workspaceId, importerId, members = [] }) {
  return {
    workspaceId,
    importerId,
    name: "Imported",
    description: null,
    boardKind: "private",
    meta: { source: "clickup", sourceId: "list-9", sourceUrl: null },
    label: "Import from ClickUp",
    summary: "Imported from ClickUp",
    members,
    groups: [{ key: "open", title: "Open", color: "#579BFC" }],
    columns: [
      {
        key: "s",
        title: "Status",
        type: "status",
        labels: [{ label: "to do", color: "#c4c4c4" }],
      },
      { key: "p", title: "Assignees", type: "people" },
    ],
    items: [
      {
        groupKey: "open",
        name: "Task",
        values: { s: "to do" },
        creatorId: null,
        createdAt: null,
        updates: [{ body: "Note", creatorId: null, createdAt: null }],
      },
    ],
  };
}

test("importBoard writes nothing when any part is invalid", async () => {
  const { store, ids, events } = await seededStore();
  const base = { workspaceId: ids.workspaces.main, importerId: ids.users.alex };
  const before = store.listBoards({ limit: 1000 }).length;
  const broken = [
    (s) => (s.items[0].values.s = "Unknown label"),
    (s) => (s.items[0].groupKey = "nope"),
    (s) => (s.items[0].updates[0].body = " "),
    (s) => (s.items[0].values = { zzz: "x" }),
    (s) => s.columns[0].labels.push({ label: "to do", color: "#000000" }),
    (s) => (s.meta.sourceUrl = "javascript:alert(1)"),
    (s) => (s.groups = []),
    (s) => (s.items[0].creatorId = "999"),
  ];
  for (const breakIt of broken) {
    const input = spec(base);
    breakIt(input);
    const result = store.importBoard(input);
    assert.equal(result.ok, false, String(breakIt));
    assert.equal(result.reason, "invalid");
  }
  assert.equal(store.listBoards({ limit: 1000 }).length, before);
  assert.deepEqual(events, [], "no change was committed");
  assert.equal(store.importBoard(spec({ ...base, workspaceId: "999" })), null);
  store.deactivateUser(ids.users.priya);
  assert.equal(
    store.importBoard(spec({ ...base, importerId: ids.users.priya })),
    null,
  );
});

test("importBoard applies accepted grants and reports refused ones", async () => {
  const { store, ids, events } = await seededStore();
  const members = [
    { userId: ids.users.sam, role: "editor" },
    { userId: ids.users.chris, role: "editor" },
    { userId: ids.users.sam, role: "viewer" },
    { userId: ids.users.morgan, role: "editor" },
    { userId: ids.users.alex, role: "viewer" },
  ];
  const input = spec({
    workspaceId: ids.workspaces.main,
    importerId: ids.users.alex,
    members,
  });
  input.items[0].values.p = [ids.users.sam, ids.users.noa];
  const result = store.importBoard(input);
  assert.deepEqual(result.board.members, [
    { kind: "user", id: ids.users.alex, role: "owner" },
    { kind: "user", id: ids.users.sam, role: "editor" },
  ]);
  assert.deepEqual(
    result.refused.map((r) => [r.index, r.reason]),
    [
      [1, "guest_not_allowed"],
      [3, "deactivated"],
    ],
  );
  assert.deepEqual(result.unassigned, [
    { index: 0, columnKey: "p", userIds: [ids.users.noa] },
  ]);
  assert.deepEqual(result.counts, {
    groups: 1,
    columns: 2,
    items: 1,
    updates: 1,
  });
  const [item] = store.listItems({ boardId: result.board.id }).items;
  assert.deepEqual(item.values, {
    status: { index: 0 },
    people: [ids.users.sam],
  });
  assert.equal(store.listGroups(result.board.id)[0].color, "#579bfc");
  assert.deepEqual(events, [
    {
      type: "board_imported",
      board_id: result.board.id,
      resource_kind: "board",
      resource_id: result.board.id,
    },
  ]);
});

test("recordImportFinished notifies the importer once, with an app link", async () => {
  const { store, ids, events } = await seededStore();
  const userId = ids.users.alex;
  const record = store.recordImportFinished({
    userId,
    text: "Done",
    url: "#/boards/1",
  });
  assert.deepEqual(
    [record.kind, record.text, record.url, record.actor_id, record.read],
    ["import_finished", "Done", "#/boards/1", null, false],
  );
  assert.deepEqual(
    events.map((e) => [e.type, e.user_ids]),
    [["notification_created", [userId]]],
  );
  const bad = store.recordImportFinished({
    userId,
    text: "x",
    url: "https://x",
  });
  assert.equal(bad.reason, "invalid");
  assert.equal(
    store.recordImportFinished({ userId: "999", text: "x", url: "#/" }),
    null,
  );
});

test("Board.import and import activity survive a save and a reload", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const store = await createStore({ file });
  const users = store.listUsers();
  const result = store.importBoard(
    spec({
      workspaceId: store.listWorkspaces()[0].id,
      importerId: users[0].id,
    }),
  );
  await store.flush();
  const reloaded = await createStore({ file });
  assert.deepEqual(
    reloaded.getBoard(result.board.id).import,
    result.board.import,
  );
  const [entry] = reloaded.listActivity(result.board.id);
  assert.deepEqual(
    [entry.actor_id, entry.actor_label],
    [users[0].id, "Import from ClickUp"],
  );
  const plain = reloaded.listBoards({ limit: 1000 }).find((b) => !b.import);
  assert.equal(
    Object.hasOwn(plain, "import"),
    false,
    "other boards have no import field",
  );
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.boards.find((b) => b.id === result.board.id).import.source = "trello";
  await writeFile(file, JSON.stringify(saved));
  await assert.rejects(createStore({ file }), /boards\[\d+\] is malformed/);
  saved.boards.find((b) => b.id === result.board.id).import = null;
  await writeFile(file, JSON.stringify(saved));
  await assert.rejects(
    createStore({ file }),
    /malformed/,
    "null is not an import",
  );
});
