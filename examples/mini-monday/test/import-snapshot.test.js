/**
 * Import snapshot validation (SPEC-4 §2, `server/import/snapshot.js`):
 * structural errors with exact paths, and normalization with a warning
 * (exact path) for everything that changes or is left out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SNAPSHOT_LIMITS,
  nearestColor,
  validateSnapshot,
} from "../server/import/snapshot.js";
import { REPEAT_LIMIT } from "../server/import/snapshot-rules.js";
import { sampleSnapshot } from "./import-engine-fixtures.js";

const BOARD = "workspaces[0].boards[0]";
const roadmapOf = (snapshot) => snapshot.workspaces[0].boards[0];
const checked = (snapshot) => {
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.snapshot;
};
/** The warnings added by validation (after the connector's own). */
const added = (snapshot) => checked(snapshot).warnings.slice(1);
const at = (warnings, path) => warnings.filter((w) => w.path === path);

test("a well-formed snapshot passes unchanged, keeping the connector's warnings", () => {
  const input = sampleSnapshot();
  const result = validateSnapshot(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  const output = result.snapshot;
  assert.deepEqual(output.warnings[0], input.warnings[0]);
  assert.deepEqual(
    output.warnings.slice(1).map((w) => w.code),
    [],
    "nothing in the sample needs normalizing",
  );
  assert.equal(output.workspaces[0].docs[0].visibility, "private");
  const board = roadmapOf(output);
  assert.deepEqual(board.items[0].values, roadmapOf(input).items[0].values);
  assert.equal(board.columns[1].labels, undefined, "labels only on status");
  assert.deepEqual(
    validateSnapshot(structuredClone(output)).snapshot,
    output,
    "normalizing a normalized copy changes nothing",
  );
  assert.equal(validateSnapshot(output).snapshot, output, "checked once");
  assert.ok(Object.isFrozen(board.items[0].values), "and frozen");
});

test("structural errors name exact paths and reject the snapshot", () => {
  const snapshot = sampleSnapshot();
  snapshot.source = "jira";
  snapshot.users[1].email = 42;
  const board = roadmapOf(snapshot);
  board.kind = "secret";
  board.columns[2].type = "formula";
  board.items[1] = "not an item";
  snapshot.workspaces[0].boards[1].source_id = "b-roadmap";
  snapshot.workspaces[1].kind = "public";
  snapshot.warnings.push({ code: "has spaces", message: "x", path: "" });
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.snapshot, null);
  assert.deepEqual(
    result.errors.map((e) => [e.path, e.code]),
    [
      ["source", "invalid_value"],
      ["warnings[1]", "invalid_warning"],
      ["users[1].email", "invalid_type"],
      [`${BOARD}.kind`, "invalid_value"],
      [`${BOARD}.columns[2].type`, "invalid_value"],
      [`${BOARD}.items[1]`, "invalid_type"],
      ["workspaces[1].kind", "invalid_value"],
    ],
  );
  const twice = sampleSnapshot();
  twice.workspaces[0].boards[1].source_id = "b-roadmap";
  twice.workspaces[0].docs.push({
    source_id: "d-1",
    title: "Again",
    blocks: [],
  });
  assert.deepEqual(
    validateSnapshot(twice).errors.map((e) => [e.path, e.code]),
    [
      ["workspaces[0].boards[1].source_id", "duplicate_id"],
      ["workspaces[0].docs[1].source_id", "duplicate_id"],
    ],
  );
  assert.deepEqual(validateSnapshot(null).errors[0].path, "");
});

test("size limits are errors at the list that is too long", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  snapshot.workspaces[1].boards = Array.from(
    { length: SNAPSHOT_LIMITS.boards },
    (_, index) => ({ ...board, source_id: `copy-${index}`, items: [] }),
  );
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((e) => [e.path, e.code]),
    [["workspaces[1]", "too_large"]],
  );
  const many = sampleSnapshot();
  roadmapOf(many).columns = Array.from({ length: 501 }, (_, i) => ({
    source_id: `c${i}`,
    title: "C",
    type: "text",
  }));
  assert.deepEqual(validateSnapshot(many).errors[0], {
    code: "too_large",
    message: "At most 500 entries are supported",
    path: `${BOARD}.columns`,
  });
});

