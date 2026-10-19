/**
 * One manual order per board (SPEC-6 §1.2, server/store/positions.js):
 * the /4 → /5 upgrade renumbers each board in display order (and keeps a
 * `.v4.bak` copy; /3 files go through the same chain), every creation
 * path puts new items after every item of their board, and moves take
 * the midpoint between neighbors, renumbering the board when a side is
 * missing or the gap is too small.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import { FORMAT } from "../server/store/persistence.js";
import {
  MIN_POSITION_GAP,
  POSITION_SPACING,
  midpoint,
  renumberedMidpoint,
} from "../server/store/positions.js";
import { seedIds } from "./helpers.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };
const S = POSITION_SPACING;

async function dataFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-positions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "data.json");
}

const readDoc = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, doc) => writeFile(file, `${JSON.stringify(doc)}\n`);
const allItems = (store, boardId) =>
  store.listItems({ boardId, limit: 10_000 }).items;
const idsOf = (items) => items.map((item) => item.id);

/**
 * Items of `doc` in the display order of format /4, computed here on its
 * own: group position, then item position, then ID.
 */
function legacyOrder(doc, boardId) {
  const groups = doc.groups.filter((g) => g.board_id === boardId);
  const rank = (item) =>
    groups.find((g) => g.id === item.group_id).position * 1e9;
  return doc.items
    .filter((item) => item.board_id === boardId)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.position - b.position ||
        Number(a.id) - Number(b.id),
    )
    .map((item) => item.id);
}

/**
 * Rewrites a current file as format `version` stored it: positions per
 * group (0, 1, … in each group's order, with a tie in one group, broken by
 * ID) and no List views.
 */
function asLegacy(doc, version) {
  const next = new Map();
  const items = doc.items
    .toSorted((a, b) => a.position - b.position)
    .map((item) => {
      const key = `${item.board_id}/${item.group_id}`;
      const position = next.get(key) ?? 0;
      next.set(key, position + 1);
      return { ...item, position };
    });
  // Two items of one group with the same position: the lower ID is first.
  const done = items.filter((i) => i.group_id === "done");
  done[1].position = done[0].position;
  return {
    ...doc,
    format: `mini-monday-store/${version}`,
    items: items.toSorted((a, b) => Number(b.id) - Number(a.id)),
    views: doc.views.filter((view) => view.type !== "list"),
  };
}

/** A current file with items in several groups, a subitem and a move. */
async function busyFile(t) {
  const file = await dataFile(t);
  const store = await createStore({ file, log: quietLog });
  const { boards } = seedIds(store);
  const add = (groupId, name, extra = {}) =>
    store.createItem({ boardId: boards.roadmap, groupId, name, ...extra });
  const late = add("done", "Late done");
  add("this_sprint", "Late sprint");
  const parent = add("next_up", "Parent");
  add(null, "Child", { parentId: parent.id });
  store.moveItem(late.id, { groupId: "this_sprint", toGroupEnd: true });
  await store.flush();
  return { file, doc: await readDoc(file), boards };
}

test("a /4 file is renumbered in display order and keeps a .v4.bak", async (t) => {
  const { file, doc, boards } = await busyFile(t);
  const legacy = asLegacy(doc, 4);
  await save(file, legacy);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  for (const board of legacy.boards) {
    const items = allItems(store, board.id);
    // The Main table order is unchanged by the upgrade, paging included.
    assert.deepEqual(idsOf(items), legacyOrder(legacy, board.id), board.name);
    assert.deepEqual(
      items.map((item) => item.position),
      items.map((_, index) => (index + 1) * S),
      "1024, 2048, … in that order",
    );
    const page = store.listItems({ boardId: board.id, offset: 1, limit: 2 });
    assert.deepEqual(idsOf(page.items), idsOf(items).slice(1, 3));
  }
  const roadmap = allItems(store, boards.roadmap);
  const child = roadmap.find((item) => item.name === "Child");
  assert.equal(store.getItem(child.parent_id).name, "Parent");
  const saved = await readDoc(file);
  assert.equal(saved.format, FORMAT);
  assert.equal(FORMAT, "mini-monday-store/5");
  const copy = `${file}.v4.bak`;
  assert.deepEqual(await readDoc(copy), legacy);
  assert.equal((await stat(copy)).mode & 0o777, 0o600, "the copy is private");
  // Boards of /4 files had no List view; loading adds one each.
  for (const board of saved.boards) {
    const [first] = store.listViews(board.id);
    assert.equal(first.type, "list", board.name);
  }
  // A second load is a current file: nothing changes.
  const text = await readFile(file, "utf8");
  const again = await createStore({ file, log: quietLog });
  await again.flush();
  assert.equal(await readFile(file, "utf8"), text);
  assert.deepEqual(allItems(again, boards.roadmap), roadmap);
});

