/**
 * User actions: each applies an optimistic local change, renders, runs the
 * GraphQL mutation (or several, in order) and then re-fetches, so the
 * server stays the source of truth. Failures show a toast; the re-fetch
 * restores the real state.
 */

import { request } from "../../api.js";
import { formHash, viewHash } from "../../router.js";
import { confirmDialog, formDialog } from "../components/dialog.js";
import { BOARD_KINDS } from "../components/labels.js";
import { boardKindConfirmation } from "../components/share-model.js";
import { showError } from "../components/toast.js";
import { CREATE_MUTATIONS } from "../shell/create.js";
import { mutate } from "./board-data.js";
import { ITEM_VIEWS } from "./board-views.js";
import { descendantIds, groupDeletion } from "./list-model.js";
import { moveActions } from "./move-actions.js";
import { updateActions } from "./updates-actions.js";
import {
  ADDABLE_COLUMN_TYPES,
  GROUP_COLORS,
  displayText,
  encodeValue,
  valuePayload,
} from "./values.js";

const NEW_GROUP_NAME = "New group";

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The confirmation of deleting `group`: its items and, when some of their
 * subitems sit in other groups, how many go with them (`groupDeletion`
 * of the loaded items; a `truncated` board may hold more). Exported for
 * tests.
 */
export function groupDeletionMessage(group, gone, { truncated = false } = {}) {
  const items = plural(gone.inGroup, "item");
  const where = gone.otherGroups === 1 ? "another group" : "other groups";
  const message =
    gone.elsewhere === 0
      ? `“${group.title}” and its ${items} will be deleted.`
      : `“${group.title}”, its ${items} and their ${plural(gone.elsewhere, "subitem")} in ${where} will be deleted.`;
  return truncated
    ? `${message} Not every item of this board is loaded, so there may be more.`
    : message;
}

/** Shared helpers for every action group. */
function createKit(app) {
  const { state } = app;
  /**
   * Runs `calls` (`[mutation name, variables]`) in order after one
   * optimistic change and render, stopping at the first refusal (an
   * error toast; `rollback(count)` may put back the `count` calls that
   * went through), then re-fetches once. Resolves with the selected
   * records of the calls that went through. `regions` names the page
   * regions the optimistic change redraws (all by default); `refresh`
   * the re-fetch's options (`{ ifChanged: true }`: redraw only what
   * changed, for changes that touch the open task alone).
   */
  async function runAll(calls, options = {}) {
    const { optimistic, rollback, shell = false, regions } = options;
    state.pendingMutations += 1;
    state.mutationSeq += 1;
    if (optimistic) {
      optimistic();
      app.render(regions);
    }
    const results = [];
    try {
      for (const [name, variables] of calls) {
        results.push(await mutate(name, variables));
      }
    } catch (error) {
      showError(error);
      await rollback?.(results.length);
    } finally {
      state.pendingMutations -= 1;
      app.refresh(options.refresh);
      if (shell) app.refreshShell();
    }
    return results;
  }
  return {
    state,
    boardId: () => state.board.id,
    /** Redraws the page regions `parts` (all by default). */
    render: (parts) => app.render(parts),
    /** Re-fetches the board and the open task (`options`: `refresh`'s). */
    refresh: (options) => app.refresh(options),
    runAll: async (calls, options) => (await runAll(calls, options)).length,
    /** One mutation; resolves with its record, or null when refused. */
    async run(name, variables, options) {
      const [result = null] = await runAll([[name, variables]], options);
      return result;
    },
    /** The loaded copies of an item: its board row and the task's detail. */
    copiesOf(itemId) {
      const copies = [];
      const row = state.board?.items.find((item) => item.id === itemId);
      if (row) copies.push(row);
      const detail = state.card?.detail;
      if (detail?.id === itemId) copies.push(detail);
      return copies;
    },
    /** Encodes `{ columnId: uiValue }` as `create_item.column_values`. */
    encodeValues(values) {
      const entries = Object.entries(values).map(([columnId, value]) => {
        const column = state.board.columns.find(
          (entry) => entry.id === columnId,
        );
        return [columnId, valuePayload(column, value)];
      });
      return entries.length > 0
        ? JSON.stringify(Object.fromEntries(entries))
        : null;
    },
  };
}

/** Board rename, describe, kind and delete (the shell creates boards). */
function boardActions(app, kit) {
  const { state, run } = kit;
  return {
    renameBoard(name) {
      const id = kit.boardId();
      run(
        "updateBoard",
        { boardId: id, attribute: "name", value: name },
        {
          shell: true,
          optimistic: () => (state.board.name = name),
        },
      );
    },
    describeBoard(description) {
      run(
        "updateBoard",
        {
          boardId: kit.boardId(),
          attribute: "description",
          value: description,
        },
        { optimistic: () => (state.board.description = description) },
      );
    },
    /** Changes who can see the board, after a confirmation. */
    async setBoardKind(kind) {
      const board = state.board;
      if (!Object.hasOwn(BOARD_KINDS, kind) || board.kind === kind) return;
      const confirmed = await confirmDialog(boardKindConfirmation(board, kind));
      if (!confirmed) return;
      run(
        "setBoardKind",
        { id: board.id, kind },
        { shell: true, optimistic: () => (state.board.kind = kind) },
      );
    },
    async deleteBoard() {
      const board = state.board;
      const confirmed = await confirmDialog({
        title: "Delete board?",
        message: `“${board.name}” and its ${plural(board.items.length, "item")} will be deleted for everyone.`,
        confirmButton: "Delete board",
        danger: true,
      });
      if (!confirmed) return;
      const deleted = await run(
        "deleteBoard",
        { boardId: board.id },
        { shell: true },
      );
      if (deleted) app.onBoardDeleted(board.id);
    },
  };
}

