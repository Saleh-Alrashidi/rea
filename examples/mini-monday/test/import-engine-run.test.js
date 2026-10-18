/**
 * Import runs (SPEC-4 §4, `engine.run` over `store.importBoard`): what is
 * created and how, grants through the access rules, mapped people, the
 * importer's ownership and badge metadata, activity with the import's
 * label, no notification storm, the report, cancellation and re-imports.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { actorLabel, renderText } from "../server/store/activity.js";
import { itemOrder } from "../server/import/board-spec.js";
import { run } from "../server/import/engine.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";

const PLAN = Object.freeze({ users: { "u-new": "invite:member" } });

async function imported(plan = PLAN, snapshot = sampleSnapshot()) {
  const seeded = await seededStore();
  const { store, ids } = seeded;
  const progress = [];
  const options = {
    store,
    importerId: ids.users.alex,
    onProgress: (entry) => progress.push(entry),
  };
  const report = await run(snapshot, plan, options);
  const boardOf = (title) =>
    store.getBoard(report.links.find((l) => l.title === title)?.id);
  return { ...seeded, report, progress, options, boardOf };
}

test("a run creates workspaces, boards, groups, columns, items, updates, docs and users", async () => {
  const { store, ids, report, boardOf } = await imported();
  assert.deepEqual(report.created, {
    workspaces: 2,
    boards: 3,
    groups: 4,
    columns: 8,
    items: 4,
    updates: 2,
    docs: 1,
    users: 1,
  });
  assert.equal(report.cancelled, false);
  assert.deepEqual(
    report.links.map((l) => [l.kind, l.title, l.url.split("/")[1]]),
    [
      ["workspace", "Acme main", "workspaces"],
      ["board", "Roadmap", "boards"],
      ["board", "Hiring", "boards"],
      ["doc", "Handbook", "docs"],
      ["workspace", "Archive", "workspaces"],
      ["board", "Old board", "boards"],
    ],
  );
  const roadmap = boardOf("Roadmap");
  const workspace = store.getWorkspace(roadmap.workspace_id);
  assert.deepEqual(
    [workspace.name, workspace.kind, workspace.description],
    ["Acme main", "open", "From monday.com"],
  );
  assert.equal(
    store.getWorkspace(boardOf("Old board").workspace_id).kind,
    "closed",
  );
  assert.equal(roadmap.board_kind, "share");
  assert.equal(roadmap.creator_id, ids.users.alex);
  assert.deepEqual(roadmap.import, {
    source: "monday",
    source_id: "b-roadmap",
    source_url: "https://acme.monday.com/boards/101",
    imported_at: roadmap.import.imported_at,
    imported_by: ids.users.alex,
  });
  const doc = store.getDoc(report.links.find((l) => l.kind === "doc").id);
  assert.deepEqual(
    doc.blocks.map(({ type, text, checked }) => [type, text, checked]),
    [
      ["heading1", "Welcome", undefined],
      ["todo", "Read this", true],
    ],
  );
  assert.equal(doc.visibility, "private");
  assert.deepEqual(doc.members, [
    { kind: "user", id: ids.users.alex, role: "owner" },
  ]);
  const nia = store.findUserByEmail("nia@acme.test");
  assert.deepEqual([nia.name, nia.role], ["Nia New", "member"]);
  assert.deepEqual(
    report.skipped.map((s) => [s.kind, s.source_id, s.reason]),
    [
      ["user", "u-morgan", "skipped"],
      ["user", "u-anon", "skipped"],
    ],
  );
});

test("columns, statuses, items, subitems and updates keep their content", async () => {
  const { store, ids, boardOf } = await imported();
  const roadmap = boardOf("Roadmap");
  assert.deepEqual(
    store.listGroups(roadmap.id).map((g) => [g.title, g.color]),
    [
      ["Now", "#fdab3d"],
      ["Later", "#579bfc"],
    ],
  );
  const columns = store.listColumns(roadmap.id);
  assert.deepEqual(
    columns.map((c) => [c.id, c.title, c.type]),
    [
      ["name", "Name", "name"],
      ["status", "Status", "status"],
      ["people", "Owner", "people"],
      ["date", "Due", "date"],
      ["numbers", "Estimate", "numbers"],
      ["text", "Notes", "text"],
      ["text_2", "Parent item", "text"],
    ],
  );
  assert.deepEqual(columns[1].settings, {
    labels: { 0: "Working on it", 1: "Done" },
    labels_colors: { 0: "#fdab3d", 1: "#00c875" },
  });
  const { items } = store.listItems({ boardId: roadmap.id, limit: 10 });
  assert.deepEqual(
    items.map((i) => [i.name, i.values]),
    [
      [
        "Launch site",
        {
          status: { index: 1 },
          people: [ids.users.sam],
          date: "2026-11-01",
          numbers: 3,
          text: "Ship it",
        },
      ],
      ["Write copy", { status: { index: 0 }, text_2: "Launch site" }],
      ["Later thing", { people: [ids.users.chris] }],
    ],
    "the subitem follows its parent and names it",
  );
  assert.equal(items[0].created_at, "2025-03-04T05:06:07.000Z");
  assert.equal(items[0].creator_id, ids.users.sam);
  const updates = store.listUpdates(items[0].id).toReversed();
  assert.deepEqual(
    updates.map((u) => [u.body, u.creator_id, u.created_at.slice(0, 10)]),
    [
      ["Kickoff done", ids.users.sam, "2025-03-05"],
      [
        "Old Admin wrote on monday.com:\nPing",
        null,
        updates[1].created_at.slice(0, 10),
      ],
    ],
  );
});

test("grants follow the access rules; refusals and left-out people are warnings", async () => {
  const { store, ids, report, boardOf } = await imported();
  const roles = (board) =>
    Object.fromEntries(board.members.map((m) => [m.id, m.role]));
  assert.deepEqual(roles(boardOf("Roadmap")), {
    [ids.users.alex]: "owner",
    [ids.users.sam]: "editor",
    [ids.users.chris]: "viewer",
    [ids.users.jordan]: "editor",
  });
  const hiring = boardOf("Hiring");
  assert.deepEqual(roles(hiring), {
    [ids.users.alex]: "owner",
    [ids.users.sam]: "editor",
  });
  const [designer] = store.listItems({ boardId: hiring.id }).items;
  assert.deepEqual(designer.values.people, [ids.users.sam]);
  const warnings = report.warnings.slice(1);
  assert.deepEqual(
    warnings.map((w) => [w.code, w.path]),
    [
      ["members_skipped", "workspaces[0].boards[0].members"],
      ["people_skipped", "workspaces[0].boards[0].columns[1]"],
      ["grant_refused", "workspaces[0].boards[1].members[1]"],
      ["people_unassignable", "workspaces[0].boards[1].columns[0]"],
    ],
  );
  assert.match(warnings[0].message, /Anon/);
  assert.match(
    warnings[2].message,
    /Chris T\. was not given access to “Hiring”: Guests can only join/,
  );
  assert.match(warnings[3].message, /Jordan Blake/);
  assert.equal(
    report.warnings.filter((w) => w.code === "grant_refused").length,
    1,
    "Morgan was skipped, so no grant was even tried",
  );
});

test("imports write one change per board and notify only the importer, once", async () => {
  const { store, ids, events } = await imported();
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "user_created",
      "workspace_created",
      "board_imported",
      "board_imported",
      "doc_created",
      "workspace_created",
      "board_imported",
      "notification_created",
    ],
  );
  const baseline = (await seededStore()).store;
  for (const user of ["sam", "chris", "jordan"]) {
    const count = (s) =>
      s.listNotifications(ids.users[user], { limit: 500 }).length;
    assert.equal(count(store), count(baseline), `${user} was not notified`);
  }
  const [last] = store.listNotifications(ids.users.alex, { limit: 1 });
  assert.equal(last.kind, "import_finished");
  assert.equal(
    last.text,
    "Import from monday.com finished: 3 boards, 4 items and 1 doc",
  );
  assert.match(last.url, /^#\/workspaces\/\d+$/);
  assert.deepEqual(events.at(-1).user_ids, [ids.users.alex]);
});

test("activity names the importer with the import's label", async () => {
  const { store, ids, boardOf } = await imported();
  const entries = store.listActivity(boardOf("Roadmap").id).toReversed();
  const nameOf = (id) => store.getUser(id)?.name ?? "Someone";
  assert.deepEqual(
    entries.map((e) => [
      e.kind,
      e.actor_id,
      actorLabel(e, nameOf),
      renderText(e.to_text, nameOf),
    ]),
    [
      [
        "board_imported",
        ids.users.alex,
        "Import from monday.com",
        "Imported from monday.com account Acme: 3 items, 2 groups",
      ],
      [
        "member_added",
        ids.users.alex,
        "Import from monday.com",
        "Sam Lee (editor)",
      ],
      [
        "member_added",
        ids.users.alex,
        "Import from monday.com",
        "Chris Taylor (viewer)",
      ],
      [
        "member_added",
        ids.users.alex,
        "Import from monday.com",
        "Jordan Blake (editor)",
      ],
    ],
  );
  const plain = { actor_id: ids.users.sam, actor_label: null };
  assert.equal(
    actorLabel(plain, nameOf),
    "Sam Lee",
    "other entries keep their actor's name",
  );
});

test("subitems follow their parents, depth first, within their group", () => {
  const item = (source_id, group_source_id, parent_source_id = null) => ({
    source_id,
    group_source_id,
    parent_source_id,
  });
  const items = [
    item("A", "g"),
    item("B", "g"),
    item("C", "g", "A"),
    item("D", "g", "C"),
    item("E", "h", "B"),
    item("F", "g", "A"),
  ];
  assert.deepEqual(
    itemOrder(items).map((index) => items[index].source_id),
    ["A", "C", "D", "F", "B", "E"],
    "E's parent is in another group, so E keeps its own place",
  );
});
