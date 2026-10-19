/**
 * The sidebar's Spaces tree (SPEC-6 §3.3), pure: the order of Spaces,
 * folders, Lists, docs and forms, expanded state, the current item and
 * its ancestors, and the per-user Favorites and expanded state kept in
 * browser storage.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  allNodes,
  ancestorKeys,
  buildSpaces,
  findNode,
  isExpanded,
  moveDestinations,
  neighborOf,
  parseKey,
  routeKey,
  siblingsOf,
  visibleRows,
} from "../web/ui/shell/sidebar-model.js";
import {
  MAX_ENTRIES,
  favoriteNodes,
  readExpanded,
  readFavorites,
  sidebarPrefs,
  toggleFavorite,
} from "../web/ui/shell/sidebar-prefs.js";
import { WORKSPACES } from "./web-sidebar-fixtures.js";

const keys = (nodes) => nodes.map((node) => node.key);

test("a Space lists its folders, then Lists, docs and forms, each in order", () => {
  const [product, leadership] = buildSpaces(WORKSPACES);
  assert.deepEqual(keys([product, leadership]), ["space:1", "space:2"]);
  // A board whose folder is not listed stays reachable at the root.
  assert.deepEqual(keys(product.children), [
    "folder:10",
    "folder:11",
    "board:100",
    "board:103",
    "board:104",
    "doc:200",
    "form:300",
  ]);
  const [q4, ops] = product.children;
  assert.deepEqual(keys(q4.children), ["board:101", "board:102", "doc:201"]);
  assert.deepEqual(ops.children, []);
  const launch = findNode([product], "board:103");
  assert.equal(launch.icon, "kanban", "the icon of the default view");
  assert.equal(findNode([product], "board:100").icon, "list");
  assert.equal(findNode([product], "doc:201").icon, "lock");
  assert.deepEqual(
    { spaceId: launch.spaceId, folderId: launch.folderId },
    { spaceId: "1", folderId: null },
  );
  assert.equal(allNodes([product, leadership]).length, 13);
});

test("Spaces open and folders closed until the user says otherwise", () => {
  const spaces = buildSpaces(WORKSPACES);
  const rows = visibleRows(spaces, {});
  assert.deepEqual(
    rows.map((row) => `${row.level}:${row.key}`),
    [
      "1:space:1",
      "2:folder:10",
      "2:folder:11",
      "2:board:100",
      "2:board:103",
      "2:board:104",
      "2:doc:200",
      "2:form:300",
      "1:space:2",
      "2:board:110",
    ],
  );
  const space = rows[0];
  assert.deepEqual(
    [space.expanded, space.setSize, space.posInSet, space.parentKey],
    [true, 2, 1, null],
  );
  assert.equal(rows[1].expanded, false);
  assert.equal(rows[3].expanded, null, "a List is a leaf");
  const open = visibleRows(spaces, { "folder:10": true, "space:2": false });
  assert.deepEqual(
    open.slice(1, 5).map((row) => `${row.level}:${row.key}`),
    ["2:folder:10", "3:board:101", "3:board:102", "3:doc:201"],
  );
  assert.equal(
    open.at(-1).key,
    "space:2",
    "a collapsed Space hides its content",
  );
  assert.equal(isExpanded({ "space:1": false }, spaces[0]), false);
});

test("the current item, its ancestors and its siblings", () => {
  const spaces = buildSpaces(WORKSPACES);
  const route = (name, params) => routeKey({ name, params });
  assert.equal(route("board", { boardId: "101", view: "list" }), "board:101");
  assert.equal(route("doc-editor", { docId: "200" }), "doc:200");
  assert.equal(route("form-builder", { formId: "300" }), "form:300");
  assert.equal(route("workspace-settings", { workspaceId: "2" }), "space:2");
  assert.equal(route("home", {}), null);
  assert.equal(routeKey(null), null);
  assert.deepEqual(ancestorKeys(spaces, "board:101"), ["space:1", "folder:10"]);
  assert.deepEqual(ancestorKeys(spaces, "doc:200"), ["space:1"]);
  assert.deepEqual(ancestorKeys(spaces, "space:1"), []);
  assert.deepEqual(ancestorKeys(spaces, "board:999"), []);
  const sprint = findNode(spaces, "board:101");
  assert.deepEqual(keys(siblingsOf(spaces, sprint)), [
    "board:101",
    "board:102",
  ]);
  assert.deepEqual(neighborOf(spaces, sprint), { beforeId: "102" });
  const bugs = findNode(spaces, "board:102");
  assert.deepEqual(neighborOf(spaces, bugs), { afterId: "101" });
  assert.deepEqual(keys(siblingsOf(spaces, spaces[1])), ["space:1", "space:2"]);
  assert.deepEqual(parseKey("folder:10"), { kind: "folder", id: "10" });
  assert.equal(parseKey("folder:x"), null);
  assert.equal(parseKey("item:1"), null);
});

test("Move to… offers every Space root and folder the user can edit", () => {
  const spaces = buildSpaces(WORKSPACES);
  const canEdit = (space) => space.record.my_access !== "viewer";
  const sprint = findNode(spaces, "board:101");
  assert.deepEqual(
    moveDestinations(spaces, sprint, canEdit).map((each) => each.label),
    ["Product", "Product / Ops"],
    "not where it is, not into a view-only Space",
  );
  const vision = findNode(spaces, "doc:200");
  assert.deepEqual(
    moveDestinations(spaces, vision, () => true).map((each) => each.value),
    ["1:10", "1:11", "2:"],
  );
});

test("favorites: toggled in order, unknown or hidden keys left out", () => {
  let favorites = toggleFavorite([], "board:100");
  favorites = toggleFavorite(favorites, "folder:10");
  favorites = toggleFavorite(favorites, "doc:999");
  assert.deepEqual(favorites, ["board:100", "folder:10", "doc:999"]);
  assert.deepEqual(toggleFavorite(favorites, "folder:10"), [
    "board:100",
    "doc:999",
  ]);
  const byKey = new Map(
    allNodes(buildSpaces(WORKSPACES)).map((node) => [node.key, node]),
  );
  assert.deepEqual(keys(favoriteNodes(favorites, byKey)), [
    "board:100",
    "folder:10",
  ]);
  assert.deepEqual(
    readFavorites(["board:1", "board:1", "nope", 4, "space:2"]),
    ["board:1", "space:2"],
  );
  assert.deepEqual(readFavorites({ "board:1": true }), []);
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `board:${i}`);
  assert.equal(readFavorites(many).length, MAX_ENTRIES);
  assert.deepEqual(
    readExpanded({ "space:1": false, "x:1": true, "folder:2": 1 }),
    {
      "space:1": false,
    },
  );
  assert.deepEqual(readExpanded(["space:1"]), {});
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test("favorites and expanded nodes are kept per user, failures change nothing", () => {
  const storage = memoryStorage({
    "worklane-favorites:7": JSON.stringify(["board:100"]),
    "worklane-sidebar-tree:7": "{not json",
  });
  const prefs = sidebarPrefs("7", storage);
  assert.deepEqual(prefs.favorites, ["board:100"]);
  assert.deepEqual(prefs.expanded, {}, "unreadable state reads as empty");
  prefs.setExpanded("folder:10", true);
  prefs.setFavorites(["doc:200"]);
  assert.equal(
    storage.data.get("worklane-sidebar-tree:7"),
    '{"folder:10":true}',
  );
  assert.equal(storage.data.get("worklane-favorites:7"), '["doc:200"]');
  assert.deepEqual(sidebarPrefs("8", storage).favorites, [], "another user");
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("full");
    },
  };
  const fallback = sidebarPrefs("7", broken);
  assert.deepEqual([fallback.favorites, fallback.expanded], [[], {}]);
  fallback.setExpanded("space:1", false);
  assert.deepEqual(fallback.expanded, { "space:1": false }, "kept in memory");
  assert.deepEqual(sidebarPrefs("7", null).favorites, []);
});
