/**
 * The composer's mention picker as a state machine (`web/ui/board/
 * mention-picker-model.js`): which "@" query the caret types, the rows a
 * query offers (people with board access, teams, then people without
 * access; tasks), the keys and what a pick writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TASKS,
  applyPick,
  closedPicker,
  mentionQuery,
  peopleOptions,
  pickerForText,
  pickerKey,
  taskOptions,
  withOptions,
} from "../web/ui/board/mention-picker-model.js";
import { encodeBody, rebaseMentions } from "../web/ui/board/mention-tokens.js";

const USERS = [
  { id: "1", name: "Alex Rivera", email: "alex@example.test" },
  { id: "2", name: "Sam Lee", email: "sam@example.test" },
  { id: "5", name: "Jordan Blake", email: "jordan@example.test" },
  {
    id: "7",
    name: "Morgan Diaz",
    email: "morgan@x.test",
    status: "deactivated",
  },
  { id: "8", name: "Samira Noor", email: "samira@example.test" },
];
const ASSIGNABLE = USERS.filter((user) => ["1", "2", "5"].includes(user.id));
const TEAMS = [
  { id: "3", name: "Product" },
  { id: "4", name: "Sales" },
];
const people = (query) =>
  peopleOptions({ assignable: ASSIGNABLE, users: USERS, teams: TEAMS, query });

test("'@' at the start of a word opens people, '@@' tasks", () => {
  assert.deepEqual(mentionQuery("Hi @sa", 6), {
    mode: "people",
    start: 3,
    query: "sa",
  });
  assert.deepEqual(mentionQuery("@", 1), {
    mode: "people",
    start: 0,
    query: "",
  });
  assert.deepEqual(mentionQuery("see @@fix lo", 12), {
    mode: "tasks",
    start: 4,
    query: "fix lo",
  });
  assert.deepEqual(mentionQuery("(@sam", 5), {
    mode: "people",
    start: 1,
    query: "sam",
  });
  // Mid-word "@" (an email), a space right after "@", a line break, a
  // caret before the "@" and over-long queries are no mention.
  assert.equal(mentionQuery("mail me@example", 15), null);
  assert.equal(mentionQuery("@ sam", 5), null);
  assert.equal(mentionQuery("@sam\nlee", 8), null);
  assert.equal(mentionQuery("ab @sam", 2), null);
  assert.equal(mentionQuery(`@${"x".repeat(51)}`, 52), null);
  assert.equal(mentionQuery("a@@b", 4), null);
});

test("people: board access first, then teams, then no access", () => {
  const all = people("");
  assert.deepEqual(
    all.map((row) => [row.key, row.noAccess]),
    [
      ["user:1", false],
      ["user:2", false],
      ["user:5", false],
      ["team:3", false],
      ["team:4", false],
      ["user:8", true],
    ],
  );
  // Name or email, any case; deactivated people never show.
  assert.deepEqual(
    people("SAM").map((row) => row.name),
    ["Sam Lee", "Samira Noor"],
  );
  assert.deepEqual(
    people("jordan@").map((row) => row.key),
    ["user:5"],
  );
  assert.deepEqual(people("morgan"), []);
  assert.equal(people("").find((row) => row.kind === "team").detail, "Team");
  assert.equal(people("sam")[0].detail, "sam@example.test");
});

test("tasks: at most 20, with their board and status", () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: String(100 + index),
    name: `Task ${index}`,
    boardId: "4",
    boardName: "Roadmap",
    color: "#00c875",
    statusLabel: "Done",
  }));
  const rows = taskOptions(tasks);
  assert.equal(rows.length, MAX_TASKS);
  assert.deepEqual(rows[0], {
    key: "item:100",
    kind: "item",
    id: "100",
    name: "Task 0",
    detail: "Roadmap",
    boardId: "4",
    color: "#00c875",
    statusLabel: "Done",
    noAccess: false,
  });
});

test("keys move, wrap, pick, and Escape closes until a new '@'", () => {
  let state = pickerForText(closedPicker(), { text: "Hi @sa", caret: 6 });
  assert.equal(state.open, true);
  state = withOptions(state, people(state.query));
  assert.deepEqual(
    state.options.map((row) => row.name),
    ["Sam Lee", "Sales", "Samira Noor"],
  );
  // Keys the picker does not use pass through.
  assert.equal(pickerKey(state, "a").handled, false);
  let result = pickerKey(state, "ArrowDown");
  assert.equal(result.state.active, 1);
  result = pickerKey(result.state, "ArrowDown");
  result = pickerKey(result.state, "ArrowDown");
  assert.equal(result.state.active, 0, "wraps");
  result = pickerKey(result.state, "ArrowUp");
  assert.equal(result.state.active, 2, "wraps back");
  for (const key of ["Enter", "Tab"]) {
    const picked = pickerKey(result.state, key);
    assert.equal(picked.handled, true);
    assert.equal(picked.pick.name, "Samira Noor");
  }
  // Typing more keeps the picker on the same "@".
  const typed = pickerForText(result.state, { text: "Hi @sam", caret: 7 });
  assert.equal(typed.start, 3);
  assert.equal(typed.active, 0);
  // Escape closes it, and it stays closed for that "@"…
  const escaped = pickerKey(result.state, "Escape");
  assert.equal(escaped.handled, true);
  assert.equal(escaped.state.open, false);
  const still = pickerForText(escaped.state, { text: "Hi @samx", caret: 8 });
  assert.equal(still.open, false);
  // …but a new one opens again.
  const again = pickerForText(still, { text: "Hi @samx @no", caret: 12 });
  assert.equal(again.open, true);
  assert.equal(again.start, 9);
  // With no rows, Enter is the composer's (a line break).
  const empty = withOptions(again, []);
  assert.equal(pickerKey(empty, "Enter").handled, false);
  assert.equal(pickerKey(closedPicker(), "ArrowDown").handled, false);
});

test("a pick writes '@Name ' and a side-table entry that encodes", () => {
  const text = "Ping @sa please";
  const state = withOptions(
    pickerForText(closedPicker(), { text, caret: 8 }),
    people("sa"),
  );
  const option = state.options[0];
  const picked = applyPick(text, { state, option, name: option.name });
  assert.equal(picked.text, "Ping @Sam Lee  please");
  assert.equal(picked.caret, 14);
  assert.deepEqual(picked.mention, {
    start: 5,
    end: 13,
    kind: "user",
    id: "2",
    name: "Sam Lee",
  });
  const mentions = [...rebaseMentions([], text, picked.text), picked.mention];
  assert.equal(
    encodeBody(picked.text, mentions),
    "Ping @[Sam Lee](user:2)  please",
  );
  // A task pick replaces "@@query" and keeps the task's board.
  const tasks = withOptions(
    pickerForText(closedPicker(), { text: "see @@fi", caret: 8 }),
    taskOptions([{ id: "9", name: "Fix it", boardId: "4", boardName: "R" }]),
  );
  const task = applyPick("see @@fi", {
    state: tasks,
    option: tasks.options[0],
    name: "Fix it",
  });
  assert.equal(task.text, "see @Fix it ");
  assert.deepEqual(task.mention, {
    start: 4,
    end: 11,
    kind: "item",
    id: "9",
    name: "Fix it",
    boardId: "4",
  });
  // A name no token can carry is inserted as text, without an entry.
  const plain = applyPick("@x", {
    state: withOptions(
      pickerForText(closedPicker(), { text: "@x", caret: 2 }),
      people(""),
    ),
    option: { kind: "user", id: "1", name: "  " },
    name: null,
  });
  assert.equal(plain.mention, null);
});