test("names, descriptions, colors and links are normalized with warnings", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  board.name = "  ";
  board.description = "d".repeat(2001);
  board.source_url = "javascript:alert(1)";
  board.groups[0].color = "orange";
  board.groups[1].color = "#579BFC";
  board.items[0].name = `${"n".repeat(254)}😀`;
  const output = checked(snapshot);
  const warnings = added(snapshot);
  const normalized = roadmapOf(output);
  assert.equal(normalized.name, "Untitled board");
  assert.equal(normalized.description.length, 2000);
  assert.equal(normalized.source_url, null);
  assert.equal(normalized.groups[0].color, "#579bfc");
  assert.equal(
    normalized.groups[1].color,
    "#579bfc",
    "lower-cased, no warning",
  );
  assert.equal(normalized.items[0].name, "n".repeat(254), "no half emoji");
  assert.deepEqual(
    warnings.map((w) => [w.path, w.code]),
    [
      [`${BOARD}.name`, "empty_name"],
      [`${BOARD}.description`, "truncated"],
      [`${BOARD}.source_url`, "invalid_url"],
      [`${BOARD}.groups[0].color`, "invalid_color"],
      [`${BOARD}.items[0].name`, "truncated"],
    ],
  );
});

test("a board's source folder and own name are optional for any source; bad ones are left out", () => {
  const snapshot = sampleSnapshot();
  const [roadmap, hiring] = snapshot.workspaces[0].boards;
  roadmap.folder = { source_id: 42, name: ` ${"f".repeat(256)} `, more: 1 };
  roadmap.source_name = "  Roadmap ";
  hiring.folder = null;
  const output = checked(snapshot);
  const [first, second] = output.workspaces[0].boards;
  assert.deepEqual(first.folder, { source_id: "42", name: "f".repeat(255) });
  assert.equal(first.source_name, "Roadmap");
  assert.equal(second.folder, null, "in no folder, as the source said");
  const old = output.workspaces[1].boards[0];
  for (const board of [second, old])
    assert.equal(Object.hasOwn(board, "source_name"), false);
  assert.equal(Object.hasOwn(old, "folder"), false, "unknown stays absent");
  assert.deepEqual(
    validateSnapshot(structuredClone(output)).snapshot,
    output,
    "normalizing again changes nothing",
  );
  assert.deepEqual(
    added(snapshot).map((w) => [w.path, w.code]),
    [[`${BOARD}.folder.name`, "truncated"]],
  );
  const blank = sampleSnapshot();
  roadmapOf(blank).folder = { source_id: "f-1", name: " " };
  assert.deepEqual(roadmapOf(checked(blank)).folder, {
    source_id: "f-1",
    name: "Untitled folder",
  });
  const bad = [
    "Engineering",
    [],
    { name: "Engineering" },
    { source_id: " ", name: "Engineering" },
    { source_id: "x".repeat(256), name: "Engineering" },
    { source_id: "f-1", name: 7 },
  ];
  for (const [index, folder] of bad.entries()) {
    const input = sampleSnapshot();
    Object.assign(roadmapOf(input), {
      folder,
      source_name: [" ", 7][index % 2],
    });
    const board = roadmapOf(checked(input));
    const kept = ["folder", "source_name"].filter((k) =>
      Object.hasOwn(board, k),
    );
    assert.deepEqual(kept, [], JSON.stringify(folder));
    assert.deepEqual(
      added(input).map((w) => [w.path, w.code]),
      [
        [`${BOARD}.folder`, "invalid_folder"],
        [`${BOARD}.source_name`, "invalid_source_name"],
      ],
    );
  }
});

