import assert from "node:assert/strict";
import test from "node:test";
import { roleColumns } from "../web/ui/board/column-roles.js";
import {
  buildTree,
  defaultListPrefs,
  effectiveGroupBy,
  emptyColumnIds,
  highlightParts,
  listColumns,
  listGroups,
} from "../web/ui/board/list-model.js";
import { renderList } from "../web/ui/board/list-view.js";
import { subtasksOf } from "../web/ui/board/task-model.js";
import { isDoneStatus, prepareColumns } from "../web/ui/board/values.js";
import {
  FakeElement,
  findAll,
  fire,
  hasClass,
  installFakeDom,
} from "./fake-dom.js";

/** Status settings JSON with optional label types. */
const statusSettings = (labels, colors, types) =>
  JSON.stringify({
    labels,
    labels_colors: colors,
    ...(types ? { labels_types: types } : {}),
  });

/** A ClickUp-shaped board: department statuses plus Closed, roles set. */
function meetingsBoard(items) {
  const columns = prepareColumns([
    { id: "name", title: "Name", type: "name", settings_str: "{}" },
    {
      id: "status",
      title: "Status",
      type: "status",
      role: "status",
      settings_str: statusSettings(
        { 0: "facility", 1: "psych dept", 2: "Closed", 5: "" },
        { 0: "#ff7800", 1: "#1090e0", 2: "#008844", 5: "#c4c4c4" },
        { 0: "custom", 1: "custom", 2: "closed" },
      ),
    },
    {
      id: "people",
      title: "Assignees",
      type: "people",
      role: "assignees",
      settings_str: "{}",
    },
    {
      id: "due",
      title: "Due date",
      type: "date",
      role: "due_date",
      settings_str: "{}",
    },
    {
      id: "priority",
      title: "Priority",
      type: "status",
      role: "priority",
      settings_str: statusSettings(
        { 0: "Urgent", 1: "High", 2: "Normal", 3: "Low" },
        { 0: "#f50000", 1: "#f8ae00", 2: "#6fddff", 3: "#d8d8d8" },
      ),
    },
    {
      id: "description",
      title: "Description",
      type: "text",
      role: "description",
      settings_str: "{}",
    },
    {
      id: "tags",
      title: "Tags",
      type: "text",
      role: "tags",
      settings_str: "{}",
    },
    { id: "minuts", title: "Minuts", type: "text", settings_str: "{}" },
    {
      id: "state",
      title: "Status",
      type: "status",
      settings_str: statusSettings(
        { 0: "Working on it", 1: "Done" },
        { 0: "#fdab3d", 1: "#00c875" },
      ),
    },
  ]);
  return {
    id: "1",
    columns,
    groups: [
      { id: "open", title: "Open", color: "#579bfc", position: 0 },
      { id: "closed", title: "Closed", color: "#00c875", position: 1 },
    ],
    views: [],
    items,
  };
}

function task(id, name, values = {}, extra = {}) {
  return {
    id,
    name,
    groupId: "open",
    parentId: null,
    updatesCount: 0,
    values: { status: null, people: [], due: null, ...values },
    texts: {},
    ...extra,
  };
}

const ITEMS = [
  task("1", "Agenda", { status: 0, people: ["2"], description: "Notes" }),
  task("2", "Agenda item one", { status: 2 }, { parentId: "1" }),
  task("3", "Agenda item two", { status: 1, people: ["3"] }, { parentId: "1" }),
  task("4", "Budget", { status: 1, people: ["2", "3"], priority: 0 }),
  task("5", "Retro", { status: 2 }, { groupId: "closed" }),
  task("6", "Loose ends"),
  // Its parent is not on the loaded board: shown at the top level.
  task("7", "Orphan", { status: 0 }, { parentId: "999" }),
];

const USERS = new Map([
  ["2", { id: "2", name: "Sam Lee" }],
  ["3", { id: "3", name: "Noa Levi" }],
]);

function groupsOf(board, prefs = {}, search = "") {
  const full = { ...defaultListPrefs(), ...prefs };
  const roles = roleColumns(board.columns);
  return listGroups(board, { prefs: full, roles, users: USERS, search });
}