/** Group create, rename, recolor and delete. */
function groupActions(app, kit) {
  const { state, run } = kit;
  return {
    async addGroup() {
      const { color } =
        GROUP_COLORS[state.board.groups.length % GROUP_COLORS.length];
      const group = await run("createGroup", {
        boardId: kit.boardId(),
        name: NEW_GROUP_NAME,
        color,
      });
      if (group?.id) app.focusAfterRender(`group-title:${group.id}`);
    },
    renameGroup(group, title) {
      run(
        "updateGroup",
        {
          boardId: kit.boardId(),
          groupId: group.id,
          attribute: "title",
          value: title,
        },
        { optimistic: () => (group.title = title) },
      );
    },
    recolorGroup(group, color) {
      run(
        "updateGroup",
        {
          boardId: kit.boardId(),
          groupId: group.id,
          attribute: "color",
          value: color,
        },
        { optimistic: () => (group.color = color) },
      );
    },
    /**
     * Deletes the group with its items and their subitems, wherever those
     * sit (the server cascades); the confirmation counts them all.
     */
    async deleteGroup(group) {
      const gone = groupDeletion(state.board.items, group.id);
      const confirmed = await confirmDialog({
        title: "Delete group?",
        message: groupDeletionMessage(group, gone, {
          truncated: state.board.truncated,
        }),
        confirmButton: "Delete group",
        danger: true,
      });
      if (!confirmed) return;
      for (const id of gone.ids) app.onItemDeleted(id);
      run(
        "deleteGroup",
        { boardId: kit.boardId(), groupId: group.id },
        {
          optimistic() {
            const board = state.board;
            board.groups = board.groups.filter(
              (entry) => entry.id !== group.id,
            );
            board.items = board.items.filter((item) => !gone.ids.has(item.id));
          },
        },
      );
    },
  };
}

/** Board views editors add (SPEC-5 §1.5): list, table or kanban. */
function viewActions(app, kit) {
  const { state, run } = kit;
  return {
    /** Adds a view of `type` with its default name and opens it. */
    async addView(type) {
      if (!Object.hasOwn(ITEM_VIEWS, type)) return;
      const boardId = kit.boardId();
      const view = await run(
        "createBoardView",
        { boardId, type },
        {
          optimistic() {
            const name = ITEM_VIEWS[type].label;
            state.board.views = [...state.board.views, { id: "", type, name }];
          },
        },
      );
      if (view?.id) app.navigate(viewHash(boardId, { view: type }));
    },
  };
}

/** Column creation. */
function columnActions(kit) {
  const { run } = kit;
  return {
    async addColumn() {
      const values = await formDialog({
        title: "Add column",
        submitLabel: "Add column",
        fields: [
          {
            name: "title",
            label: "Column title",
            required: true,
            autofocus: true,
          },
          {
            name: "type",
            label: "Column type",
            value: "status",
            options: ADDABLE_COLUMN_TYPES.map(({ type, label }) => ({
              value: type,
              label,
            })),
          },
        ],
      });
      if (!values?.title) return;
      if (!ADDABLE_COLUMN_TYPES.some(({ type }) => type === values.type))
        return;
      run("createColumn", {
        boardId: kit.boardId(),
        title: values.title,
        type: values.type,
      });
    },
  };
}

/** Item and subitem creation. */
function creationActions(kit) {
  const { run } = kit;
  return {
    /**
     * Creates an item (in `groupId`, or the first group when null) with
     * optional UI `values` by column ID; resolves with the new item's ID.
     */
    async createItem({ groupId, name, values = {} }) {
      const item = await run("createItem", {
        boardId: kit.boardId(),
        groupId,
        name,
        values: kit.encodeValues(values),
      });
      return item?.id ? String(item.id) : null;
    },
    /**
     * Creates a subitem of `parentId` in its parent's group (SPEC-5 §1.6)
     * with optional UI `values`; resolves with the new item's ID.
     */
    async createSubitem({ parentId, name, values = {} }) {
      const item = await run("createSubitem", {
        parentId,
        name,
        values: kit.encodeValues(values),
      });
      return item?.id ? String(item.id) : null;
    },
  };
}

/**
 * Item rename, values and delete (moves: `move-actions.js`, updates:
 * `updates-actions.js`).
 */
