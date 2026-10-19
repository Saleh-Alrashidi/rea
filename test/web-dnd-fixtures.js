/**
 * A loaded board for the move tests (`web-move-model.test.js`,
 * `web-list-dnd.test.js`): department statuses (one closed), assignees,
 * two board groups and tasks whose positions are not in board-group
 * order. Facility shows E, A (with A1, A2), C; psych dept B; No status D.
 */
import { roleColumns } from "../web/ui/board/column-roles.js";
import { listLayout } from "../web/ui/board/list-dnd-model.js";
import { defaultListPrefs, listGroups } from "../web/ui/board/list-model.js";
import { prepareColumns } from "../web/ui/board/values.js";

const statusSettings = JSON.stringify({
  labels: { 0: "facility", 1: "psych dept", 2: "Closed", 5: "" },
  labels_colors: { 0: "#ff7800", 1: "#1090e0", 2: "#008844", 5: "#c4c4c4" },
  labels_types: { 0: "custom", 1: "custom", 2: "closed" },
});

export const USERS = new Map([
  ["2", { id: "2", name: "Sam Lee" }],
  ["3", { id: "3", name: "Noa Levi" }],
]);

/** A task record as `decodeItem` makes it. */
export function task(
  id,
  name,
  { position, status = null, people = [], ...extra },
) {
  return {
    id,
    name,
    groupId: "open",
    parentId: null,
    position,
    updatesCount: 0,
    values: { status, people },
    texts: {},
    ...extra,
  };
}

/** A fresh board; `items` replaces the default tasks. */
export function moveBoard(items) {
  return {
    id: "1",
    columns: prepareColumns([
      { id: "name", title: "Name", type: "name", settings_str: "{}" },
      {
        id: "status",
        title: "Status",
        type: "status",
        role: "status",
        settings_str: statusSettings,
      },
      {
        id: "people",
        title: "Assignees",
        type: "people",
        role: "assignees",
        settings_str: "{}",
      },
    ]),
    groups: [
      { id: "open", title: "Open", color: "#579bfc", position: 0 },
      { id: "closed", title: "Closed", color: "#00c875", position: 1 },
    ],
    views: [],
    items: items ?? [
      task("1", "A", { position: 1024, status: 0, people: ["2"] }),
      task("2", "A1", { position: 2048, status: 2, parentId: "1" }),
      task("3", "A2", { position: 3072, status: 1, parentId: "1" }),
      task("4", "B", { position: 4096, status: 1, people: ["2", "3"] }),
      task("5", "C", { position: 5120, status: 0 }),
      task("6", "D", { position: 6144, groupId: "closed" }),
      task("7", "E", { position: 512, status: 0 }),
    ],
  };
}

/** The List view's layout of `board` with `prefs` overrides. */
export function layoutOf(board, prefs = {}) {
  const full = { ...defaultListPrefs(), ...prefs };
  const roles = roleColumns(board.columns);
  const { groups, keysOf } = listGroups(board, {
    prefs: full,
    roles,
    users: USERS,
  });
  return listLayout(board, { groups, keysOf });
}

/** Expanded tasks, as `prefs.expanded`. */
export const expanded = (...ids) => new Map(ids.map((id) => [id, true]));