const keys = (result) => result.groups.map((group) => group.key);
const names = (group) =>
  group.rows.map((row) => `${"  ".repeat(row.depth)}${row.item.name}`);

test("columns resolve by role, never by title, with type fallbacks", () => {
  const board = meetingsBoard(ITEMS);
  const roles = roleColumns(board.columns);
  assert.equal(roles.status.id, "status");
  assert.equal(roles.priority.id, "priority");
  assert.equal(roles.description.id, "description");
  // Without roles: the first status, people and date columns; the second
  // "Status" title never wins, and other roles have no fallback.
  const plain = board.columns.map(({ role: _role, ...column }) => column);
  const fallback = roleColumns(plain);
  assert.equal(fallback.status.id, "status");
  assert.equal(fallback.assignees.id, "people");
  assert.equal(fallback.due_date.id, "due");
  assert.equal(fallback.priority, null);
  assert.equal(fallback.description, null);
  const swapped = [plain[0], plain[8], ...plain.slice(1, 8)];
  assert.equal(roleColumns(swapped).status.id, "state");
});

test("cells: assignees, due date, priority, then board order; empty hidden", () => {
  const board = meetingsBoard(ITEMS);
  assert.deepEqual([...emptyColumnIds(board)].sort(), [
    "due",
    "minuts",
    "state",
    "tags",
  ]);
  const prefs = defaultListPrefs();
  const { cells } = listColumns(board, prefs);
  assert.deepEqual(
    cells.map((cell) => [cell.column.id, cell.kind, cell.shown]),
    [
      ["people", "assignees", true],
      ["due", "due", false],
      ["priority", "priority", true],
      // The description is the name cell's indicator unless shown.
      ["description", "text", false],
      ["tags", "text", false],
      ["minuts", "text", false],
      ["state", "status", false],
    ],
  );
  prefs.columns.set("due", true).set("people", false);
  const shown = listColumns(board, prefs).cells.filter((cell) => cell.shown);
  assert.deepEqual(
    shown.map((cell) => cell.column.id),
    ["due", "priority"],
  );
});

test("status groups: label order, closed types last, then No status", () => {
  const board = meetingsBoard(ITEMS);
  const result = groupsOf(board);
  assert.equal(result.groupBy, "status");
  // "psych dept" (1) has Budget; the empty groups stay hidden.
  assert.deepEqual(keys(result), [
    "status:0",
    "status:1",
    "status:2",
    "status:blank",
  ]);
  const [facility, psych, closed, blank] = result.groups;
  assert.deepEqual(
    [facility.label, facility.color, facility.count],
    ["facility", "#ff7800", 2],
  );
  assert.deepEqual([psych.count, closed.count, blank.count], [1, 1, 1]);
  // Closed groups start collapsed; the others open.
  assert.deepEqual(
    result.groups.map((group) => group.collapsed),
    [false, false, true, false],
  );
  // New tasks get the group's status and the board's first group; tasks
  // moved in take the label, or lose theirs in "No status".
  assert.deepEqual(facility.create, { groupId: null, values: { status: 0 } });
  assert.deepEqual(blank.create, { groupId: null, values: {} });
  assert.deepEqual(facility.move, { groupId: null, values: { status: 0 } });
  assert.deepEqual(blank.move, { groupId: null, values: { status: null } });
  assert.deepEqual(result.keysOf(ITEMS[3]), ["status:1"]);
});