function itemActions(app, kit) {
  const { state, run } = kit;
  return {
    renameItem(item, name) {
      run(
        "renameItem",
        { boardId: kit.boardId(), itemId: item.id, value: name },
        {
          optimistic() {
            for (const copy of kit.copiesOf(item.id)) copy.name = name;
          },
        },
      );
    },
    /** Resolves to false when the server refused the change. */
    setValue(item, column, value) {
      const done = run(
        "changeValue",
        {
          boardId: kit.boardId(),
          itemId: item.id,
          columnId: column.id,
          value: encodeValue(column, value),
        },
        {
          optimistic() {
            const text = displayText(column, value, state.users);
            for (const copy of kit.copiesOf(item.id)) {
              copy.values[column.id] = value;
              copy.texts[column.id] = text;
            }
          },
        },
      );
      return done.then((result) => result !== null);
    },
    /** Deletes the item with its subitems (the server cascades). */
    async deleteItem(item) {
      const gone = descendantIds(state.board.items, item.id);
      const message =
        gone.size > 0
          ? `“${item.name}”, its ${plural(gone.size, "subitem")} and their updates will be deleted.`
          : `“${item.name}” and its updates will be deleted.`;
      const confirmed = await confirmDialog({
        title: "Delete item?",
        message,
        confirmButton: "Delete item",
        danger: true,
      });
      if (!confirmed) return;
      gone.add(item.id);
      for (const id of gone) app.onItemDeleted(id);
      run(
        "deleteItem",
        { itemId: item.id },
        {
          optimistic() {
            state.board.items = state.board.items.filter(
              (entry) => !gone.has(entry.id),
            );
          },
        },
      );
    },
  };
}

/** Changes and deletions of several tasks at once (the List bulk bar). */
function bulkActions(app, kit) {
  const { state } = kit;
  return {
    /** Sets `column` to `value` on every one of `items` (the bulk bar). */
    setValues(items, column, value) {
      const encoded = encodeValue(column, value);
      const calls = items.map((item) => [
        "changeValue",
        {
          boardId: kit.boardId(),
          itemId: item.id,
          columnId: column.id,
          value: encoded,
        },
      ]);
      const text = displayText(column, value, state.users);
      return kit.runAll(calls, {
        optimistic() {
          for (const copy of items.flatMap((item) => kit.copiesOf(item.id))) {
            copy.values[column.id] = value;
            copy.texts[column.id] = text;
          }
        },
      });
    },
    /**
     * Deletes `items` with their subitems after one confirmation; resolves
     * with whether they were deleted.
     */
    async deleteItems(selected) {
      // A selected subtask of a selected task goes with its parent.
      const gone = new Set();
      for (const item of selected) {
        for (const id of descendantIds(state.board.items, item.id))
          gone.add(id);
      }
      const items = selected.filter((item) => !gone.has(item.id));
      const own = plural(items.length, "task");
      const below =
        gone.size > 0 ? ` and their ${plural(gone.size, "subtask")}` : "";
      const confirmed = await confirmDialog({
        title: `Delete ${own}?`,
        message: `${own}${below} will be deleted, with their updates.`,
        confirmButton: "Delete",
        danger: true,
      });
      if (!confirmed) return false;
      for (const item of items) gone.add(item.id);
      for (const id of gone) app.onItemDeleted(id);
      const calls = items.map((item) => ["deleteItem", { itemId: item.id }]);
      const done = await kit.runAll(calls, {
        optimistic() {
          state.board.items = state.board.items.filter(
            (entry) => !gone.has(entry.id),
          );
        },
      });
      return done === calls.length;
    },
  };
}

/**
 * Form creation from the board's Forms view: the form belongs to this board,
 * so only its title is asked (the shell's create flow picks a board from
 * the user's workspaces, which may not include a board shared with them).
 */
function formActions(app, kit) {
  return {
    async createForm() {
      const board = kit.state.board;
      const values = await formDialog({
        title: "New form",
        submitLabel: "Create form",
        fields: [
          {
            name: "title",
            label: "Form title",
            required: true,
            autofocus: true,
            hint: `Each response becomes an item on “${board.name}”.`,
          },
        ],
      });
      if (!values?.title) return null;
      try {
        const data = await request(CREATE_MUTATIONS.form, {
          boardId: board.id,
          title: values.title,
        });
        const id = String(data.create_form.id);
        app.refreshShell();
        app.navigate(formHash(id));
        return id;
      } catch (error) {
        showError(error, "Couldn’t create the form");
        return null;
      }
    },
  };
}

/**
 * Creates the action set.
 * @param {{ state: object, render(parts?: string[]): void,
 *   refresh(options?: { ifChanged?: boolean }): void,
 *   refreshShell(): void, navigate(hash: string): void,
 *   focusAfterRender(focusKey: string): void,
 *   onItemDeleted(itemId: string): void,
 *   onBoardDeleted(boardId: string): void }} app
 */
export function createActions(app) {
  const kit = createKit(app);
  return {
    ...boardActions(app, kit),
    ...groupActions(app, kit),
    ...viewActions(app, kit),
    ...columnActions(kit),
    ...creationActions(kit),
    ...itemActions(app, kit),
    ...bulkActions(app, kit),
    ...moveActions(kit),
    ...updateActions(kit),
    ...formActions(app, kit),
  };
}