test("a /3 file upgrades through the /4 renumbering", async (t) => {
  const { file, doc, boards } = await busyFile(t);
  const legacy = asLegacy(doc, 3);
  await save(file, legacy);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  const items = allItems(store, boards.roadmap);
  assert.deepEqual(idsOf(items), legacyOrder(legacy, boards.roadmap));
  assert.deepEqual(
    items.map((item) => item.position),
    items.map((_, index) => (index + 1) * S),
  );
  assert.deepEqual(await readDoc(`${file}.v3.bak`), legacy);
  // Only the original version is kept.
  await assert.rejects(access(`${file}.v4.bak`), { code: "ENOENT" });
  assert.equal((await readDoc(file)).format, FORMAT);
});

test("every creation path puts new items after the whole board", async () => {
  const store = await createStore({ log: quietLog });
  const { boards, users, forms } = seedIds(store);
  const roadmap = boards.roadmap;
  const last = () =>
    Math.max(...allItems(store, roadmap).map((item) => item.position));
  const top = last();
  assert.equal(top, 8 * S, "the seed's 8 items sit at 1024 … 8192");
  const created = store.createItem({
    boardId: roadmap,
    groupId: "this_sprint",
    name: "First group, last place",
  });
  assert.equal(created.position, top + S);
  const child = store.createItem({
    boardId: roadmap,
    name: "Subitem",
    parentId: created.id,
  });
  assert.equal(child.position, top + 2 * S);
  // Form responses (the feature form fills the roadmap).
  const feature = store.getForm(forms.feature);
  assert.equal(feature.board_id, roadmap);
  const submitted = store.submitForm(feature.id, { name: "From a form" });
  assert.equal(submitted.position, top + 3 * S);
  // Other boards count on their own.
  const fresh = store.createBoard({ name: "Fresh" });
  const first = store.createItem({ boardId: fresh.id, name: "One" });
  assert.equal(first.position, S);
  // Imports: spec order, one spacing apart, so each group keeps it.
  const imported = store.importBoard({
    workspaceId: store.listWorkspaces()[0].id,
    importerId: users.alex,
    name: "Imported",
    description: null,
    boardKind: "public",
    meta: { source: "csv", sourceId: "file.csv", sourceUrl: null },
    label: "Import from CSV",
    summary: null,
    members: [],
    groups: [
      { key: "a", title: "A", color: "#579bfc" },
      { key: "b", title: "B", color: "#00c875" },
    ],
    columns: [],
    items: ["b", "a", "b", "a"].map((groupKey, n) => ({
      key: `k${n}`,
      groupKey,
      name: `Item ${n}`,
      values: {},
      updates: [],
    })),
  });
  const items = allItems(store, imported.board.id);
  assert.deepEqual(
    items.map((item) => [item.name, item.position]),
    [
      ["Item 1", 2 * S],
      ["Item 3", 4 * S],
      ["Item 0", S],
      ["Item 2", 3 * S],
    ],
  );
});

test("midpoints split gaps; missing sides and tiny gaps renumber", () => {
  const order = [1, 2, 4].map((n) => ({ id: String(n), position: n * S }));
  assert.equal(midpoint(order, { lo: 0, hi: 1 }), 1.5 * S);
  assert.equal(midpoint(order, { lo: 1, hi: 2 }), 3 * S);
  assert.equal(midpoint(order, { lo: -1, hi: 0 }), null, "no item before");
  assert.equal(midpoint(order, { lo: 2, hi: 3 }), null, "no item after");
  const tiny = [
    { id: "1", position: 10 },
    { id: "2", position: 10 + MIN_POSITION_GAP / 2 },
  ];
  assert.equal(midpoint(tiny, { lo: 0, hi: 1 }), null, "gap below 1e-6");
  // Floats so large that no number lies between them.
  const big = 2 ** 60;
  const dense = [
    { id: "1", position: big },
    { id: "2", position: big + 256 },
  ];
  assert.equal(midpoint(dense, { lo: 0, hi: 1 }), null, "no midpoint");
  // After renumbering, index k sits at (k + 1) × 1024.
  assert.equal(renumberedMidpoint({ lo: -1, hi: 0 }), S / 2);
  assert.equal(renumberedMidpoint({ lo: 0, hi: 1 }), 1.5 * S);
  assert.equal(renumberedMidpoint({ lo: 2, hi: 3 }), 3.5 * S);
});
