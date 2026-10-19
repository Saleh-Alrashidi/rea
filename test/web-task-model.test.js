import assert from "node:assert/strict";
import test from "node:test";
import {
  activityEntries,
  completeOption,
  customFields,
  linkParts,
  subtasksOf,
  tagList,
  taskLayout,
  taskParent,
  updateAuthor,
} from "../web/ui/board/task-model.js";
import { prepareColumns } from "../web/ui/board/values.js";
import { meetingsBoard, task } from "./web-task-fixtures.js";

const titles = (columns) => columns.map((column) => column.title);

test("the layout partitions columns by role, never by title", () => {
  const board = meetingsBoard([]);
  const layout = taskLayout(board.columns);
  assert.deepEqual(
    layout.grid.map((row) => [row.key, row.label, titles(row.columns)]),
    [
      ["status", "Status", ["Status"]],
      ["assignees", "Assignees", ["Assignees"]],
      ["dates", "Dates", ["Start date", "Due date"]],
      ["priority", "Priority", ["Priority"]],
      ["time_estimate", "Time estimate", ["Time estimate"]],
      ["tags", "Tags", ["Tags"]],
    ],
  );
  assert.equal(layout.description.id, "description");
  // The second "Status" and "Priority" have no role: custom fields, in
  // board order, as is every column without a role.
  assert.deepEqual(titles(layout.custom), [
    "Minuts",
    "Files",
    "Status",
    "#",
    "Priority",
  ]);
});

test("a board without roles falls back by type and keeps the rest custom", () => {
  const columns = prepareColumns([
    { id: "name", title: "Name", type: "name", settings_str: "{}" },
    { id: "notes", title: "Description", type: "text", settings_str: "{}" },
    { id: "stage", title: "Stage", type: "status", settings_str: "{}" },
    { id: "when", title: "When", type: "date", settings_str: "{}" },
  ]);
  const layout = taskLayout(columns);
  // One date column is the due date; its row carries its own title.
  assert.deepEqual(
    layout.grid.map((row) => [row.key, row.label]),
    [
      ["status", "Stage"],
      ["dates", "When"],
    ],
  );
  // A text column titled "Description" is not the description.
  assert.equal(layout.description, null);
  assert.deepEqual(titles(layout.custom), ["Description"]);
});

test("custom fields split into filled and empty, in board order", () => {
  const board = meetingsBoard([]);
  const layout = taskLayout(board.columns);
  const item = task("1", "Weekly sync", { minuts: "a\nb", count: "3" });
  const { filled, empty } = customFields(layout, item);
  assert.deepEqual(titles(filled), ["Minuts", "#"]);
  assert.deepEqual(titles(empty), ["Files", "Status", "Priority"]);
});

test("Complete sets the first done or closed label", () => {
  const board = meetingsBoard([]);
  const status = board.columns.find((column) => column.id === "status");
  assert.equal(completeOption(status).label, "Closed");
  // Without label types, the label reading "Done" finishes work.
  const plain = board.columns.find((column) => column.id === "state");
  assert.equal(completeOption(plain).label, "Done");
  const priority = board.columns.find((column) => column.id === "priority");
  assert.equal(completeOption(priority), null);
  assert.equal(completeOption(null), null);
});

test("tags split on commas, trimmed, once each", () => {
  assert.deepEqual(tagList(" urgent, design ,,urgent, QA "), [
    "urgent",
    "design",
    "QA",
  ]);
  assert.deepEqual(tagList(null), []);
});

test("subtasks come from the board, with progress and the unloaded ones", () => {
  const board = meetingsBoard([
    task("1", "Agenda"),
    task("2", "Room", { status: 2 }, { parentId: "1", groupId: "closed" }),
    task("3", "Notes", { status: 0 }, { parentId: "1" }),
    task("4", "Deep", {}, { parentId: "3" }),
    task("5", "Other"),
  ]);
  const status = board.columns.find((column) => column.id === "status");
  const result = subtasksOf(board, {
    item: board.items[0],
    status,
    subitemsCount: 3,
  });
  // Direct children only, in board order, whatever their group.
  assert.deepEqual(
    result.rows.map((row) => [row.item.name, row.done]),
    [
      ["Room", true],
      ["Notes", false],
    ],
  );
  assert.equal(result.done, 1);
  assert.equal(result.total, 2);
  assert.equal(result.missing, 1);
  const none = subtasksOf(board, { item: board.items[4], status: null });
  assert.deepEqual([none.total, none.done, none.missing], [0, 0, 0]);
});