test("values take their column's format; what cannot be kept is reported", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  board.items[0].values = {
    status: "done",
    owner: ["u-sam", "u-ghost", "u-sam", 7],
    due: "2026-02-30",
    est: "4.5",
    notes: 12,
    missing: "x",
  };
  board.items[1].values = {
    status: "Blocked",
    due: "2026-01-02T10:00:00Z",
    est: "many",
    notes: "x".repeat(2001),
  };
  const output = roadmapOf(checked(snapshot));
  const warnings = added(snapshot);
  const values = (index) => `${BOARD}.items[${index}].values`;
  assert.deepEqual(output.items[0].values, {
    status: "Done",
    owner: ["u-sam"],
    est: 4.5,
    notes: "12",
  });
  assert.deepEqual(output.items[1].values, {
    status: "Blocked",
    due: "2026-01-02",
    notes: "x".repeat(2000),
  });
  assert.deepEqual(output.columns[0].labels.at(-1), {
    label: "Blocked",
    color: "#c4c4c4",
  });
  assert.deepEqual(
    warnings.map((w) => [w.path, w.code]),
    [
      [`${values(0)}.owner`, "unknown_user"],
      [`${values(0)}.owner`, "unknown_user"],
      [`${values(0)}.due`, "invalid_value"],
      [`${values(0)}.missing`, "unknown_column"],
      [`${BOARD}.columns[0]`, "status_label_added"],
      [`${values(1)}.est`, "invalid_value"],
      [`${values(1)}.notes`, "truncated"],
    ],
  );
  assert.match(at(warnings, `${values(0)}.due`)[0].message, /"2026-02-30"/);
});

test("references to groups, parents, users and duplicate IDs are resolved", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  board.items[0].group_source_id = "g-gone";
  board.items[0].parent_source_id = "i-2";
  board.items[2].parent_source_id = "i-404";
  board.items[2].creator_source_id = "u-ghost";
  board.items.push({
    ...board.items[2],
    source_id: "i-3",
    parent_source_id: null,
    creator_source_id: null,
  });
  board.members.push(
    { user_source_id: "u-sam", role: "owner" },
    { user_source_id: "u-ghost", role: "editor" },
    { user_source_id: "u-sam", role: "viewer" },
  );
  snapshot.users.push({ source_id: "u-sam", name: "Twin", email: null });
  const output = checked(snapshot);
  const warnings = added(snapshot);
  const items = roadmapOf(output).items;
  assert.equal(items[0].group_source_id, "g-now", "the first group");
  assert.deepEqual(
    items.map((i) => [i.source_id, i.parent_source_id]),
    [
      ["i-1", null],
      ["i-2", "i-1"],
      ["i-3", null],
      ["i-3#2", null],
    ],
    "the cycle i-1 ↔ i-2 is broken once; unknown parents are cleared",
  );
  assert.equal(items[2].creator_source_id, null);
  assert.deepEqual(roadmapOf(output).members[0], {
    user_source_id: "u-sam",
    role: "owner",
  });
  assert.equal(output.users.length, 6, "the duplicate user is merged");
  assert.deepEqual(
    warnings.map((w) => [w.path, w.code]),
    [
      ["users[6]", "duplicate_user"],
      [`${BOARD}.members[6]`, "unknown_user"],
      [`${BOARD}.items[0].group_source_id`, "unknown_group"],
      [`${BOARD}.items[2].creator_source_id`, "unknown_user"],
      [`${BOARD}.items[3]`, "duplicate_id"],
      [`${BOARD}.items[2].parent_source_id`, "unknown_parent"],
      [`${BOARD}.items[0].parent_source_id`, "parent_cycle"],
    ],
  );
});

test("repeated problems are listed REPEAT_LIMIT times, then counted", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  board.items = Array.from({ length: REPEAT_LIMIT + 7 }, (_, index) => ({
    ...board.items[2],
    source_id: `i-${index}`,
    values: { due: "soon" },
  }));
  const warnings = added(snapshot);
  assert.equal(warnings.length, REPEAT_LIMIT + 1);
  assert.equal(
    warnings[REPEAT_LIMIT - 1].path,
    `${BOARD}.items[19].values.due`,
  );
  assert.deepEqual(warnings.at(-1), {
    code: "invalid_value",
    message: "7 more like this (invalid_value) in board “Roadmap”",
    path: BOARD,
  });
});