test("groups and subtasks follow the manual order, not the board groups", () => {
  // Positions are board-wide: Retro (in the board's second group, last in
  // board order) comes first, Orphan before Agenda, and Agenda's second
  // subtask before its first.
  const positions = { 1: 1024, 2: 2048, 3: 1536, 4: 4096, 5: 100, 6: 6144 };
  const items = ITEMS.map((item) => ({
    ...item,
    position: positions[item.id] ?? 512,
  }));
  const board = meetingsBoard(items);
  const status = groupsOf(board, { subtasks: "expanded" });
  assert.deepEqual(names(status.groups[0]), [
    "Orphan",
    "Agenda",
    "  Agenda item two",
    "  Agenda item one",
  ]);
  const all = groupsOf(board, { groupBy: "none" });
  assert.deepEqual(names(all.groups[0]), [
    "Retro",
    "Orphan",
    "Agenda",
    "Budget",
    "Loose ends",
  ]);
  // The task view's subtasks come from the same tree.
  const agenda = items[0];
  const { rows } = subtasksOf(board, { item: agenda, status: null });
  assert.deepEqual(
    rows.map((row) => row.item.name),
    ["Agenda item two", "Agenda item one"],
  );
  // Equal positions fall back to the ID, as the server sorts.
  const tied = meetingsBoard([
    task("10", "Ten", {}, { position: 1 }),
    task("9", "Nine", {}, { position: 1 }),
  ]);
  assert.deepEqual(names(groupsOf(tied).groups[0]), ["Nine", "Ten"]);
});

test("empty groups show on request; closed ones go when hidden", () => {
  const board = meetingsBoard(ITEMS.filter((item) => item.id === "6"));
  assert.deepEqual(keys(groupsOf(board)), ["status:blank"]);
  assert.deepEqual(keys(groupsOf(board, { showEmpty: true })), [
    "status:0",
    "status:1",
    "status:2",
    "status:blank",
  ]);
  const full = meetingsBoard(ITEMS);
  const open = groupsOf(full, { showClosed: false });
  assert.deepEqual(keys(open), ["status:0", "status:1", "status:blank"]);
  // A closed subtask goes too.
  const expanded = groupsOf(full, { showClosed: false, subtasks: "expanded" });
  assert.deepEqual(names(expanded.groups[0]), [
    "Agenda",
    "  Agenda item two",
    "Orphan",
  ]);
  // An empty board keeps its first group, so a task can be added.
  assert.deepEqual(keys(groupsOf(meetingsBoard([]))), ["status:0"]);
});

test("subtasks sit under their parent in the parent's group", () => {
  const board = meetingsBoard(ITEMS);
  const collapsed = groupsOf(board).groups[0];
  assert.deepEqual(names(collapsed), ["Agenda", "Orphan"]);
  assert.deepEqual(
    collapsed.rows.map((row) => [row.childCount, row.expanded]),
    [
      [2, false],
      [0, false],
    ],
  );
  const expanded = groupsOf(board, { subtasks: "expanded" });
  assert.deepEqual(names(expanded.groups[0]), [
    "Agenda",
    "  Agenda item one",
    "  Agenda item two",
    "Orphan",
  ]);
  // Subtasks don't show in their own status groups.
  assert.deepEqual(names(expanded.groups[1]), ["Budget"]);
  // A per-parent toggle overrides the default either way.
  const one = groupsOf(board, { expanded: new Map([["1", true]]) });
  assert.equal(one.groups[0].rows.length, 4);
  const closedOne = groupsOf(board, {
    subtasks: "expanded",
    expanded: new Map([["1", false]]),
  });
  assert.deepEqual(names(closedOne.groups[0]), ["Agenda", "Orphan"]);
});

test("the tree treats items with a missing parent as top-level", () => {
  const { roots, children } = buildTree(ITEMS);
  assert.deepEqual(
    roots.map((item) => item.id),
    ["1", "4", "5", "6", "7"],
  );
  assert.deepEqual(
    children.get("1").map((item) => item.id),
    ["2", "3"],
  );
  // An item naming itself as parent is top-level too.
  const self = buildTree([task("8", "Self", {}, { parentId: "8" })]);
  assert.deepEqual(
    self.roots.map((item) => item.id),
    ["8"],
  );
});

