import assert from "node:assert/strict";
import test from "node:test";
import {
  dueBucket,
  groupByDue,
  isOverdue,
} from "../web/ui/board/my-work-data.js";
import { isDoneStatus, prepareColumns } from "../web/ui/board/values.js";
import { paletteOptions } from "../web/ui/components/command-palette.js";
import {
  addDays,
  plural,
  timeAgo,
  todayString,
} from "../web/ui/components/format.js";
import { ICON_NAMES } from "../web/ui/components/icon.js";
import {
  BOARD_KINDS,
  NOTIFICATION_KINDS,
  RESOURCE_KINDS,
  boardKind,
} from "../web/ui/components/labels.js";
import { byRecency, rememberVisit } from "../web/ui/shell/recent.js";
import { sharedCards } from "../web/pages/shared.js";

const ORIGIN = "http://localhost:4100";

test("my work buckets: overdue, this week, later, no date, done", () => {
  const today = "2026-10-18";
  assert.equal(dueBucket("2026-10-17", today), "overdue");
  assert.equal(dueBucket("2026-10-18", today), "week");
  assert.equal(dueBucket("2026-10-24", today), "week");
  assert.equal(dueBucket("2026-10-25", today), "later");
  assert.equal(dueBucket(null, today), "none");
  const groups = groupByDue(
    [
      { id: "1", due: "2026-12-01" },
      { id: "2", due: null },
      { id: "3", due: "2026-01-01" },
      { id: "4", due: "2026-10-19" },
      { id: "5", due: "2026-09-30", done: true },
      { id: "6", due: null, done: true },
    ],
    today,
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.map((item) => item.id)]),
    [
      ["overdue", ["3"]],
      ["week", ["4"]],
      ["later", ["1"]],
      ["none", ["2"]],
      ["done", ["5", "6"]],
    ],
  );
  assert.equal(isOverdue({ due: "2026-09-30", done: true }, today), false);
  assert.equal(isOverdue({ due: "2026-09-30", done: false }, today), true);
  const [status] = prepareColumns([
    {
      id: "status",
      type: "status",
      settings_str: JSON.stringify({
        labels: { 0: "Working on it", 1: "Done", 2: " done ", 5: "" },
      }),
    },
  ]);
  const done = [0, 1, 2, 5, null].map((index) => isDoneStatus(status, index));
  assert.deepEqual(done, [false, true, true, false, false]);
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(todayString(new Date(2026, 0, 5)), "2026-01-05");
});

test("palette options filter actions and drop links that leave the app", (t) => {
  globalThis.location ??= { origin: ORIGIN };
  t.after(() => {
    if (globalThis.location?.origin === ORIGIN) delete globalThis.location;
  });
  const actions = [
    { id: "new-board", label: "New board", keywords: ["create"], run() {} },
    { id: "go-notes", label: "Go to Notes", run() {} },
  ];
  const results = [
    {
      kind: "board",
      id: "1",
      title: "Roadmap",
      subtitle: null,
      url: `${ORIGIN}/#/boards/1`,
    },
    {
      kind: "doc",
      id: "2",
      title: "Vision",
      subtitle: "Main",
      url: "#/docs/2",
    },
    {
      kind: "item",
      id: "3",
      title: "Evil",
      subtitle: null,
      url: "https://evil.test/#/boards/1",
    },
  ];
  const options = paletteOptions({ actions, results, query: "create" });
  assert.deepEqual(
    options.map((option) => option.id),
    ["new-board", "board:1", "doc:2"],
  );
  assert.equal(options[1].href, "#/boards/1");
  assert.equal(options[1].hint, "Board");
  assert.equal(paletteOptions({ actions, results: null, query: "" }).length, 2);
});

test("shared cards join details and name the owners", () => {
  const cards = sharedCards(
    [
      {
        kind: "board",
        id: "4",
        title: "Launch",
        subtitle: null,
        url: "#/boards/4",
      },
      { kind: "note", id: "9", title: "1:1", subtitle: null, url: "#/notes/9" },
      { kind: "user", id: "2", title: "Sam", subtitle: null, url: "#/admin" },
      {
        kind: "doc",
        id: "5",
        title: "Brief",
        subtitle: null,
        url: "https://x.test/",
      },
    ],
    {
      boards: [
        {
          id: 4,
          board_kind: "share",
          my_access: "editor",
          members: [
            {
              kind: "user",
              id: "3",
              name: "Priya",
              role: "owner",
              user: { id: "3", name: "Priya" },
            },
            {
              kind: "user",
              id: "6",
              name: "Chris",
              role: "editor",
              user: { id: "6", name: "Chris" },
            },
          ],
        },
      ],
      notes: [
        { id: "9", my_access: "viewer", owner: { id: "1", name: "Alex" } },
      ],
    },
  );
  assert.deepEqual(
    cards.map((card) => [card.kind, card.owners.map((owner) => owner.name)]),
    [
      ["board", ["Priya"]],
      ["note", ["Alex"]],
    ],
  );
});

test("recent visits are per user and only reorder known records", (t) => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  t.after(() => {
    delete globalThis.localStorage;
  });
  rememberVisit("1", "board", "3");
  rememberVisit("1", "board", "2");
  rememberVisit("1", "board", "../x");
  rememberVisit("2", "board", "1");
  const boards = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  assert.deepEqual(
    byRecency("1", "board", boards).map((board) => board.id),
    ["2", "3", "1", "4"],
  );
  // A remembered ID that the API no longer returns never appears.
  assert.deepEqual(
    byRecency("1", "board", [{ id: "4" }]).map((board) => board.id),
    ["4"],
  );
  globalThis.localStorage.getItem = () => {
    throw new Error("blocked");
  };
  assert.deepEqual(byRecency("1", "board", boards), boards);
});

test("labels cover every enum value and fall back safely", () => {
  assert.deepEqual(Object.keys(BOARD_KINDS), ["public", "private", "share"]);
  assert.equal(boardKind("public").label, "Main");
  assert.equal(boardKind("share").label, "Shareable");
  assert.equal(boardKind("__proto__").label, "Unknown");
  const icons = new Set(ICON_NAMES);
  for (const table of [BOARD_KINDS, RESOURCE_KINDS, NOTIFICATION_KINDS]) {
    for (const info of Object.values(table))
      assert.ok(icons.has(info.icon), info.icon);
  }
  assert.equal(plural(1, "board"), "1 board");
  assert.equal(plural(3, "board"), "3 boards");
  const now = Date.parse("2026-10-18T12:00:00Z");
  assert.equal(timeAgo("2026-10-18T11:59:30Z", now), "just now");
  assert.equal(timeAgo("2026-10-18T11:00:00Z", now), "1h ago");
  assert.equal(timeAgo("not a date", now), "");
});