test("status columns over 200 labels become text columns", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  board.columns[0].labels = Array.from({ length: 201 }, (_, i) => ({
    label: `L${i}`,
    color: "#00c875",
  }));
  board.items[0].values = { status: "l200" };
  board.items[1].values = {};
  const output = roadmapOf(checked(snapshot));
  assert.equal(output.columns[0].type, "text");
  assert.equal(output.columns[0].labels, undefined);
  assert.equal(output.items[0].values.status, "L200", "the label as text");
  assert.deepEqual(
    added(snapshot).map((w) => [w.path, w.code]),
    [[`${BOARD}.columns[0]`, "too_many_labels"]],
  );
});

test("updates, users and docs are normalized", () => {
  const snapshot = sampleSnapshot();
  const item = roadmapOf(snapshot).items[0];
  item.updates.push(
    {
      body: "   ",
      author_source_id: null,
      author_name: null,
      created_at: null,
    },
    {
      body: "u".repeat(10_001),
      author_source_id: "u-ghost",
      author_name: null,
      created_at: "later",
    },
  );
  snapshot.users[4].email = "not an email";
  snapshot.users[5].name = null;
  const doc = snapshot.workspaces[0].docs[0];
  doc.visibility = "workspace";
  doc.blocks.push({ type: "embed", text: "x" }, { type: "divider", text: "y" });
  const output = checked(snapshot);
  const updates = roadmapOf(output).items[0].updates;
  assert.equal(updates.length, 3, "the empty update is left out");
  assert.equal(updates[2].body.length, 10_000);
  assert.equal(updates[2].author_source_id, null);
  assert.equal(output.users[4].email, null);
  assert.equal(output.users[5].name, "Unknown user");
  assert.deepEqual(output.workspaces[0].docs[0].blocks.slice(2), [
    { type: "paragraph", text: "x" },
    { type: "divider", text: "" },
  ]);
  assert.equal(output.workspaces[0].docs[0].visibility, "workspace");
  const path = `${BOARD}.items[0].updates`;
  assert.deepEqual(
    added(snapshot).map((w) => [w.path, w.code]),
    [
      ["users[4].email", "invalid_email"],
      ["users[5].name", "empty_name"],
      [`${path}[2]`, "empty_update"],
      [`${path}[3]`, "truncated"],
      [`${path}[3]`, "unknown_user"],
      [`${path}[3].created_at`, "invalid_time"],
      ["workspaces[0].docs[0].blocks[2].type", "unknown_block"],
    ],
  );
});

test("boards without groups get one; long docs keep 2,000 blocks", () => {
  const snapshot = sampleSnapshot();
  const board = roadmapOf(snapshot);
  board.groups = [];
  board.items = board.items.map((item) => ({ ...item, group_source_id: null }));
  const doc = snapshot.workspaces[0].docs[0];
  doc.blocks = Array.from({ length: 2001 }, () => ({
    type: "paragraph",
    text: "p",
  }));
  const output = checked(snapshot);
  assert.deepEqual(roadmapOf(output).groups, [
    { source_id: "imported", title: "Imported", color: "#579bfc" },
  ]);
  assert.ok(
    roadmapOf(output).items.every((i) => i.group_source_id === "imported"),
  );
  assert.equal(output.workspaces[0].docs[0].blocks.length, 2000);
  assert.deepEqual(
    at(added(snapshot), "workspaces[0].docs[0].blocks").map((w) => w.code),
    ["truncated"],
  );
});

test("nearestColor maps any color to the closest Worklane color", () => {
  assert.equal(nearestColor("#00C876"), "#00c875");
  assert.equal(nearestColor("#e03030"), "#df2f4a");
  assert.equal(nearestColor("grass_green"), "#c4c4c4");
});