test("search keeps the ancestors of matches, expanded, and marks names", () => {
  const board = meetingsBoard(ITEMS);
  const result = groupsOf(board, {}, " ITEM ONE ");
  assert.deepEqual(keys(result), ["status:0"]);
  const [group] = result.groups;
  assert.deepEqual(names(group), ["Agenda", "  Agenda item one"]);
  assert.deepEqual(
    group.rows.map((row) => row.matched),
    [false, true],
  );
  assert.equal(group.rows[0].expanded, true);
  // No match anywhere: no groups (the view says so).
  assert.deepEqual(keys(groupsOf(board, {}, "nothing")), []);
  assert.deepEqual(highlightParts("Agenda item one", "item"), [
    { text: "Agenda ", match: false },
    { text: "item", match: true },
    { text: " one", match: false },
  ]);
  assert.deepEqual(highlightParts("Aa", "a"), [
    { text: "A", match: true },
    { text: "a", match: true },
  ]);
  assert.deepEqual(highlightParts("Retro", ""), [
    { text: "Retro", match: false },
  ]);
});

test("priority, assignee, board group and no grouping", () => {
  const board = meetingsBoard(ITEMS);
  const priority = groupsOf(board, { groupBy: "priority" });
  assert.deepEqual(keys(priority), ["priority:0", "priority:blank"]);
  assert.equal(priority.groups[1].label, "No priority");
  assert.deepEqual(priority.groups[0].create.values, { priority: 0 });

  assert.deepEqual(priority.groups[1].move.values, { priority: null });

  const assignee = groupsOf(board, { groupBy: "assignee" });
  // By name, then Unassigned; a task with two assignees is in both.
  assert.deepEqual(keys(assignee), [
    "assignee:3",
    "assignee:2",
    "assignee:unassigned",
  ]);
  assert.deepEqual(names(assignee.groups[0]), ["Budget"]);
  assert.deepEqual(names(assignee.groups[1]), ["Agenda", "Budget"]);
  assert.deepEqual(assignee.groups[1].create.values, { people: ["2"] });
  assert.deepEqual(assignee.groups[1].move.values, { people: ["2"] });
  // Moving into Unassigned clears the assignees.
  assert.deepEqual(assignee.groups[2].move.values, { people: [] });
  assert.deepEqual(assignee.keysOf(ITEMS[3]), ["assignee:2", "assignee:3"]);

  const byGroup = groupsOf(board, { groupBy: "group" });
  assert.deepEqual(keys(byGroup), ["group:open", "group:closed"]);
  assert.deepEqual(byGroup.groups[1].create, { groupId: "closed", values: {} });
  assert.deepEqual(byGroup.groups[1].move, { groupId: "closed", values: {} });

  const none = groupsOf(board, { groupBy: "none" });
  assert.deepEqual(keys(none), ["all"]);
  assert.equal(none.groups[0].count, 5);
});

test("a group-by without its column falls back to the board's groups", () => {
  const roles = { status: null, priority: null, assignees: null };
  assert.equal(effectiveGroupBy("status", roles), "group");
  assert.equal(effectiveGroupBy("priority", roles), "group");
  assert.equal(effectiveGroupBy("none", roles), "none");
  assert.equal(effectiveGroupBy("bogus", { status: {} }), "group");
  assert.equal(effectiveGroupBy("status", { status: {} }), "status");
});

test("done labels: closed/done types, else the Done label", () => {
  const board = meetingsBoard(ITEMS);
  const [, status, , , , , , , state] = board.columns;
  assert.equal(status.status.options[2].type, "closed");
  assert.equal(isDoneStatus(status, 2), true);
  assert.equal(isDoneStatus(status, 0), false);
  // No types: the label decides ("Done" in any case).
  assert.equal(state.status.options[1].type, undefined);
  assert.equal(isDoneStatus(state, 1), true);
  assert.equal(isDoneStatus(state, null), false);
});

// ------------------------------------------------------------ the view

function viewContext(board, { edit }) {
  const calls = [];
  const ctx = {
    board,
    search: "",
    users: USERS,
    caps: { edit, manage: false, viewOnly: !edit, reasons: {} },
    actions: new Proxy(
      {},
      {
        get:
          (_target, name) =>
          (...args) =>
            calls.push([name, ...args]),
      },
    ),
    prefs: defaultListPrefs(),
    change(mutate) {
      mutate(ctx.prefs);
      calls.push(["change"]);
    },
    focusAfterRender: (key) => calls.push(["focus", key]),
    openItem: (id) => calls.push(["open", id]),
    calls,
  };
  return ctx;
}

