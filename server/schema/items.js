/**
 * Items and column values (part-1 API) plus `my_work`; updates are
 * `updates.js`. Items are reachable only through boards the caller can
 * access; item and value writes need editor access (SPEC-2 §1.2). `column-values.js` owns
 * every column value format. People values may name only users the caller
 * may see, and show the others as "Someone" (left out of `value`); a write
 * keeps the people the caller cannot see, and the store refuses to add
 * anyone who cannot open the board (SPEC-2 §6).
 *
 * Subitems (SPEC-5 §1.6): `create_subitem` goes through the store path of
 * `create_item`; `Item.subitems` and `subitems_count` read an index built
 * once per request (`perRequest`).
 *
 * Moves (SPEC-6 §1.3): `move_item` places an item between neighbors of
 * its board's manual order (`Item.position`, board-wide), changes its
 * parent, group and grouping values in one store change
 * (`store/moves.js`); `move_item_to_group` is the same store move with
 * only a group, to the end of that group. Refusals map as store results
 * do: `not_found` → NOT_FOUND, `invalid_parent` / `invalid_neighbor` →
 * BAD_USER_INPUT.
 */
import {
  HIDDEN_USER_NAME,
  boardAccess,
  requireBoard,
  requireItem,
} from "../access.js";
import {
  formatColumnValue,
  parseColumnValue,
  parseSimpleColumnValue,
  peopleIds,
} from "../column-values.js";
import { columnOf, groupOf } from "./boards.js";
import { describe, isPlainObject } from "../input.js";
import {
  accessibleBoards,
  badInput,
  lookupUser,
  notFound,
  parseJson,
  perRequest,
  pick,
  read,
  readIds,
  readLimit,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

const actor = (ctx) => ({ actorId: viewerOf(ctx).id });
/** People values may only name (and show) users the caller may see. */
const userOptions = (ctx) => ({
  getUser: (id) => lookupUser(ctx, id),
  hiddenName: HIDDEN_USER_NAME,
});

/**
 * `value` for `column` plus the people of `before` the caller cannot see:
 * they were never shown to the caller, so rewriting a value keeps them.
 */
function withHiddenPeople(ctx, { column, before, value }) {
  if (column.type !== "people") return value;
  const hidden = peopleIds(column, before).filter((id) => !lookupUser(ctx, id));
  if (hidden.length === 0) return value;
  return [...new Set([...(value ?? []), ...hidden])];
}

/** Turns a column-values parse result into a stored value or an error. */
function parsed(column, result) {
  return result.ok
    ? result.value
    : badInput(`Column ${column.id}: ${result.message}`);
}

/**
 * Parses a `column_values` JSON object into `[columnId, storedValue]`
 * pairs. Entries use the change_column_value formats; strings use the simple
 * format. Every entry is validated before the caller writes anything.
 */
function parseValueMap(ctx, { boardId, text, allowName, before = {} }) {
  const data = parseJson(text, "column_values");
  if (!isPlainObject(data)) badInput("column_values must be a JSON object");
  const options = userOptions(ctx);
  return Object.entries(data).map(([columnId, raw]) => {
    const column = ctx.store.getColumn(boardId, columnId);
    if (!column) badInput(`Unknown column ${describe(columnId)}`);
    if (column.type === "name" && !allowName) {
      badInput("Set the item name with item_name");
    }
    const simple = typeof raw === "string" || column.type === "name";
    const parse = simple ? parseSimpleColumnValue : parseColumnValue;
    const value = parsed(column, parse(column, raw, options));
    const kept = withHiddenPeople(ctx, {
      column,
      before: before[column.id],
      value,
    });
    return [column.id, kept];
  });
}

function columnValues(item, { ids }, ctx) {
  const { store } = ctx;
  const options = userOptions(ctx);
  return pick(store.listColumns(item.board_id), ids).map((column) => {
    const stored = column.type === "name" ? item.name : item.values[column.id];
    const { text, value } = formatColumnValue(column, stored, options);
    return { id: column.id, type: column.type, text, value };
  });
}

/** The item of a `board_id` + `item_id` mutation (editor on the board). */
function boardItem(ctx, args) {
  const board = requireBoard(ctx, args.board_id, "editor");
  const item = ctx.store.getItem(args.item_id);
  return item?.board_id === board.id ? item : notFound("Item", args.item_id);
}

/** Resolver for change_column_value / change_simple_column_value. */
const changeValue = (parse) => (_parent, args, ctx) => {
  const item = boardItem(ctx, args);
  const column = columnOf(ctx.store, item.board_id, args.column_id);
  const options = userOptions(ctx);
  const value = withHiddenPeople(ctx, {
    column,
    before: item.values[column.id],
    value: parsed(column, parse(column, args.value ?? null, options)),
  });
  const result = ctx.store.setColumnValue(
    item.id,
    column.id,
    value,
    actor(ctx),
  );
  return storeResult(result, () => notFound("Item", item.id));
};

/**
 * Creates an item from `item_name` and `column_values` (create_item and
 * create_subitem): `fields` = `{ boardId, groupId, parentId }`.
 */
function newItem(ctx, fields, args) {
  const name = readName(args.item_name, "Item name");
  const text = args.column_values ?? null;
  const request = { boardId: fields.boardId, text, allowName: false };
  const pairs = text === null ? [] : parseValueMap(ctx, request);
  const values = Object.fromEntries(pairs);
  const creatorId = viewerOf(ctx).id;
  const item = ctx.store.createItem({ ...fields, name, values, creatorId });
  return storeResult(item, () =>
    badInput("The board has no group for new items"),
  );
}

function createItem(_p, args, ctx) {
  const board = requireBoard(ctx, args.board_id, "editor");
  const groupId = args.group_id ?? null;
  if (groupId !== null) groupOf(ctx.store, board.id, groupId);
  return newItem(ctx, { boardId: board.id, groupId, parentId: null }, args);
}

/** A subitem in its parent's group; editor access on the parent's board. */
function createSubitem(_p, args, ctx) {
  const parent = requireItem(ctx, args.parent_item_id, "editor");
  const fields = {
    boardId: parent.board_id,
    groupId: null,
    parentId: parent.id,
  };
  return newItem(ctx, fields, args);
}

/**
 * Moves an item (editor access on its board): neighbors, parent, group
 * and `column_values` (the change_multiple_column_values formats) in one
 * store change.
 */
function moveItem(_p, args, ctx) {
  const item = requireItem(ctx, args.item_id, "editor");
  const parentId = args.parent_item_id ?? null;
  const detachParent = args.detach_parent === true;
  if (detachParent && parentId !== null) {
    badInput("Give parent_item_id or detach_parent, not both");
  }
  const groupId = args.group_id ?? null;
  if (groupId !== null) groupOf(ctx.store, item.board_id, groupId);
  const text = args.column_values ?? null;
  const request = { boardId: item.board_id, text, allowName: true };
  const before = item.values;
  const pairs = text === null ? [] : parseValueMap(ctx, { ...request, before });
  const move = {
    afterId: args.after_item_id ?? null,
    beforeId: args.before_item_id ?? null,
    parentId,
    detachParent,
    groupId,
    values: Object.fromEntries(pairs),
  };
  const result = ctx.store.moveItem(item.id, move, actor(ctx));
  return storeResult(result, () => notFound("Item", item.id));
}

/** Sets every value in one store change (all validated first). */
function changeMultipleValues(_p, args, ctx) {
  const item = boardItem(ctx, args);
  const request = { boardId: item.board_id, text: args.column_values };
  const before = item.values;
  const pairs = parseValueMap(ctx, { ...request, allowName: true, before });
  const values = Object.fromEntries(pairs);
  const result = ctx.store.setColumnValues(item.id, values, actor(ctx));
  return storeResult(result, () => notFound("Item", item.id));
}

// ---------------------------------------------------------------- my work

/** Active items assigned to the caller on accessible boards, in order. */
function assignedItems(ctx) {
  const viewer = viewerOf(ctx);
  const { store } = ctx;
  const entries = [];
  accessibleBoards(ctx).forEach((board, boardIndex) => {
    const columns = store.listColumns(board.id);
    const people = columns.filter((column) => column.type === "people");
    const date = columns.find((column) => column.type === "date");
    const { items } = store.listItems({
      boardId: board.id,
      limit: Number.MAX_SAFE_INTEGER,
    });
    items.forEach((item, itemIndex) => {
      const mine = people.some((column) =>
        peopleIds(column, item.values[column.id]).includes(viewer.id),
      );
      if (!mine || item.state !== "active") return;
      const due = date ? (item.values[date.id] ?? null) : null;
      entries.push({ item, due, boardIndex, itemIndex });
    });
  });
  const order = (a, b) =>
    (a.due === null) - (b.due === null) ||
    (a.due ?? "").localeCompare(b.due ?? "") ||
    a.boardIndex - b.boardIndex ||
    a.itemIndex - b.itemIndex;
  return entries.sort(order).map((entry) => entry.item);
}

/** Items assigned to the caller on accessible boards (SPEC-2 §3). */
function myWork(_p, { limit }, ctx) {
  const size = readLimit(limit);
  return perRequest(ctx, "my_work", () => assignedItems(ctx)).slice(0, size);
}

const Query = wrapAll(read, {
  items(_p, { ids }, ctx) {
    const viewer = viewerOf(ctx);
    return readIds(ids)
      .map((id) => ctx.store.getItem(id))
      .filter((item) => {
        const board = item && ctx.store.getBoard(item.board_id);
        return boardAccess(ctx.store, viewer, board) !== null;
      });
  },
  my_work: myWork,
});

const Mutation = wrapAll(write, {
  create_item: createItem,
  create_subitem: createSubitem,
  change_column_value: changeValue(parseColumnValue),
  change_simple_column_value: changeValue(parseSimpleColumnValue),
  change_multiple_column_values: changeMultipleValues,
  move_item: moveItem,
  move_item_to_group(_p, args, ctx) {
    const item = requireItem(ctx, args.item_id, "editor");
    const group = groupOf(ctx.store, item.board_id, args.group_id);
    const move = { groupId: group.id, toGroupEnd: true };
    const result = ctx.store.moveItem(item.id, move, actor(ctx));
    return storeResult(result, () => notFound("Item", item.id));
  },
  delete_item: (_p, { item_id }, ctx) =>
    ctx.store.deleteItem(requireItem(ctx, item_id, "editor").id, actor(ctx)),
});

const creator = (record, _a, ctx) => lookupUser(ctx, record.creator_id);

/** The direct subitems of `item`, in board order (one index per board). */
function subitemsOf(ctx, item) {
  const index = perRequest(ctx, `subitems\u0000${item.board_id}`, () => {
    const { items } = ctx.store.listItems({
      boardId: item.board_id,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const children = items.filter((each) => each.parent_id !== undefined);
    return Map.groupBy(children, (child) => child.parent_id);
  });
  return index.get(item.id) ?? [];
}

const Item = {
  board: (item, _a, { store }) => store.getBoard(item.board_id),
  group: (item, _a, { store }) => store.getGroup(item.board_id, item.group_id),
  creator,
  column_values: columnValues,
  parent_item_id: (item) => item.parent_id ?? null,
  parent_item: (item, _a, { store }) => store.getItem(item.parent_id ?? null),
  subitems: (item, { limit }, ctx) =>
    subitemsOf(ctx, item).slice(0, readLimit(limit)),
  subitems_count: (item, _a, ctx) => subitemsOf(ctx, item).length,
  url: (item, _a, { hostOrigin }) =>
    `${hostOrigin}/#/boards/${item.board_id}/items/${item.id}`,
};

export const definition = {
  types: {
    Query: "items(ids:[ID!]!):[Item!]! my_work(limit:Int=50):[Item!]!",
    Item: `id:ID! name:String! state:State! created_at:String!
      updated_at:String! board:Board! group:Group! creator:User
      column_values(ids:[String!]):[ColumnValue!]! url:String!
      parent_item_id:ID parent_item:Item subitems(limit:Int=100):[Item!]!
      subitems_count:Int! position:Float!`,
    ColumnValue: "id:String! type:ColumnType! text:String value:String",
    Mutation: `create_item(board_id:ID!,group_id:String,item_name:String!,column_values:String):Item!
      create_subitem(parent_item_id:ID!,item_name:String!,column_values:String):Item!
      change_column_value(board_id:ID!,item_id:ID!,column_id:String!,value:String!):Item!
      change_simple_column_value(board_id:ID!,item_id:ID!,column_id:String!,value:String):Item!
      change_multiple_column_values(board_id:ID!,item_id:ID!,column_values:String!):Item!
      move_item(item_id:ID!,before_item_id:ID,after_item_id:ID,parent_item_id:ID,detach_parent:Boolean=false,group_id:String,column_values:String):Item!
      move_item_to_group(item_id:ID!,group_id:String!):Item!
      delete_item(item_id:ID!):Item!`,
  },
  resolvers: { Query, Mutation, Item },
  extras: {
    "Item.url": { versions: { addedIn: "2026-04" } },
    "Query.my_work": { description: "Items assigned to the caller." },
    "Item.parent_item_id": {
      description: "The item this one is a subitem of; null at the top level.",
    },
    "Item.subitems": { description: "Direct subitems, in board order." },
    "Item.position": {
      description:
        "The item's place in its board's manual order (one order per board): sort by the view's grouping, then position, then id.",
    },
    "Mutation.move_item": {
      description:
        "Moves an item in one change. It lands immediately after after_item_id and/or immediately before before_item_id (items of the same board, not the item or its subitems; with both, after_item_id must come before before_item_id); the server picks the position, and without neighbors the item keeps it. parent_item_id makes it a subitem of that item, detach_parent a top-level item; group_id changes its group; column_values sets values as change_multiple_column_values does.",
    },
    "Mutation.move_item_to_group": {
      description:
        "Moves an item to the end of another group of its board (a move within its own group changes nothing).",
    },
  },
};