test("the parent comes from the loaded item, else the board row", () => {
  const board = meetingsBoard([
    task("1", "Agenda"),
    task("2", "Room", {}, { parentId: "1" }),
  ]);
  const [parent, child] = board.items;
  assert.deepEqual(taskParent(board, child, null), {
    id: "1",
    name: "Agenda",
  });
  const detail = { parent: { id: "9", name: "Not on the board" } };
  assert.deepEqual(taskParent(board, child, detail), detail.parent);
  assert.equal(taskParent(board, child, { parent: null }), null);
  assert.equal(taskParent(board, parent, null), null);
});

test("activity runs oldest first after the created line", () => {
  const detail = {
    createdAt: "2026-10-01T09:00:00.000Z",
    creator: { id: "1", name: "Alex" },
    // Saved comments: the pending one is not counted yet.
    updatesCount: 3,
    // loadItem's order: newest first.
    updates: [
      {
        id: "pending-1",
        body: "posting",
        created_at: "2026-10-01T09:00:00Z",
        pending: true,
      },
      { id: "12", body: "second", created_at: "2026-10-03T09:00:00.000Z" },
      { id: "11", body: "first b", created_at: "2026-10-02T09:00:00.000Z" },
      { id: "10", body: "first a", created_at: "2026-10-02T09:00:00.000Z" },
    ],
  };
  const entries = activityEntries(detail);
  assert.deepEqual(entries[0], {
    kind: "created",
    creator: detail.creator,
    at: detail.createdAt,
  });
  assert.deepEqual(
    entries.slice(1).map((entry) => entry.update.body),
    ["first a", "first b", "second", "posting"],
  );
  // More saved comments than loaded: a note says how many are older.
  const older = activityEntries({ ...detail, updatesCount: 503 });
  assert.deepEqual(older[1], { kind: "older", hidden: 500 });
  assert.equal(older.length, 6);
  assert.deepEqual(activityEntries(null), []);
});

test("authors: the user, else the source author with its tag", () => {
  const alex = { id: "1", name: "Alex" };
  assert.deepEqual(updateAuthor({ creator: alex }, "clickup"), {
    user: alex,
    name: "Alex",
    tag: null,
  });
  const imported = { creator: null, author_name: " Fox Mulder " };
  assert.deepEqual(updateAuthor(imported, "clickup"), {
    user: null,
    name: "Fox Mulder",
    tag: "ClickUp",
  });
  assert.equal(updateAuthor(imported, "monday").tag, "monday.com");
  assert.equal(updateAuthor(imported, "csv").tag, "Imported");
  // The API hides authors outside a guest's directory.
  const hidden = updateAuthor({ creator: null }, "clickup");
  assert.equal(hidden.name, "Someone");
  assert.equal(hidden.tag, null);
});

test("links: http(s) URLs only, without trailing punctuation", () => {
  assert.deepEqual(
    linkParts("See https://example.com/a?b=1, then (http://x.test/path)."),
    [
      { text: "See " },
      { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { text: ", then (" },
      { text: "http://x.test/path", href: "http://x.test/path" },
      { text: ")." },
    ],
  );
  // Balanced brackets stay in the URL; Arabic punctuation ends it.
  assert.deepEqual(linkParts("https://en.wikipedia.org/wiki/A_(b)، تم"), [
    {
      text: "https://en.wikipedia.org/wiki/A_(b)",
      href: "https://en.wikipedia.org/wiki/A_(b)",
    },
    { text: "، تم" },
  ]);
  // Other schemes and look-alikes stay text.
  for (const body of [
    "javascript:alert(1)",
    "xhttps://a.test",
    "ftp://a.test",
    "https://",
  ]) {
    assert.deepEqual(linkParts(body), [{ text: body }], body);
  }
  assert.deepEqual(linkParts("line one\nhttps://a.test\n"), [
    { text: "line one\n" },
    { text: "https://a.test", href: "https://a.test/" },
    { text: "\n" },
  ]);
  assert.deepEqual(linkParts(""), []);
});