const byRole = (root, role) =>
  findAll(root, (node) => node.getAttribute("role") === role);
const byClass = (root, name) => findAll(root, (node) => hasClass(node, name));

test("the list renders a treegrid per group with nested, labelled rows", (t) => {
  installFakeDom(t);
  const board = meetingsBoard(
    ITEMS.map((item) =>
      item.id === "1" ? { ...item, updatesCount: 3 } : item,
    ),
  );
  const ctx = viewContext(board, { edit: true });
  const container = new FakeElement("section");
  renderList(container, ctx);
  const grids = byRole(container, "treegrid");
  assert.equal(grids.length, 4);
  // The closed group starts collapsed.
  assert.deepEqual(
    grids.map((grid) => grid.hidden),
    [false, false, true, false],
  );
  const [facility] = grids;
  assert.deepEqual(
    byRole(facility, "columnheader").map((cell) => cell.textContent),
    ["Name", "Assignees", "Priority"],
  );
  const rows = byClass(facility, "list-row");
  assert.deepEqual(
    rows.map((row) => [
      row.getAttribute("aria-level"),
      row.getAttribute("aria-expanded"),
    ]),
    [
      ["1", "false"],
      ["1", null],
    ],
  );
  const [agenda] = rows;
  assert.equal(byClass(agenda, "list-subtasks")[0].textContent, "2");
  assert.equal(byClass(agenda, "list-comments")[0].textContent, "3");
  assert.equal(byClass(agenda, "list-indicator").length, 1);
  assert.equal(byClass(agenda, "list-name")[0].getAttribute("dir"), "auto");
  // Editors: a status menu button, rename and an add row per group.
  assert.equal(byClass(agenda, "list-status")[0].tagName, "BUTTON");
  assert.equal(byClass(agenda, "list-rename").length, 1);
  assert.equal(byClass(container, "list-add-input").length, 4);

  // Moves (SPEC-6 §1.4): a drag handle, a checkbox and a move menu; a
  // selection brings the bulk bar.
  for (const name of ["list-drag-handle", "list-select", "list-row-menu"]) {
    assert.equal(byClass(agenda, name).length, 1, name);
  }
  fire(byClass(agenda, "list-select")[0], "click", { shiftKey: false });
  assert.deepEqual([...ctx.prefs.selected], ["1"]);
  fire(byClass(agenda, "list-subtasks")[0], "click");
  assert.equal(ctx.prefs.expanded.get("1"), true);
  const again = new FakeElement("section");
  renderList(again, ctx);
  const levels = byClass(byRole(again, "treegrid")[0], "list-row").map((row) =>
    row.getAttribute("aria-level"),
  );
  assert.deepEqual(levels, ["1", "2", "2", "1"]);
  assert.equal(byClass(again, "list-bulk-count")[0].textContent, "1 selected");

  // "+ Add task" creates a top-level task with the group's status.
  const [input] = byClass(container, "list-add-input");
  input.value = "  New agenda ";
  fire(byClass(container, "list-add-form")[0], "submit");
  assert.deepEqual(ctx.calls.at(-1), [
    "createItem",
    { groupId: null, values: { status: 0 }, name: "New agenda" },
  ]);
  fire(byClass(agenda, "list-comments")[0], "click");
  assert.deepEqual(ctx.calls.at(-1), ["open", "1"]);
});

test("view-only users get the same list without editing controls", (t) => {
  installFakeDom(t);
  const ctx = viewContext(meetingsBoard(ITEMS), { edit: false });
  const container = new FakeElement("section");
  renderList(container, ctx);
  assert.equal(byClass(container, "list-add-input").length, 0);
  assert.equal(byClass(container, "list-rename").length, 0);
  assert.equal(byClass(container, "list-group-add").length, 0);
  for (const name of ["list-drag-handle", "list-select", "list-row-menu"]) {
    assert.equal(byClass(container, name).length, 0, name);
  }
  const circle = byClass(container, "list-status")[0];
  assert.equal(circle.tagName, "SPAN");
  assert.equal(circle.getAttribute("aria-label"), "Status: facility");
});
