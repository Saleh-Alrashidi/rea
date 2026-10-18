/**
 * "My work": the items assigned to the signed-in user (`my_work`, already
 * limited to accessible boards and ordered by date), decoded with each
 * board's columns, and the due-date buckets used by Home and My work.
 */

import { request } from "../../api.js";
import { addDays, todayString } from "../components/format.js";
import { hasRole } from "../components/permissions.js";
import { mutate } from "./board-data.js";
import {
  decodeItem,
  encodeValue,
  prepareColumns,
  statusOption,
} from "./values.js";

export const MY_WORK_QUERY = `query MyWork($limit: Int) {
  my_work(limit: $limit) {
    id name
    board { id name my_access columns { id title type settings_str } }
    group { id title color }
    column_values { id text value }
  }
}`;

export const MAX_MY_WORK = 50;
const WEEK_DAYS = 7;

/** Due-date buckets in display order. */
export const DUE_BUCKETS = Object.freeze([
  { key: "overdue", label: "Overdue", tone: "danger" },
  { key: "week", label: "This week", tone: "primary" },
  { key: "later", label: "Later", tone: "neutral" },
  { key: "none", label: "No date", tone: "neutral" },
]);

/**
 * The bucket of a due date relative to `today` ("YYYY-MM-DD"): before today
 * is overdue; today and the next six days are this week.
 */
export function dueBucket(due, today = todayString()) {
  if (!due) return "none";
  if (due < today) return "overdue";
  return due < addDays(today, WEEK_DAYS) ? "week" : "later";
}

/** Groups work items by `dueBucket`, keeping the API order inside each. */
export function groupByDue(items, today = todayString()) {
  const groups = new Map(DUE_BUCKETS.map((bucket) => [bucket.key, []]));
  for (const item of items) groups.get(dueBucket(item.due, today)).push(item);
  return DUE_BUCKETS.map((bucket) => ({
    ...bucket,
    items: groups.get(bucket.key),
  }));
}

function decodeWorkItem(raw, columnsByBoard) {
  const boardId = String(raw.board.id);
  if (!columnsByBoard.has(boardId)) {
    columnsByBoard.set(boardId, prepareColumns(raw.board.columns));
  }
  const columns = columnsByBoard.get(boardId);
  const item = decodeItem(raw, columns);
  const statusColumn =
    columns.find((column) => column.type === "status") ?? null;
  const dateColumn = columns.find((column) => column.type === "date") ?? null;
  const status = statusColumn ? (item.values[statusColumn.id] ?? null) : null;
  return {
    ...item,
    boardId,
    boardName: raw.board.name,
    canEdit: hasRole(raw.board.my_access, "editor"),
    group: raw.group,
    statusColumn,
    status,
    statusLabel: statusColumn
      ? (statusOption(statusColumn, status)?.label ?? "")
      : "",
    due: dateColumn ? (item.values[dateColumn.id] ?? null) : null,
  };
}

/**
 * Loads up to `limit` assigned items (1–50).
 * @returns {Promise<object[]>}
 */
export async function loadMyWork({ limit = MAX_MY_WORK } = {}) {
  const data = await request(MY_WORK_QUERY, { limit });
  const columnsByBoard = new Map();
  return data.my_work.map((raw) => decodeWorkItem(raw, columnsByBoard));
}

/** Sets the status of a work item (`index` null clears it). */
export function setWorkStatus(item, index) {
  return mutate("changeValue", {
    boardId: item.boardId,
    itemId: item.id,
    columnId: item.statusColumn.id,
    value: encodeValue(item.statusColumn, index),
  });
}
